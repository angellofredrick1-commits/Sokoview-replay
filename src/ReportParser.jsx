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
  typeof d === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  d >= DATE_MIN &&
  d <= DATE_MAX;

/** A dash where a source genuinely says nothing, rather than a misleading 0. */
const cell = (v) =>
  v == null ? <span className="text-gray-300">—</span> : Number(v).toLocaleString();

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

/**
 * The DSE report carries its prices in headed tables — "EQUITY DAILY PRICES",
 * "ETF DAILY PRICES" — whose rows run:
 *
 *   Co.  Opening  Closing  High  Low  Turnover  Deals  Volume  MktCap  Bids  Offers
 *
 * That closing price is the exchange's own number, and it is the one thing the
 * quote endpoint gets wrong for the ETFs, where it has been serving a frozen
 * value. So this table is read in preference to anything else in the email.
 *
 * Rows are validated rather than trusted: low <= open,close <= high must hold.
 * A row that fails is dropped instead of being guessed at, because a wrong
 * close here is worse than a missing one — it looks authoritative.
 */
const NUM_TOKEN = /-?\d[\d,]*(?:\.\d+)?/g;

function parseColumnTables(text) {
  const out = [];
  // Split on the table headings so each ticker is read in the context of the
  // table it belongs to; "Total" rows and page furniture fall outside.
  const parts = text.split(/((?:EQUITY|ETF|BOND|PREFERENCE)\s+DAILY\s+PRICES)/i);
  for (let p = 1; p < parts.length; p += 2) {
    const heading = parts[p].toUpperCase();
    const kind = /ETF/.test(heading) ? "etf" : /BOND/.test(heading) ? "bond" : "equity";
    const body = parts[p + 1] || "";
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      // A row starts with a ticker or company short name we recognise.
      const lead = lines[i].match(/^([A-Z][A-Z0-9&.\- ]*?)(?=[\s\t]+[-\d])/);
      if (!lead) continue;
      const name = lead[1].trim().toUpperCase();
      const sym = SYMBOLS[name];
      if (!sym || out.some((r) => r.symbol === sym)) continue;

      // Long rows wrap; keep pulling numbers from following lines until the
      // row is complete or the next ticker begins.
      let rest = lines[i].slice(lead[0].length);
      let j = i;
      let nums = rest.match(NUM_TOKEN) || [];
      while (nums.length < 7 && j + 1 < lines.length) {
        const nxt = lines[j + 1];
        if (/^([A-Z][A-Z0-9&.\- ]*?)(?=[\s\t]+[-\d])/.test(nxt) || /^TOTAL\b/i.test(nxt)) break;
        rest += " " + nxt;
        nums = rest.match(NUM_TOKEN) || [];
        j++;
      }
      if (nums.length < 7) continue;

      const [open, close, high, low, , , volume] = nums.map(num);
      if (low == null || high == null || close == null || low > high) continue;
      if (close < low || close > high) continue;
      if (open != null && (open < low || open > high)) continue;

      out.push({
        symbol: sym, name, kind,
        open, close, low, high,
        volume: volume == null ? 0 : volume,
      });
      i = j;
    }
  }
  return out;
}

function parseRankedPrices(text) {
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
    out.push({ symbol: sym, name, kind: /-ETF$/.test(sym) ? "etf" : "equity",
               open: null, close: null, low, high, volume: vol == null ? 0 : vol });
  }
  return out;
}

/**
 * Both shapes of the report are read and then merged. The column tables win
 * wherever they overlap, because they carry the closing price; the ranked
 * layout only ever supplied a range and a volume.
 */
