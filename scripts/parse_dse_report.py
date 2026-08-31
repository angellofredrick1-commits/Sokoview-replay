#!/usr/bin/env python3
"""
Parse a DSE daily market report email into rows for price_raw + corporate_action.

    python3 parse_dse_report.py report.txt            # print SQL
    python3 parse_dse_report.py report.txt --csv out.csv

What the report actually gives you
----------------------------------
The MARKET PRICE AND VOLUME table has Security / Low / High / Shares Traded.
There is NO closing price column — so this source supplies the day's range and,
crucially, VOLUME, which the Sokoview quote endpoint does not return after close.

Closing prices for a handful of stocks appear in TOP GAINER / LOSER / MOVER, and
those are picked up where present.

The email body is copy-pasted out of a multi-column HTML table, so the side
panels (top gainer, indices) get interleaved into the main list. The parser
anchors on the numbered rows and ignores anything that does not fit the shape.
"""

import argparse, csv, re, sys
from datetime import date

# Report uses display names; map to the symbols already in your database.
SYMBOLS = {
    "PRECISION": "PAL",   "NMG": "NMG",        "KCB": "KCB",
    "TATEPA": "TTP",      "NICOL": "NICO",     "JHL": "JHL",
    "MUCOBA": "MUCOBA",   "NMB": "NMB",        "AFRIPRISE": "AFRIPRISE",
    "VODACOM": "VODA",    "CRDB": "CRDB",      "DCB": "DCB",
    "SWALA": "SWALA",     "TBL": "TBL",        "TCC": "TCC",
    "MCB": "MCB",         "TCCL": "TCCL",      "DSE": "DSE",
    "TPCC": "TPCC",       "SWISS": "SWIS",     "TOL": "TOL",
    "MKCB": "MKCB",       "JATU": "JATU",      "MBP": "MBP",
    "EABL": "EABL",       "YETU": "YETU",      "USL": "USL",
    "VERTEX-ETF": "VERTEX-ETF", "IEACLC-ETF": "IEACLC-ETF",
    "MAENDELEO": "MBP",   "MWALIMU": "MCB",    "MKOMBOZI": "MKCB",
    "SWISSPORT": "SWIS",  "UCHUMI": "USL",     "JUBILEE": "JHL",
}

MONTHS = {m: i + 1 for i, m in enumerate(
    ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE",
     "JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"])}


def num(tok):
    """'1,970' -> 1970.0 ; '-' -> None"""
    if tok is None:
        return None
    t = tok.strip().replace(",", "").replace("+", "")
    if t in ("", "-", "–", "—", "N/A"):
        return None
    try:
        return float(t)
    except ValueError:
        return None


def parse_report_date(text):
    m = re.search(r"MARKET REPORT ON\s+(\d{1,2})\s*(?:ST|ND|RD|TH)?\s+([A-Z]+)\s+(\d{4})",
                  text, re.I)
    if not m:
        return None
    d, mon, y = m.group(1), m.group(2).upper(), m.group(3)
    if mon not in MONTHS:
        return None
    return date(int(y), MONTHS[mon], int(d)).isoformat()


def parse_prices(text):
    """
    Anchor on the numbered rows: a line that is just an integer 1-40, followed by
    a security name, then low / high / volume. Side-panel rows break the pattern
    and are skipped rather than guessed at.
    """
    lines = [l.strip() for l in text.splitlines()]
    lines = [l for l in lines if l != ""]
    out, seen = [], set()

    for i, line in enumerate(lines):
        if not re.fullmatch(r"\d{1,2}", line):
            continue
        rank = int(line)
        if not 1 <= rank <= 40 or rank in seen:
            continue
        # need name + 3 numeric-ish fields after the rank
        window = lines[i + 1: i + 5]
        if len(window) < 4:
            continue
        name = window[0].strip().upper()
        sym = SYMBOLS.get(name)
        if not sym:
            continue
        low, high, vol = num(window[1]), num(window[2]), num(window[3])
        # low/high must both be present and ordered; volume may legitimately be '-'
        if low is None or high is None or low > high:
            continue
        if any(r["symbol"] == sym for r in out):
            continue    # side panel echoed a symbol already captured
        seen.add(rank)
        out.append({"symbol": sym, "low": low, "high": high,
                    "volume": 0 if vol is None else int(vol)})
    return out


