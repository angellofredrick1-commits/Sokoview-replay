#!/usr/bin/env python3
"""
Convert African Markets .xlsx exports into a CSV ready for Supabase import.

    python3 load_african_markets.py /path/to/xlsx/dir  [-o out.csv]

Design notes
------------
* Raw stays raw. Nothing is adjusted for corporate actions here — that is the
  job of the price_adjusted view, driven by the corporate_action table.
* Vendor company names are mapped to the symbols your capture already uses, so
  the two sources line up for reconciliation. Note NICOL -> NICO.
* change / pct_change are computed from the vendor's own consecutive closes.
  On split days these are mechanical, not market moves; the anomaly panel in
  the capture monitor flags anything above 18%.
* traded = volume > 0. Direct evidence, unlike the quote endpoint's timestamp.
"""

import argparse, csv, glob, os, sys
from collections import defaultdict

try:
    import openpyxl
except ImportError:
    sys.exit("pip install openpyxl")

# Vendor company name -> the symbol your capture uses.
SYMBOLS = {
    "AFRIPRISE INVESTMENT":          "AFRIPRISE",
    "CRDB BANK":                     "CRDB",
    "DCB COMMERCIAL BANK":           "DCB",
    "DAR ES SALAAM STOCK EXCHANGE":  "DSE",
    "EAST AFRICAN BREWERIES":        "EABL",
    "JATU":                          "JATU",
    "JUBILEE HOLDINGS":              "JHL",
    "KENYA AIRWAYS":                 "KA",
    "KCB GROUP":                     "KCB",
    "MAENDELEO BANK":                "MBP",
    "MKOMBOZI COMMERCIAL BANK":      "MKCB",
    "MUCOBA BANK":                   "MUCOBA",
    "MWALIMU COMMERCIAL BANK":       "MCB",
    "NICOL":                         "NICO",   # vendor says NICOL, capture says NICO
    "NMB BANK":                      "NMB",
    "NATION MEDIA GROUP":            "NMG",
    "PRECISION AIR SERVICES":        "PAL",
    "SWALA OIL AND GAS":             "SWALA",
    "SWISSPORT TANZANIA":            "SWIS",
    "TANZANIA BREWERIES":            "TBL",
    "TANGA CEMENT":                  "TCCL",
    "TANZANIA CIGARETTE":            "TCC",
    "TOL GASES":                     "TOL",
    "TANZANIA PORTLAND CEMENT":      "TPCC",
    "TANZANIA TEA PACKERS (TATEPA)": "TTP",
    "VODACOM TANZANIA":              "VODA",
    "YETU MICROFINANCE":             "YETU",
    "UCHUMI SUPERMARKETS":           "USL",
}

SOURCE = "african_markets"
COLUMNS = ["symbol", "trade_date", "source", "open", "high", "low", "close",
           "volume", "change", "pct_change", "traded"]


def num(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
        return f if f == f and f not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def read_file(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    out, unknown = [], set()
    for r in wb.worksheets[0].iter_rows(values_only=True):
        if not r or not r[1] or r[0] == "Company":
            continue
        company = str(r[0]).strip()
        sym = SYMBOLS.get(company.upper())
        if not sym:
            unknown.add(company)
            continue
        close = num(r[5])
        if close is None or close <= 0:
            continue
        out.append({
            "symbol": sym,
            "trade_date": str(r[1])[:10],
            "open": num(r[2]), "high": num(r[3]), "low": num(r[4]),
            "close": close, "volume": num(r[6]),
        })
    wb.close()
    return out, unknown


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("directory")
    ap.add_argument("-o", "--out", default="african_markets.csv")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.directory, "*.xlsx")))
    if not files:
        sys.exit(f"No .xlsx found in {args.directory}")

    # (symbol, date) -> row. Later files win, so re-exports overwrite cleanly
    # and duplicate exports of the same stock collapse to one row.
    rows, unknown, dupes = {}, set(), 0
    for f in files:
        recs, unk = read_file(f)
        unknown |= unk
        for rec in recs:
            k = (rec["symbol"], rec["trade_date"])
            if k in rows:
                dupes += 1
            rows[k] = rec

    # change / pct_change from consecutive closes per symbol
    by_symbol = defaultdict(list)
    for rec in rows.values():
        by_symbol[rec["symbol"]].append(rec)

    for sym, recs in by_symbol.items():
        recs.sort(key=lambda r: r["trade_date"])
        prev = None
        for rec in recs:
            if prev is not None and prev > 0:
                rec["change"] = round(rec["close"] - prev, 2)
                rec["pct_change"] = round(100 * (rec["close"] - prev) / prev, 4)
            else:
                rec["change"] = rec["pct_change"] = None
            prev = rec["close"]

    out_rows = sorted(rows.values(), key=lambda r: (r["symbol"], r["trade_date"]))

    with open(args.out, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS, extrasaction="ignore")
        w.writeheader()
        for rec in out_rows:
            v = rec.get("volume")
            w.writerow({
                **rec,
                "source": SOURCE,
                "volume": "" if v is None else int(v),
                "traded": "" if v is None else ("true" if v > 0 else "false"),
                "open": "" if rec.get("open") is None else rec["open"],
                "high": "" if rec.get("high") is None else rec["high"],
                "low":  "" if rec.get("low")  is None else rec["low"],
                "change": "" if rec.get("change") is None else rec["change"],
                "pct_change": "" if rec.get("pct_change") is None else rec["pct_change"],
            })

    syms = sorted(by_symbol)
    dates = sorted(r["trade_date"] for r in out_rows)
    print(f"files      : {len(files)}")
    print(f"symbols    : {len(syms)}")
    print(f"rows       : {len(out_rows):,}   ({dates[0]} -> {dates[-1]})")
    print(f"duplicates : {dupes:,} collapsed")
    print(f"written    : {args.out}  ({os.path.getsize(args.out)/1e6:.1f} MB)")
    print()
    print(f"  {'symbol':<10} {'rows':>6} {'from':<11} {'to':<11} {'traded%':>8}")
    thin = []
    for sym in syms:
        recs = by_symbol[sym]
        ds = [r["trade_date"] for r in recs]
        vols = [r["volume"] for r in recs if r["volume"] is not None]
        pctt = 100*sum(1 for v in vols if v > 0)/len(vols) if vols else 0
        flag = ""
        if len(recs) < 500:
            flag = "  <- short history"
            thin.append(sym)
        elif pctt < 10:
            flag = "  <- too illiquid to replay"
            thin.append(sym)
        print(f"  {sym:<10} {len(recs):>6} {ds[0]:<11} {ds[-1]:<11} {pctt:>7.1f}%{flag}")
    if thin:
        print(f"\n  Not suitable for the replayer: {' '.join(thin)}")
    if unknown:
        print("\nUNMAPPED COMPANIES — add to SYMBOLS and re-run:")
        for u in sorted(unknown):
            print(f"  {u!r}")

    big = [r for r in out_rows if r.get("pct_change") and abs(r["pct_change"]) >= 18]
    if big:
        print(f"\n{len(big)} moves >= 18% — likely corporate actions, record them in corporate_action:")
        for r in sorted(big, key=lambda x: -abs(x["pct_change"]))[:15]:
            print(f"  {r['symbol']:<10} {r['trade_date']}  {r['pct_change']:+8.1f}%  "
                  f"close {r['close']:>8,.0f}  vol {int(r['volume'] or 0):>10,}")


if __name__ == "__main__":
    main()