function parsePrices(text) {
  const cols = parseColumnTables(text);
  const ranked = parseRankedPrices(text);
  const have = new Set(cols.map((r) => r.symbol));
  return [...cols, ...ranked.filter((r) => !have.has(r.symbol))];
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
   Alpha Capital daily digest

   The broker emails a summary of the DSE market report every session, and that
   summary states things the quote endpoint does not: a closing price for both
   ETFs — the one place the feed is frozen — plus a close for every stock in
   the gainers and losers lists, and turnover and volume for the top movers.
   ==========================================================================*/

const COMPANY_NAMES = {
  "TOL GASES": "TOL", "KENYA COMMERCIAL BANK": "KCB", "VODACOM TANZANIA": "VODA",
  "MAENDELEO BANK": "MBP", "CRDB BANK": "CRDB", "DAR ES SALAAM STOCK EXCHANGE": "DSE",
  "TANZANIA BREWERIES": "TBL", "TANZANIA PORTLAND CEMENT": "TPCC", "NMB BANK": "NMB",
  "TANZANIA CIGARETTE": "TCC", "MWALIMU COMMERCIAL BANK": "MCB",
  "EAST AFRICAN BREWERIES": "EABL", "TANGA CEMENT": "TCCL",
  "MKOMBOZI COMMERCIAL BANK": "MKCB", "DCB COMMERCIAL BANK": "DCB",
  "SWISSPORT TANZANIA": "SWIS", "NATIONAL INVESTMENT COMPANY": "NICO",
  "MUFINDI COMMUNITY BANK": "MUCOBA", "TANZANIA TEA PACKERS": "TTP",
  "PRECISION AIR": "PAL", "NATION MEDIA GROUP": "NMG", "JUBILEE HOLDINGS": "JHL",
  "AFRIPRISE": "AFRIPRISE", "JATU": "JATU", "SWALA": "SWALA",
  "UCHUMI COMMERCIAL BANK": "USL", "YETU MICROFINANCE": "YETU",
  "ITRUST EAC LARGE CAP": "IEACLC-ETF", "VERTEX INTERNATIONAL SECURITIES": "VERTEX-ETF",
};

function looksLikeAlpha(text) {
  const t = text.toUpperCase();
  return /ETF PERFORMANCE/.test(t) ||
         (/DEAR VALUED INVESTOR/.test(t) && /TOP GAINERS|MARKET TURNOVER/.test(t));
}

/** "as of 15th September 2026" — the body's date, never the subject line's. */
function parseAlphaDate(text) {
  const m = text.match(
    /as of\s+(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})/i);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2].toUpperCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}

/** "TZS 282.69 million" / "TZS 1.35 billion" -> plain shillings. */
function tzs(tok) {
  if (!tok) return null;
  const m = String(tok).match(/([\d,]+\.?\d*)\s*(billion|bn|million|mln|m\b)?/i);
  if (!m) return null;
  const n = num(m[1]);
  if (n == null) return null;
  const unit = (m[2] || "").toLowerCase();
  if (unit.startsWith("b")) return Math.round(n * 1e9);
  if (unit.startsWith("m")) return Math.round(n * 1e6);
  return Math.round(n);
}

/**
 * Resolve a company by NAME first and only then by the ticker in brackets.
 * The digest sometimes prints the wrong ticker — one edition labelled both
 * Tanzania Cigarette and Tanga Cement "TCCL" — and a silently wrong symbol
 * writes a real price onto the wrong company. Where the two disagree the name
 * wins and the disagreement is reported rather than hidden.
 */
function resolveAlpha(name, ticker) {
  const N = (name || "").toUpperCase();
  let byName = null;
  for (const k of Object.keys(COMPANY_NAMES).sort((a, b) => b.length - a.length)) {
    if (N.includes(k)) { byName = COMPANY_NAMES[k]; break; }
  }
  const T = (ticker || "").toUpperCase().replace(/\s+/g, "-").replace(/-+/g, "-");
  const byTicker = SYMBOLS[T] || (/(IEACLC|VIS)-?ETF/.test(T)
    ? (T.startsWith("IEACLC") ? "IEACLC-ETF" : "VERTEX-ETF") : null);
  return {
    symbol: byName || byTicker,
    conflict: byName && byTicker && byName !== byTicker ? { name, ticker, byName, byTicker } : null,
  };
}

const SIGN = (s) => (/[▼–−-]\s*$/.test(s) || /▼/.test(s) ? -1 : 1);

