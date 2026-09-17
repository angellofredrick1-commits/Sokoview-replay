import React, { useState, useMemo } from "react";
import { Check, AlertTriangle, Copy, FileText, Info } from "lucide-react";

/* ============================================================================
   Parser — same logic as scripts/parse_dse_report.py, in the browser
   ==========================================================================*/

const SYMBOLS = {
  PRECISION: "PAL", NMG: "NMG", KCB: "KCB", TATEPA: "TTP", NICOL: "NICO",
  JHL: "JHL", MUCOBA: "MUCOBA", NMB: "NMB", AFRIPRISE: "AFRIPRISE",
  VODACOM: "VODA", CRDB: "CRDB", DCB: "DCB", SWALA: "SWALA", TBL: "TBL",
  TCC: "TCC", MCB: "MCB", TCCL: "TCCL", DSE: "DSE", TPCC: "TPCC",
  SWISS: "SWIS", TOL: "TOL", MKCB: "MKCB", JATU: "JATU", MBP: "MBP",
  EABL: "EABL", YETU: "YETU", USL: "USL",
  "VERTEX-ETF": "VERTEX-ETF", "IEACLC-ETF": "IEACLC-ETF",
  MAENDELEO: "MBP", MWALIMU: "MCB", MKOMBOZI: "MKCB", SWISSPORT: "SWIS",
  UCHUMI: "USL", JUBILEE: "JHL", "TANGA CEMENT": "TCCL",
};

const MONTHS = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE",
                "JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];

/**
 * A <input type="date"> commits partial input as you type: typing the year one
 * digit at a time can yield "0002-09-17" and the browser reports it as a valid
 * value. That silently produced 28 rows dated year 2, so every date is checked
 * against a sane window before it can reach the SQL.
 */
const DATE_MIN = "2000-01-01";
const DATE_MAX = "2100-12-31";
const saneDate = (d) =>
  typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= DATE_MIN && d <= DATE_MAX;

const prettyLong = (d) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB",
      { day: "numeric", month: "long", year: "numeric" }) : "";

