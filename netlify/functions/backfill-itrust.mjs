/**
 * Backfill iTrust Finance scheme history into price_raw.
 *
 *   GET /.netlify/functions/backfill-itrust?token=YOUR_TOKEN
 *   GET /.netlify/functions/backfill-itrust?token=…&fund=iGrowth   (one scheme)
 *   GET /.netlify/functions/backfill-itrust?token=…&since=2026-01-01
 *   GET /.netlify/functions/backfill-itrust?token=…&dry=1          (parse only)
 *
 * How the source works
 * --------------------
 * Unlike UTT, iTrust just serves JSON:
 *
 *   GET https://api.itrust.co.tz/api/fund/iGrowth
 *   [ { date: "9/18/2026", netAssetValue: …, outStandingUnits: …,
 *       navPerUnit: …, salePricePerUnit: …, repurchasePricePerUnit: … }, … ]
 *
 * One request per scheme returns its whole history. No session, no CSRF, no
 * paging.
 */

const ITRUST_BASE = "https://api.itrust.co.tz/api/fund";

// API path segment -> the symbol used in our instrument table.
// iEACLC-ETF is already an instrument, carrying the market close from the
// exchange report. What arrives here is the manager's NAV for the same days,
// which is a different number and is stored as such — see migration 0008.
export const FUNDS = [
  { id: "iCash",      symbol: "ICASH" },
  { id: "iGrowth",    symbol: "IGROWTH" },
  { id: "iSave",      symbol: "ISAVE" },
  { id: "iIncome",    symbol: "IINCOME" },
  { id: "Imaan",      symbol: "IMAAN" },
  { id: "iDollar",    symbol: "IDOLLAR" },
  { id: "iEACLC-ETF", symbol: "IEACLC-ETF" },
];

const json = (body, statusCode = 200) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body, null, 2),
});

function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * iTrust writes M/D/YYYY — "9/18/2026" is 18 September. Within the first twelve
 * days of a month that is indistinguishable from D/M/YYYY, so rather than
 * trusting the convention, each fund's own history is asked to prove it: a
 * single date whose first field exceeds 12 settles the whole feed.
 *
 * If a feed offers no such date, or offers evidence both ways, that fund is
 * refused rather than written. A silently transposed date is the one error
 * that cannot be spotted later — 3/4/2026 looks perfectly reasonable on either
 * reading, and it would sit in the middle of a replay skewing a return with
 * nothing to show for it.
 */
function detectDateOrder(raws) {
  let monthFirst = 0, dayFirst = 0;
  for (const raw of raws) {
    const m = String(raw ?? "").match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (!m) continue;
    const a = +m[1], b = +m[2];
    if (b > 12 && a <= 12) monthFirst += 1;
    if (a > 12 && b <= 12) dayFirst += 1;
  }
  if (monthFirst && !dayFirst) return { order: "month-first", monthFirst, dayFirst };
  if (dayFirst && !monthFirst) return { order: "day-first", monthFirst, dayFirst };
  return { order: null, monthFirst, dayFirst };
}