function parseAlpha(text) {
  const rows = [];
  const conflicts = [];
  // One row per symbol, filled in from whichever section mentions it. Only
  // real values are merged, so a later section that says nothing about volume
  // cannot blank out a volume an earlier one supplied.
  const put = (symbol, patch) => {
    const real = Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null));
    const at = rows.find((r) => r.symbol === symbol);
    if (at) Object.assign(at, real);
    else rows.push({ symbol, name: symbol, kind: /-ETF$/.test(symbol) ? "etf" : "equity",
                     open: null, close: null, low: null, high: null, volume: null,
                     turnover: null, pct: null, ...real });
  };

  // Gainers and losers: "TOL Gases Limited (TOL): ▲7.95% daily, ▲84.47% YTD – TZS 1,900"
  const GL = /^(.+?)\s*\(([A-Z][A-Z0-9 \-]*)\)\s*:\s*(▲|▼|\+|-)?\s*([\d.]+)%\s*daily[^–—\-]*[–—-]\s*TZS\s*([\d,]+)/gim;
  for (const m of text.matchAll(GL)) {
    const { symbol, conflict } = resolveAlpha(m[1], m[2]);
    if (conflict) conflicts.push(conflict);
    if (!symbol) continue;
    put(symbol, { name: m[1].trim(), close: num(m[5]),
                  pct: (m[3] === "▼" || m[3] === "-" ? -1 : 1) * (num(m[4]) ?? 0) });
  }

  // Top movers: "NMB Bank Plc (NMB): TZS 12.89 billion from 5,320,799 shares"
  // Some movers are written without a bracketed ticker at all — "AFRIPRISE: TZS
  // 79.9 million from 132,165 shares" — so the brackets are optional here.
  const MV = /^(.+?)\s*(?:\(([A-Z][A-Z0-9 \-]*)\))?\s*:\s*TZS\s*([\d,.]+\s*(?:billion|million|bn|mln)?)\s*from\s*([\d,]+)\s*shares/gim;
  for (const m of text.matchAll(MV)) {
    const { symbol, conflict } = resolveAlpha(m[1], m[2]);
    if (conflict) conflicts.push(conflict);
    if (!symbol) continue;
    put(symbol, { turnover: tzs(m[3]), volume: num(m[4]), name: m[1].trim() });
  }

  // ETF block: a name line, then Price / Turnover / Performance on their own lines.
  // Anchored on a line that IS the heading — the opening paragraph of every one
  // of these emails contains the words "and ETF performance based on the latest
  // daily market report", and splitting on that phrase lands before the gainers
  // list instead of on the block itself.
  const etfAt = text.search(/^[ \t]*ETF Performance[ \t]*$/im);
  const etfSection = etfAt >= 0 ? text.slice(etfAt) : null;
  if (etfSection) {
    const lines = etfSection.split("\n").map((l) => l.trim());
    let cur = null;
    for (const l of lines) {
      if (/^(Fixed Income|Bond|Should you|Warm regards)/i.test(l)) break;
      const head = l.match(/^(.*?ETF)\s*\(([^)]+)\)\s*$/i) || l.match(/^(.*?ETF)\s*$/i);
      if (head && !/^(Price|Turnover|Performance|Volume)/i.test(l)) {
        const { symbol, conflict } = resolveAlpha(head[1], head[2] || "");
        if (conflict) conflicts.push(conflict);
        cur = symbol;
        if (cur) put(cur, { name: head[1].trim(), kind: "etf" });
        continue;
      }
      if (!cur) continue;
      let m;
      if ((m = l.match(/^(?:Closing\s+)?Price\s*:\s*TZS\s*([\d,]+\.?\d*)/i)))
        put(cur, { close: num(m[1]) });
      else if ((m = l.match(/^Turnover\s*:\s*TZS\s*([\d,.]+\s*(?:billion|million|bn|mln)?)/i)))
        put(cur, { turnover: tzs(m[1]) });
      else if ((m = l.match(/^Volume\s*:\s*([\d,]+)/i)))
        put(cur, { volume: num(m[1]) });
      else if ((m = l.match(/^Performance\s*:\s*(▲|▼|\+|-)?\s*([\d.]+)%/i)))
        put(cur, { pct: (m[1] === "▼" || m[1] === "-" ? -1 : 1) * (num(m[2]) ?? 0) });
    }
  }

  // A weekly round-up quotes a week-over-week move, not a daily one. The close
  // is still that day's close, so it is kept; the percentage is not.
  const weekly = /\b(weekly|week-over-week|monthly)\b/i.test(text) &&
                 !/%\s*daily/i.test(text);
  if (weekly) rows.forEach((r) => { r.pct = null; });

  const seen = new Set();
  return {
    rows: rows.filter((r) => r.close != null || r.volume != null)
              .filter((r) => (seen.has(r.symbol) ? false : seen.add(r.symbol))),
    conflicts, weekly,
  };
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

  const mode = useMemo(() => {
    if (!text.trim()) return "dse";
    if (looksLikeUtt(text)) return "utt";
    if (looksLikeAlpha(text)) return "alpha";
    return "dse";
  }, [text]);

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    // An out-of-range date is reported separately from a missing one: the user
    // needs to see the nonsense value they produced, not a generic "no date".
    const withDate = (obj, raw) =>
      saneDate(raw) ? { ...obj, date: raw } : { ...obj, date: null, badDate: raw || null };
    if (mode === "utt") {
      const u = parseUtt(text);
      return withDate(
        { kind: "utt", rows: u.rows, divs: [], ambiguous: u.ambiguous, rawDate: u.rawDate },
        dateOverride || u.reportDate
      );
    }
    if (mode === "alpha") {
      const a = parseAlpha(text);
      return withDate(
        { kind: "alpha", rows: a.rows, divs: [], conflicts: a.conflicts, weekly: a.weekly },
        dateOverride || parseAlphaDate(text)
      );
    }
    return withDate(
      { kind: "dse", rows: parsePrices(text), divs: parseDividends(text) },
      dateOverride || parseReportDate(text)
    );
  }, [text, mode, dateOverride]);

  const csv = useMemo(() => {
    if (!parsed?.rows.length || !parsed.date) return "";
    if (parsed.kind === "utt") {
      const head = "symbol,trade_date,source,close,sale_price,repurchase_price,units_outstanding,fund_size";
      return [head, ...parsed.rows.map((r) =>
        `${r.symbol},${parsed.date},utt_amis,${r.nav},${r.sale},${r.repurchase},${r.units},${r.fundSize}`
      )].join("\n");
    }
    if (parsed.kind === "alpha") {
      const head = "symbol,trade_date,source,close,turnover,volume,traded";
      return [head, ...parsed.rows.map((r) =>
        `${r.symbol},${parsed.date},alpha_capital,${r.close ?? ""},${r.turnover ?? ""},` +
        `${r.volume ?? ""},${r.turnover != null ? r.turnover > 0 : ""}`)].join("\n");
    }
    const head = "symbol,trade_date,source,open,close,low,high,volume,traded";
    const body = parsed.rows.map((r) =>
      `${r.symbol},${parsed.date},dse_report,${r.open ?? ""},${r.close ?? ""},` +
      `${r.low},${r.high},${r.volume},${r.volume > 0}`);
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
    if (parsed.kind === "alpha") {
      const etfs = parsed.rows.filter((r) => r.kind === "etf").length;
      return [
        `-- Alpha Capital daily digest, ${parsed.date}`,
        `-- ${parsed.rows.length} instruments · ${etfs} ETF`,
        `-- Percentages are not stored: the trigger in migration 0003 derives`,
        `-- change from neighbouring rows, which is honest about gaps.`,
        ``,
        `insert into price_raw (symbol, trade_date, source, close, turnover, volume, traded) values`,
        parsed.rows.map((r) =>
          `  ('${r.symbol}', '${parsed.date}', 'alpha_capital', ${r.close ?? "null"}, ` +
          `${r.turnover ?? "null"}, ${r.volume ?? "null"}, ` +
          `${r.turnover != null ? r.turnover > 0 : "null"})`).join(",\n"),
        `on conflict (symbol, trade_date, source) do update set`,
        `  close = coalesce(excluded.close, price_raw.close),`,
        `  turnover = coalesce(excluded.turnover, price_raw.turnover),`,
        `  volume = coalesce(excluded.volume, price_raw.volume),`,
        `  traded = coalesce(excluded.traded, price_raw.traded);`,
      ].join("\n");
    }
    const withClose = parsed.rows.filter((r) => r.close != null).length;
    const lines = [
      `-- DSE market report ${parsed.date}`,
      `-- ${parsed.rows.length} instruments · ${parsed.rows.filter(r => r.volume > 0).length} traded`,
      `-- ${withClose} carry the exchange's own closing price`,
      ``,
      `insert into price_raw (symbol, trade_date, source, open, close, low, high, volume, traded) values`,
      parsed.rows.map((r) =>
        `  ('${r.symbol}', '${parsed.date}', 'dse_report', ${r.open ?? "null"}, ` +
        `${r.close ?? "null"}, ${r.low}, ${r.high}, ${r.volume}, ${r.volume > 0})`
      ).join(",\n"),
      `on conflict (symbol, trade_date, source) do update set`,
      // A re-paste of an older, closeless copy of the same report must not
      // erase a close already recorded for that day.
      `  open  = coalesce(excluded.open,  price_raw.open),`,
      `  close = coalesce(excluded.close, price_raw.close),`,
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
            Three formats are recognised automatically: a <strong className="text-neutral-900">DSE
            daily market report</strong>, the <strong className="text-neutral-900">Alpha Capital
            daily digest</strong> that arrives by email each evening, or the{" "}
            <strong className="text-neutral-900">UTT AMIS Net Asset Value</strong> table. Paste
            any of them and you get SQL to run in Supabase. Nothing is sent anywhere — it
            parses in your browser.
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
              <strong>That date is not real.</strong> It reads{" "}
              <code className="bg-white px-1 rounded font-bold">{parsed.badDate}</code>, which is
              outside {DATE_MIN.slice(0, 4)}–{DATE_MAX.slice(0, 4)}. Date fields commit each
              keystroke, so a year typed slowly lands as a year like 0002 before you finish.
              Nothing will be generated until it is fixed.
              <div className="mt-2 flex items-center gap-2">
                <input type="date" min={DATE_MIN} max={DATE_MAX} value={dateOverride}
                  onChange={(e) => setDateOverride(e.target.value)}
                  className="border border-red-300 rounded-lg px-2 py-1 text-[11px] font-bold" />
                <span className="text-[10.5px] text-red-700">set the real report date</span>
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

        {parsed?.kind === "alpha" && parsed.conflicts?.length > 0 && (
          <div className="border border-amber-300 bg-amber-50 rounded-xl p-3.5 flex gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-[11.5px] text-amber-800 leading-relaxed">
              <strong>The digest printed a ticker that does not match the company.</strong>{" "}
              The company name was used instead, which is the safer of the two — a wrong
              ticker writes a real price onto the wrong stock.
              <ul className="mt-1.5 space-y-0.5">
                {parsed.conflicts.map((c, i) => (
                  <li key={i} className="font-mono text-[10.5px]">
                    {c.name} → <strong>{c.byName}</strong> (email said {c.byTicker})
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {parsed?.kind === "alpha" && parsed.weekly && (
          <div className="border border-gray-200 bg-gray-50 rounded-xl p-3.5 flex gap-2.5">
            <Info className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mt-0.5" />
            <div className="text-[11.5px] text-gray-600 leading-relaxed">
              This looks like a <strong className="text-neutral-900">weekly round-up</strong>,
              so the percentages it quotes are week-over-week. The prices are still that
              day's closes and are kept; the percentages are dropped.
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
                <input type="date" min={DATE_MIN} max={DATE_MAX} value={parsed.date || ""}
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
                    { l: parsed.kind === "alpha" ? "As of" : "Report date", v: parsed.date },
                    { l: "Instruments",
                      v: parsed.rows.length +
                         (parsed.rows.some((r) => r.kind === "etf")
                           ? ` · ${parsed.rows.filter((r) => r.kind === "etf").length} ETF`
                           : "") },
                    { l: parsed.kind === "alpha" ? "With a close" : "With exchange close",
                      v: `${parsed.rows.filter((r) => r.close != null).length} of ${parsed.rows.length}` },
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
                      <th className="text-right px-3 py-2">Close</th>
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
                          {r.kind === "etf" && (
                            <span className="text-[8.5px] font-bold uppercase tracking-wide text-green-700 bg-green-500/10 border border-green-500/25 px-1.5 py-[1px] rounded-full ml-1.5">
                              etf
                            </span>
                          )}
                          {r.name !== r.symbol && r.kind !== "etf" && (
                            <span className="text-[9.5px] text-gray-400 ml-1.5">{r.name}</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-bold">
                          {cell(r.close)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{cell(r.low)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{cell(r.high)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">
                          {cell(r.volume)}
                        </td>
                        <td className="px-4 py-1.5 text-center">
                          {(r.volume ?? 0) > 0 || (r.turnover ?? 0) > 0
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
            {mode === "alpha" ? (
              <>
                <strong className="text-neutral-900">This is the only source that prices
                the ETFs.</strong> The quote endpoint has been serving one frozen value for
                IEACLC-ETF and VERTEX-ETF, which is why a replay across those days came back
                at exactly 0.0%. The digest also gives a close for every stock in its gainers
                and losers lists and turnover and volume for the top movers, so one paste
                covers most of the market. Rows are written as{" "}
                <code className="bg-gray-100 px-1 rounded">alpha_capital</code>, which ranks
                below the exchange's own report and above everything else.
              </>
            ) : mode === "utt" ? (
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
                The report's <strong className="text-neutral-900">EQUITY DAILY PRICES</strong> and
                <strong className="text-neutral-900"> ETF DAILY PRICES</strong> tables both carry
                an opening and closing price, and those are read here in preference to
                anything else in the email — the exchange's own close outranks the vendor
                feed, which is what matters for the two ETFs, where the feed has been stuck
                on one value. A row whose close falls outside its own low–high range is
                dropped rather than guessed at. Where only the older ranked layout is
                present, you still get range and volume and the close stays empty.
              </>
            )}
          </p>
        </div>
      </main>
    </div>
  );
}