function num(tok) {
  if (tok == null) return null;
  const t = String(tok).trim().replace(/,/g, "").replace(/^\+/, "");
  if (["", "-", "–", "—", "N/A"].includes(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseReportDate(text) {
  const m = text.match(
    /MARKET REPORT ON\s+(\d{1,2})\s*(?:ST|ND|RD|TH)?\s+([A-Z]+)\s+(\d{4})/i);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2].toUpperCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}

function parsePrices(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const out = [];
  const seenRank = new Set();

  for (let i = 0; i < lines.length; i++) {
    if (!/^\d{1,2}$/.test(lines[i])) continue;
    const rank = Number(lines[i]);
    if (rank < 1 || rank > 40 || seenRank.has(rank)) continue;

    const w = lines.slice(i + 1, i + 5);
    if (w.length < 4) continue;
    const name = w[0].trim().toUpperCase();
    const sym = SYMBOLS[name];
    if (!sym) continue;

    const low = num(w[1]), high = num(w[2]), vol = num(w[3]);
    if (low == null || high == null || low > high) continue;
    if (out.some((r) => r.symbol === sym)) continue; // side panel echo

    seenRank.add(rank);
    out.push({ symbol: sym, name, low, high, volume: vol == null ? 0 : vol });
  }
  return out;
}

function parseDividends(text) {
  const head = text.split(/MARKET REPORT ON/i)[0] || text;
  if (!/DIVIDEND/i.test(head)) return [];
  const out = [];

  let amt = head.match(/TZS\s*([\d,]+\.?\d*)\s*\)?\s*per share/i)
         || head.match(/TZS\s*([\d,]+\.?\d*)/i);
  const ex = head.match(
    /Ex-?Dividend\s*\n?\s*(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/i);

  let sym = null;
  for (const k of Object.keys(SYMBOLS)) {
    if (new RegExp(`\\b${k.replace(/[-]/g, "\\-")}\\b`).test(head.toUpperCase())) {
      sym = SYMBOLS[k]; break;
    }
  }
  if (amt && ex && sym) {
    const mi = MONTHS.indexOf(ex[2].toUpperCase());
    if (mi >= 0) {
      out.push({
        symbol: sym,
        ex_date: `${ex[3]}-${String(mi + 1).padStart(2, "0")}-${String(ex[1]).padStart(2, "0")}`,
        kind: "dividend",
        value: num(amt[1]),
      });
    }
  }
  return out;
}

/* ============================================================================
   UTT AMIS Net Asset Value table
   ==========================================================================*/

const FUNDS = {
  "UMOJA FUND": "UMOJA",
  "WEKEZA MAISHA FUND": "WEKEZA",
  "WEKEZA MAISHA": "WEKEZA",
  "WATOTO FUND": "WATOTO",
  "JIKIMU FUND": "JIKIMU",
  "LIQUID FUND": "LIQUID",
  "BOND FUND": "BOND",
};

function looksLikeUtt(text) {
  const t = text.toUpperCase();
  return /NET ASSET VALUE|NAV PER UNIT|SCHEME NAME|REPURCHASE PRICE/.test(t) ||
         Object.keys(FUNDS).some((f) => t.includes(f));
}

/**
 * UTT publishes DD-MM-YYYY. That is ambiguous against MM-DD-YYYY for the first
 * twelve days of a month, so we return both the parsed date and whether it was
 * ambiguous, and the UI asks the user to confirm rather than guessing silently.
 */
function parseUttDate(tok) {
  const m = String(tok).match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (!m) return null;
  const a = +m[1], b = +m[2], y = +m[3];
  if (a > 31 || b > 31) return null;
  const iso = `${y}-${String(b).padStart(2, "0")}-${String(a).padStart(2, "0")}`;
  return { iso, ambiguous: a <= 12 && b <= 12 && a !== b, raw: m[0] };
}

/**
 * Copying an HTML table can collapse every cell onto one line, and sometimes
 * strips the whitespace between them entirely — the Bond Fund row arrives as
 * "123.8623123.8623123.8623" with no separators.
 *
 * So rather than reading line by line, anchor on each scheme name and pull the
 * next five numbers out of the text that follows it. Every value in this table
 * carries exactly four decimals, which makes them unambiguous to extract even
 * when they are run together.
 */
const FOUR_DP = /\d[\d,]*\.\d{4}/g;
const DATE_RE = /\d{1,2}[-\/]\d{1,2}[-\/]\d{4}/;

function parseUtt(text) {
  const upper = text.toUpperCase();
  const found = [];

  // locate each scheme, longest name first so "WEKEZA MAISHA FUND" wins over
  // any shorter partial match
  Object.keys(FUNDS)
    .sort((a, b) => b.length - a.length)
    .forEach((name) => {
      const at = upper.indexOf(name);
      if (at >= 0 && !found.some((f) => f.sym === FUNDS[name])) {
        found.push({ sym: FUNDS[name], name, at, end: at + name.length });
      }
    });
  found.sort((a, b) => a.at - b.at);

  const out = [];
  let reportDate = null, ambiguous = false, rawDate = null;

  found.forEach((f, i) => {
    const stop = i + 1 < found.length ? found[i + 1].at : text.length;
    const chunk = text.slice(f.end, stop);

    FOUR_DP.lastIndex = 0;
    const nums = (chunk.match(FOUR_DP) || []).map((t) => Number(t.replace(/,/g, "")));
    if (nums.length < 5) return;

    const [fundSize, units, nav, sale, repurchase] = nums;
    if (!(nav > 0)) return;

    if (!reportDate) {
      const d = chunk.match(DATE_RE);
      if (d) {
        const parsed = parseUttDate(d[0]);
        if (parsed) { reportDate = parsed.iso; ambiguous = parsed.ambiguous; rawDate = parsed.raw; }
      }
    }

    out.push({
      symbol: f.sym,
      name: f.name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
      fundSize, units, nav, sale, repurchase,
      spread: sale > 0 ? (100 * (sale - repurchase)) / sale : 0,
    });
  });

  return { rows: out, reportDate, ambiguous, rawDate };
}

/* ============================================================================
   UI
   ==========================================================================*/

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <div className="w-7 h-7 bg-neutral-950 rounded-md flex items-end gap-[2.5px] px-1.5 pb-[5px] pt-1">
        <div className="w-[3.5px] h-[5px] rounded-sm bg-green-500" />
        <div className="w-[3.5px] h-[8px] rounded-sm bg-green-500" />
        <div className="w-[3.5px] h-[11px] rounded-sm bg-green-500" />
      </div>
      <span className="text-[15px] font-extrabold tracking-tight text-neutral-950">sokoview</span>
      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-green-600 bg-green-500/10 border border-green-500/25 px-2 py-[3px] rounded-full">
        report
      </span>
    </div>
  );
}