function toIso(raw, order) {
  const m = String(raw ?? "").match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!m) return null;
  const a = +m[1], b = +m[2], y = +m[3];
  const mo = order === "month-first" ? a : b;
  const d  = order === "month-first" ? b : a;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (y < 2000 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export async function fetchFund(id) {
  const res = await fetch(`${ITRUST_BASE}/${encodeURIComponent(id)}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "SokoviewDataCapture/1.0 (+https://sokoview.co.tz)",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`iTrust ${id}: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`iTrust ${id}: expected an array`);
  return body;
}

export async function upsert(rows, cfg) {
  if (!rows.length) return 0;
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const res = await fetch(
      `${cfg.url.replace(/\/$/, "")}/rest/v1/price_raw?on_conflict=symbol,trade_date,source`,
      {
        method: "POST",
        headers: {
          apikey: cfg.key, Authorization: `Bearer ${cfg.key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(slice),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Supabase ${res.status}: ${detail.slice(0, 300)}`);
    }
    written += slice.length;
  }
  return written;
}

/** Shared with the nightly capture so both write identical rows. */
export function buildRows(raw, symbol, { since = null } = {}) {
  const probe = detectDateOrder(raw.map((r) => r?.date));
  if (!probe.order) {
    return {
      rows: [], skipped: raw.length, duplicates: 0,
      refused: probe.monthFirst && probe.dayFirst
        ? "dates read both ways in the same feed"
        : "no date in this feed proves which field is the month",
    };
  }

  const parsed = [];
  let skipped = 0;
  for (const r of raw) {
    const iso = toIso(r?.date, probe.order);
    const nav = num(r?.navPerUnit);
    if (!iso || nav == null || nav <= 0) { skipped += 1; continue; }
    if (since && iso < since) continue;
    parsed.push({
      symbol,
      trade_date: iso,
      source: "itrust",
      close: nav,
      sale_price: num(r?.salePricePerUnit),
      repurchase_price: num(r?.repurchasePricePerUnit),
      units_outstanding: num(r?.outStandingUnits),
      fund_size: num(r?.netAssetValue),
    });
  }

  // The API does not promise an order — iTrust's own client sorts it before
  // use — so a repeated date is resolved by picking the LATEST valuation for
  // that day rather than whichever happened to arrive first.
  parsed.sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0));
  const byDate = {};
  parsed.forEach((r) => { byDate[r.trade_date] = r; });
  const rows = Object.values(byDate).sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));

  return { rows, skipped, duplicates: parsed.length - rows.length, order: probe.order };
}

export const handler = async (event) => {
  const expected = process.env.CAPTURE_TRIGGER_TOKEN;
  if (!expected) return json({ error: "Manual trigger disabled" }, 404);
  if (event.queryStringParameters?.token !== expected) return json({ error: "Bad token" }, 401);

  const dry = event.queryStringParameters?.dry === "1";
  const cfg = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY };
  if (!dry && (!cfg.url || !cfg.key)) return json({ error: "Supabase env vars not set" }, 500);

  const only = event.queryStringParameters?.fund;
  const since = event.queryStringParameters?.since || null;
  const targets = only
    ? FUNDS.filter((f) => f.id.toLowerCase() === only.toLowerCase() ||
                          f.symbol.toLowerCase() === only.toLowerCase())
    : FUNDS;
  if (!targets.length) {
    return json({ error: `Unknown fund '${only}'`, known: FUNDS.map((f) => f.id) }, 400);
  }

  const summary = [];
  const refused = [];

  for (const f of targets) {
    try {
      const raw = await fetchFund(f.id);
      const built = buildRows(raw, f.symbol, { since });

      if (built.refused) {
        refused.push({ symbol: f.symbol, returned: raw.length, reason: built.refused });
        continue;
      }

      const written = dry ? 0 : await upsert(built.rows, cfg);
      const last = built.rows[built.rows.length - 1];
      const spread = built.rows.filter(
        (r) => r.sale_price != null && r.repurchase_price != null &&
               r.sale_price !== r.repurchase_price).length;

      summary.push({
        symbol: f.symbol,
        returned: raw.length,
        written: dry ? "(dry run)" : written,
        rows: built.rows.length,
        date_order: built.order,
        duplicates_collapsed: built.duplicates,
        unparseable: built.skipped,
        first: built.rows[0]?.trade_date ?? null,
        last: last?.trade_date ?? null,
        days_with_spread: spread,
        latest_nav: last?.close ?? null,
      });
    } catch (e) {
      refused.push({ symbol: f.symbol, reason: e.message });
    }
  }

  // A fund whose newest valuation is weeks old is not an error, but it is not
  // something to discover inside a chart either.
  const today = new Date().toISOString().slice(0, 10);
  const stale = summary
    .filter((s) => s.last && (Date.parse(today) - Date.parse(s.last)) / 864e5 > 7)
    .map((s) => ({ symbol: s.symbol, last: s.last,
                   days_behind: Math.round((Date.parse(today) - Date.parse(s.last)) / 864e5) }));

  return json({
    ok: refused.length === 0,
    dry_run: dry || undefined,
    funds: summary,
    refused: refused.length ? refused : undefined,
    total_written: dry ? 0 : summary.reduce((t, s) => t + (s.written || 0), 0),
    stale_feeds: stale.length ? stale : undefined,
  }, refused.length && !summary.length ? 502 : 200);
};
