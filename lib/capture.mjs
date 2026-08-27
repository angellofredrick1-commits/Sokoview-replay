/**
 * Shared capture routine.
 *
 * Two scheduled runs use this:
 *   capture-session — just before close, while the market is open, so volume
 *                     is still populated.
 *   capture-close   — after close, for the settled closing price.
 *
 * Both upsert into the same (symbol, trade_date, source) row. The close run
 * overwrites price; the session run's volume is preserved via COALESCE on
 * the Postgres side of the upsert (see mergeRow below).
 */

const DEFAULT_SYMBOLS = [
  "CRDB", "NMB", "TBL", "TCC", "TPCC", "TCCL", "DSE", "SWIS", "VODA", "TOL",
  "JATU", "DCB", "MBP", "MCB", "MKCB", "MUCOBA", "YETU", "NICO", "PAL",
  "SWALA", "TTP", "USL", "AFRIPRISE", "EABL", "JHL", "KA", "KCB", "NMG",
];

const SOURCE = "sokoview_quote";

/** Dar es Salaam is UTC+3 year-round, so the trading date is UTC date +3h. */
export function tradingDateEAT(now = new Date()) {
  return new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Did this stock actually print a trade today?
 * upstream's updatedAt only advances when the price changes, so a stale date
 * means no trade. Falls back to volume when the timestamp is absent.
 */
function didTrade(row, tradeDate) {
  if (row.updatedAt) {
    const upstreamDate = new Date(row.updatedAt).toISOString().slice(0, 10);
    // Compare in EAT terms to avoid an off-by-one around midnight UTC.
    const upstreamEAT = new Date(new Date(row.updatedAt).getTime() + 3 * 3600 * 1000)
      .toISOString().slice(0, 10);
    if (upstreamEAT === tradeDate) return true;
    if (upstreamDate < tradeDate) return false;
  }
  const vol = numOrNull(row.volume);
  if (vol !== null) return vol > 0;
  return null; // unknown — better than a wrong answer
}

/**
 * Number(null) is 0 and Number("") is 0, so a bare isFinite check silently
 * turns "unknown" into "definitely zero". For a liquidity dataset that is a
 * corrupting error, not a rounding one.
 */
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Fetch one symbol's quote through the Sokoview API. */
async function fetchQuote(symbol, { base, key, authStyle }) {
  const url = `${base.replace(/\/$/, "")}/api/v1/market/prices/${encodeURIComponent(symbol)}`;
  const headers = { Accept: "application/json" };
  if (authStyle === "bearer") headers.Authorization = `Bearer ${key}`;
  else if (authStyle === "token") headers.Authorization = `Token ${key}`;
  else headers["x-api-key"] = key;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${symbol}: upstream ${res.status}`);
  return res.json();
}

/** Try the bulk endpoint first — one request beats 28. */
async function fetchAll({ base, key, authStyle }) {
  const url = `${base.replace(/\/$/, "")}/api/v1/market/prices`;
  const headers = { Accept: "application/json" };
  if (authStyle === "bearer") headers.Authorization = `Bearer ${key}`;
  else if (authStyle === "token") headers.Authorization = `Token ${key}`;
  else headers["x-api-key"] = key;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const body = await res.json();
  const rows = Array.isArray(body) ? body : body?.data ?? body?.prices ?? null;
  return Array.isArray(rows) && rows.length ? rows : null;
}

/** Upsert rows into Supabase via PostgREST. */
async function upsert(rows, { supabaseUrl, serviceKey }) {
  if (!rows.length) return 0;
  const url =
    `${supabaseUrl.replace(/\/$/, "")}/rest/v1/price_raw` +
    `?on_conflict=symbol,trade_date,source`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Supabase upsert failed ${res.status}: ${detail.slice(0, 300)}`);
  }
  return rows.length;
}

/**
 * @param phase "session" (volume available) or "close" (settled price)
 */
export async function capture(phase) {
  const base = process.env.SOKOVIEW_API_BASE || "https://api-staging.sokoview.co.tz";
  const key = process.env.SOKOVIEW_API_KEY;
  const authStyle = (process.env.SOKOVIEW_AUTH_STYLE || "x-api-key").toLowerCase();
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  const missing = [
    !key && "SOKOVIEW_API_KEY",
    !supabaseUrl && "SUPABASE_URL",
    !serviceKey && "SUPABASE_SERVICE_KEY",
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);

  const symbols = (process.env.CAPTURE_SYMBOLS || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const universe = symbols.length ? symbols : DEFAULT_SYMBOLS;

  const tradeDate = tradingDateEAT();
  const errors = [];
  let quotes = [];

  // Prefer the bulk endpoint if it exists.
  const bulk = await fetchAll({ base, key, authStyle }).catch(() => null);
  if (bulk) {
    quotes = bulk.filter((q) => q?.symbol);
  } else {
    // Fall back to per-symbol, in small batches to stay polite.
    for (let i = 0; i < universe.length; i += 6) {
      const batch = universe.slice(i, i + 6);
      const settled = await Promise.allSettled(
        batch.map((s) => fetchQuote(s, { base, key, authStyle }))
      );
      settled.forEach((r, j) => {
        if (r.status === "fulfilled" && r.value) quotes.push(r.value);
        else errors.push(`${batch[j]}: ${r.reason?.message ?? "failed"}`);
      });
    }
  }

  const rows = quotes
    .filter((q) => q?.symbol && Number.isFinite(Number(q.price)))
    .map((q) => {
      const row = {
        symbol: String(q.symbol).toUpperCase(),
        trade_date: tradeDate,
        source: SOURCE,
        close: Number(q.price),
        // Upstream's change/percentageChange can stay anchored to a pre-split
        // price for days after a corporate action, which manufactures phantom
        // crashes. Leave them null and let the database derive them from
        // consecutive stored closes instead.
        change: null,
        pct_change: null,
        upstream_at: q.updatedAt ?? null,
        traded: didTrade(q, tradeDate),
        captured_at: new Date().toISOString(),
      };
      // Only the session run has meaningful volume. Omitting the key on the
      // close run leaves the existing value untouched by merge-duplicates.
      const vol = numOrNull(q.volume);
      if (phase === "session" && vol !== null) row.volume = vol;
      return row;
    });

  const written = await upsert(rows, { supabaseUrl, serviceKey });

  return {
    phase,
    trade_date: tradeDate,
    fetched: quotes.length,
    written,
    traded_today: rows.filter((r) => r.traded === true).length,
    bulk_endpoint: Boolean(bulk),
    errors: errors.slice(0, 10),
  };
}