export default function ReportParser() {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState("");
  const [dateOverride, setDateOverride] = useState("");

  const mode = useMemo(() => (text.trim() && looksLikeUtt(text) ? "utt" : "dse"), [text]);

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    const withDate = (m) => {
      const raw = m.date;
      return { ...m, date: saneDate(raw) ? raw : null, badDate: raw && !saneDate(raw) ? raw : null };
    };
    if (mode === "utt") {
      const u = parseUtt(text);
      return withDate({ kind: "utt", date: dateOverride || u.reportDate,
               rows: u.rows, divs: [], ambiguous: u.ambiguous, rawDate: u.rawDate });
    }
    return withDate({ kind: "dse", date: dateOverride || parseReportDate(text),
             rows: parsePrices(text), divs: parseDividends(text) });
  }, [text, mode, dateOverride]);

  const csv = useMemo(() => {
    if (!parsed?.rows.length || !parsed.date) return "";
    if (parsed.kind === "utt") {
      const head = "symbol,trade_date,source,close,sale_price,repurchase_price,units_outstanding,fund_size";
      return [head, ...parsed.rows.map((r) =>
        `${r.symbol},${parsed.date},utt_amis,${r.nav},${r.sale},${r.repurchase},${r.units},${r.fundSize}`
      )].join("\n");
    }
    const head = "symbol,trade_date,source,low,high,volume,traded";
    const body = parsed.rows.map((r) =>
      `${r.symbol},${parsed.date},dse_report,${r.low},${r.high},${r.volume},${r.volume > 0}`);
    return [head, ...body].join("\n");
  }, [parsed]);

  const sql = useMemo(() => {
    if (!parsed?.rows.length || !parsed.date) return "";
    if (parsed.kind === "utt") {
      return [
        `-- UTT AMIS net asset values, ${parsed.date}`,
        `-- ${parsed.rows.length} schemes. close = NAV per unit; sale and repurchase`,
        `-- are what an investor actually pays and receives.`,
        ``,
        `insert into price_raw (symbol, trade_date, source, close, sale_price,`,
        `                       repurchase_price, units_outstanding, fund_size) values`,
        parsed.rows.map((r) =>
          `  ('${r.symbol}', '${parsed.date}', 'utt_amis', ${r.nav}, ${r.sale}, ` +
          `${r.repurchase}, ${r.units}, ${r.fundSize})`).join(",\n"),
        `on conflict (symbol, trade_date, source) do update set`,
        `  close = excluded.close, sale_price = excluded.sale_price,`,
        `  repurchase_price = excluded.repurchase_price,`,
        `  units_outstanding = excluded.units_outstanding, fund_size = excluded.fund_size;`,
      ].join("\n");
    }
    const lines = [
      `-- DSE market report ${parsed.date}`,
      `-- ${parsed.rows.length} instruments · ${parsed.rows.filter(r => r.volume > 0).length} traded`,
      ``,
      `insert into price_raw (symbol, trade_date, source, low, high, volume, traded) values`,
      parsed.rows.map((r) =>
        `  ('${r.symbol}', '${parsed.date}', 'dse_report', ${r.low}, ${r.high}, ${r.volume}, ${r.volume > 0})`
      ).join(",\n"),
      `on conflict (symbol, trade_date, source) do update set`,
      `  low = excluded.low, high = excluded.high,`,
      `  volume = excluded.volume, traded = excluded.traded;`,
    ];
    parsed.divs.forEach((d) => {
      lines.push(``, `insert into corporate_action (symbol, ex_date, kind, value, source_url, verified)`);
      lines.push(`values ('${d.symbol}', '${d.ex_date}', 'dividend', ${d.value},`);
      lines.push(`        'DSE daily market report ${parsed.date}', true)`);
      lines.push(`on conflict (symbol, ex_date, kind) do update set value = excluded.value;`);
    });
    return lines.join("\n");
  }, [parsed]);

  const copy = (what, val) => {
    navigator.clipboard?.writeText(val);
    setCopied(what);
    setTimeout(() => setCopied(""), 1600);
  };

  return (
    <div className="min-h-screen bg-white text-neutral-950 antialiased">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&display=swap');
        * { font-family: 'Sora', ui-sans-serif, system-ui, sans-serif; }
        .tabular-nums { font-variant-numeric: tabular-nums; }
      `}</style>

      <header className="border-b border-gray-200 px-5 py-3 sticky top-0 bg-white/95 backdrop-blur z-20">
        <Logo />
      </header>

      <main className="max-w-5xl mx-auto px-5 py-6 space-y-5">
        <div>
          <h1 className="text-[20px] font-extrabold tracking-tight mb-1">
            Paste a market report
          </h1>
          <p className="text-[12px] text-gray-500 leading-relaxed max-w-2xl">
            Two formats are recognised automatically: a <strong className="text-neutral-900">DSE
            daily market report</strong> email, or the <strong className="text-neutral-900">UTT
            AMIS Net Asset Value</strong> table. Paste either and you get SQL to run in
            Supabase. Nothing is sent anywhere — it parses in your browser.
          </p>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder="Paste the full email here, starting from ANNOUNCEMENTS or MARKET REPORT ON…"
          className="w-full border border-gray-300 rounded-xl px-3.5 py-3 text-[11.5px] font-mono outline-none focus:border-green-500 resize-y"
        />

        {parsed?.badDate && (
          <div className="border border-red-300 bg-red-50 rounded-xl p-3.5 flex gap-2.5">
            <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="text-[11.5px] text-red-800 leading-relaxed">
              <strong>That date can't be right.</strong>{" "}
              <code className="bg-white px-1 rounded">{parsed.badDate}</code> is outside
              2000–2100 — a date field commits a partial year while you type, so a stray
              digit lands as year 2. Nothing will be generated until it's fixed.
              <div className="mt-2 flex items-center gap-2">
                <input type="date" min={DATE_MIN} max={DATE_MAX} value=""
                  onChange={(e) => setDateOverride(e.target.value)}
                  className="border border-red-300 rounded-lg px-2 py-1 text-[11px] font-bold" />
                <span className="text-[10.5px] text-red-700">set the report date</span>
              </div>
            </div>
          </div>
        )}

        {parsed && !parsed.date && !parsed.badDate && (
          <div className="border border-amber-300 bg-amber-50 rounded-xl p-3.5 flex gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-[11.5px] text-amber-800 leading-relaxed">
              <strong>No date found.</strong>{" "}
              {mode === "utt"
                ? "Include the Date Valued column when you copy, or set the date here."
                : "The parser looks for a line like “MARKET REPORT ON 24TH AUGUST 2026”. Include the header when you copy."}
              <div className="mt-2 flex items-center gap-2">
                <input type="date" min={DATE_MIN} max={DATE_MAX} value={dateOverride}
                  onChange={(e) => setDateOverride(e.target.value)}
                  className="border border-amber-300 rounded-lg px-2 py-1 text-[11px] font-bold" />
                <span className="text-[10.5px] text-amber-700">set it manually</span>
              </div>
            </div>
          </div>
        )}

        {parsed?.kind === "utt" && parsed.ambiguous && (
          <div className="border border-amber-300 bg-amber-50 rounded-xl p-3.5 flex gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-[11.5px] text-amber-800 leading-relaxed">
              <strong>Check the date.</strong> UTT wrote{" "}
              <code className="bg-white px-1 rounded">{parsed.rawDate}</code>, which reads as{" "}
              <strong>{prettyLong(parsed.date)}</strong> in day-month order — but the same
              digits would be a different day in month-first order. Confirm before running
              the SQL: a wrong date silently overwrites another day.
              <div className="mt-2 flex items-center gap-2">
                <input type="date" min={DATE_MIN} max={DATE_MAX} value={parsed.date ?? ""}
                  onChange={(e) => setDateOverride(e.target.value)}
                  className="border border-amber-300 rounded-lg px-2 py-1 text-[11px] font-bold" />
                <span className="text-[10.5px] text-amber-700">adjust if wrong</span>
              </div>
            </div>
          </div>
        )}

        {parsed?.date && (
          <>
            <div className="grid sm:grid-cols-3 gap-3">
              {(parsed.kind === "utt"
                ? [
                    { l: "Valued", v: parsed.date },
                    { l: "Schemes", v: parsed.rows.length },
                    { l: "Combined size",
                      v: "TZS " + (parsed.rows.reduce((t, r) => t + r.fundSize, 0) / 1e12).toFixed(2) + "T" },
                  ]
                : [
                    { l: "Report date", v: parsed.date },
                    { l: "Instruments", v: parsed.rows.length },
                    { l: "Traded", v: parsed.rows.filter((r) => r.volume > 0).length },
                  ]
              ).map((s) => (
                <div key={s.l} className="border border-gray-200 rounded-xl p-3.5">
                  <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-gray-400 mb-1">
                    {s.l}
                  </div>
                  <div className="text-[19px] font-extrabold tabular-nums">{s.v}</div>
                </div>
              ))}
            </div>

            {parsed.divs.length > 0 && (
              <div className="border border-green-300 bg-green-50 rounded-xl p-3.5">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Check className="w-3.5 h-3.5 text-green-700" />
                  <span className="text-[11px] font-extrabold text-green-800">
                    Corporate action found
                  </span>
                </div>
                {parsed.divs.map((d, i) => (
                  <div key={i} className="text-[12px] text-green-900 tabular-nums">
                    <strong>{d.symbol}</strong> dividend of TZS {d.value} per share,
                    ex-date {d.ex_date}
                  </div>
                ))}
              </div>
            )}

            <div className="border border-gray-200 rounded-2xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between">
                <span className="text-[12px] font-extrabold">Parsed rows</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => copy("csv", csv)}
                    className="flex items-center gap-1.5 border border-gray-300 text-[10.5px] font-bold px-2.5 py-1.5 rounded-lg hover:border-neutral-900"
                  >
                    {copied === "csv" ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                    CSV
                  </button>
                  <button
                    onClick={() => copy("sql", sql)}
                    className="flex items-center gap-1.5 bg-neutral-950 text-white text-[10.5px] font-bold px-3 py-1.5 rounded-lg hover:bg-neutral-800"
                  >
                    {copied === "sql" ? <Check className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                    Copy SQL
                  </button>
                </div>
              </div>
              {parsed.kind === "utt" ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11.5px]">
                    <thead>
                      <tr className="text-[9px] font-bold uppercase tracking-wide text-gray-400 border-b border-gray-100">
                        <th className="text-left px-4 py-2">Scheme</th>
                        <th className="text-right px-3 py-2">NAV / unit</th>
                        <th className="text-right px-3 py-2">Buy at</th>
                        <th className="text-right px-3 py-2">Sell at</th>
                        <th className="text-right px-3 py-2">Round trip</th>
                        <th className="text-right px-4 py-2">Fund size</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {parsed.rows.map((r) => (
                        <tr key={r.symbol} className="hover:bg-gray-50">
                          <td className="px-4 py-2">
                            <span className="font-extrabold">{r.symbol}</span>
                            <span className="text-[9.5px] text-gray-400 ml-1.5">{r.name}</span>
                          </td>
                          <td className="px-3 py-2 text-right font-bold tabular-nums">
                            {r.nav.toLocaleString(undefined, { minimumFractionDigits: 4 })}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                            {r.sale.toLocaleString(undefined, { minimumFractionDigits: 4 })}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                            {r.repurchase.toLocaleString(undefined, { minimumFractionDigits: 4 })}
                          </td>
                          <td className={`px-3 py-2 text-right font-bold tabular-nums ${
                            r.spread >= 1.5 ? "text-red-600" : r.spread > 0 ? "text-amber-600" : "text-green-600"}`}>
                            {r.spread === 0 ? "free" : "−" + r.spread.toFixed(2) + "%"}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-gray-500">
                            {(r.fundSize / 1e9).toFixed(1)}B
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
              <div className="overflow-x-auto max-h-96">
                <table className="w-full text-[11.5px]">
                  <thead className="sticky top-0 bg-white">
                    <tr className="text-[9px] font-bold uppercase tracking-wide text-gray-400 border-b border-gray-100">
                      <th className="text-left px-4 py-2">Symbol</th>
                      <th className="text-right px-3 py-2">Low</th>
                      <th className="text-right px-3 py-2">High</th>
                      <th className="text-right px-3 py-2">Volume</th>
                      <th className="text-center px-4 py-2">Traded</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {parsed.rows.map((r) => (
                      <tr key={r.symbol} className="hover:bg-gray-50">
                        <td className="px-4 py-1.5">
                          <span className="font-extrabold">{r.symbol}</span>
                          {r.name !== r.symbol && (
                            <span className="text-[9.5px] text-gray-400 ml-1.5">{r.name}</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.low.toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.high.toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">
                          {r.volume.toLocaleString()}
                        </td>
                        <td className="px-4 py-1.5 text-center">
                          {r.volume > 0
                            ? <Check className="w-3.5 h-3.5 text-green-600 inline" />
                            : <span className="text-gray-300 text-[10px]">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )}
            </div>
          </>
        )}

        <div className="flex gap-2.5 text-[11px] text-gray-500 leading-relaxed border border-gray-200 rounded-xl p-3.5">
          <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-gray-400" />
          <p>
            {mode === "utt" ? (
              <>
                <strong className="text-neutral-900">Sale price is what you pay; repurchase
                is what you get back.</strong> On the balanced funds those differ — a unit
                bought and sold the same day loses 1% on Umoja and Watoto, 2% on Wekeza
                Maisha and Jikimu. Liquid and Bond have no spread. Storing all three means
                a replay can model the real cost of entering and leaving rather than
                assuming you transact at NAV.
              </>
            ) : (
              <>
                The report's main table has Low, High and Shares Traded — <strong className="text-neutral-900">no
                closing price</strong>. The email also interleaves the top-gainer panels into
                that table, so a close inferred by position would often be the day's high
                instead. Range and volume are what the report actually states, and volume is
                the thing your capture is missing. Closes still come from the vendor feed.
              </>
            )}
          </p>
        </div>
      </main>
    </div>
  );
}