def parse_closes(text):
    """
    Only TOP GAINER / LOSER / MOVER carry a Price column, and only for a handful
    of stocks. Everything else in the report has no published close.

    This must be anchored to those panels. Matching loosely across the whole
    email picks up main-table rows (name / low / high) and mistakes the HIGH for
    a close — which silently produces wrong prices for most of the market.
    """
    closes = {}
    panels = re.split(r"TOP\s+(?:GAINER|LOSER|MOVER)", text, flags=re.I)[1:]
    for panel in panels:
        # stop at the next section header so we do not run into the indices
        panel = re.split(r"(?:MAJOR|SECTOR)\s+INDICES", panel, flags=re.I)[0]
        for m in re.finditer(
            r"\n\s*([A-Z][A-Z\-]{1,12})\s*\n\s*([\d,]+)\s*\n\s*([\d,]+)", panel):
            name, vol, price = m.group(1).upper(), num(m.group(2)), num(m.group(3))
            sym = SYMBOLS.get(name)
            if sym and price:
                closes[sym] = {"close": price, "volume": int(vol) if vol else None}
    return closes


def parse_dividends(text):
    """Pull dividend announcements: amount per share plus the ex-date."""
    out = []
    head = re.split(r"MARKET REPORT ON", text, flags=re.I)[0]
    blocks = re.split(r"(?=^[A-Z][A-Z .&\-]{4,}\s*(?:PLC|LTD|LIMITED)?\s*[-–]\s*)",
                      head, flags=re.M) or [head]
    for block in blocks:
        if "DIVIDEND" not in block.upper():
            continue
        amt = re.search(r"TZS\s*([\d,]+\.?\d*)\s*\)?\s*per share", block, re.I)
        if not amt:
            amt = re.search(r"TZS\s*([\d,]+\.?\d*)", block, re.I)
        ex = re.search(
            r"Ex-?Dividend\s*\n?\s*(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})",
            block, re.I)
        name = None
        for k in SYMBOLS:
            if re.search(rf"\b{re.escape(k)}\b", block.upper()):
                name = k
                break
        if amt and ex and name:
            mon = ex.group(2).upper()
            if mon in MONTHS:
                out.append({
                    "symbol": SYMBOLS[name],
                    "ex_date": date(int(ex.group(3)), MONTHS[mon], int(ex.group(1))).isoformat(),
                    "kind": "dividend",
                    "value": num(amt.group(1)),
                })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--csv")
    ap.add_argument("--date", help="override if the header is missing")
    args = ap.parse_args()

    text = open(args.file, encoding="utf-8", errors="replace").read()
    report_date = args.date or parse_report_date(text)
    if not report_date:
        sys.exit("Could not find the report date. Pass --date YYYY-MM-DD.")

    rows = parse_prices(text)
    closes = parse_closes(text)
    divs = parse_dividends(text)

    # The report's main table has NO close column, and the email interleaves the
    # side panels into it, so any close inferred by position is a guess. A wrong
    # close is worse than no close: it silently corrupts every return computed
    # from it. Store range + volume, which is what the report actually states,
    # and let price_daily fall back to another source for the close.
    for r in rows:
        r["close"] = None
        r["traded"] = r["volume"] > 0
    if closes:
        print(f"-- note: {len(closes)} closes appear in the gainer/loser panels "
              f"but are not emitted; parse them by hand if you need them",
              file=sys.stderr)

    print(f"-- DSE market report {report_date}", file=sys.stderr)
    print(f"-- {len(rows)} instruments, {sum(1 for r in rows if r['traded'])} traded, "
          f"{len(closes)} with a published close, {len(divs)} dividend(s)", file=sys.stderr)

    if args.csv:
        with open(args.csv, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=[
                "symbol", "trade_date", "source", "high", "low", "close", "volume", "traded"])
            w.writeheader()
            for r in rows:
                w.writerow({
                    "symbol": r["symbol"], "trade_date": report_date, "source": "dse_report",
                    "high": r["high"], "low": r["low"],
                    # No published close for most rows. Use the high as a placeholder
                    # ONLY if you accept that limitation; otherwise leave blank and
                    # let price_daily fall back to another source.
                    "close": r["close"] if r["close"] is not None else "",
                    "volume": r["volume"], "traded": str(r["traded"]).lower(),
                })
        print(f"wrote {args.csv}", file=sys.stderr)
        return

    print(f"-- volume + range from the exchange's own report")
    for r in rows:
        close = r["close"] if r["close"] is not None else "null"
        print(f"insert into price_raw (symbol, trade_date, source, low, high, close, volume, traded)")
        print(f"  values ('{r['symbol']}', '{report_date}', 'dse_report', "
              f"{r['low']}, {r['high']}, {close}, {r['volume']}, {str(r['traded']).lower()})")
        print(f"  on conflict (symbol, trade_date, source) do update set "
              f"low = excluded.low, high = excluded.high, volume = excluded.volume, "
              f"traded = excluded.traded;")
    for d in divs:
        print(f"\ninsert into corporate_action (symbol, ex_date, kind, value, source_url, verified)")
        print(f"  values ('{d['symbol']}', '{d['ex_date']}', 'dividend', {d['value']}, "
              f"'DSE daily market report {report_date}', true)")
        print(f"  on conflict (symbol, ex_date, kind) do update set value = excluded.value;")


if __name__ == "__main__":
    main()
