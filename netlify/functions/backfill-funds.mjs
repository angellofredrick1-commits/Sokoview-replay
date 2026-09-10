/**
 * Backfill UTT AMIS NAV history into price_raw.
 *
 *   GET /.netlify/functions/backfill-funds?token=YOUR_TOKEN
 *   GET /.netlify/functions/backfill-funds?token=…&fund=Umoja      (one scheme)
 *   GET /.netlify/functions/backfill-funds?token=…&since=2020-01-01
 *
 * How the source works
 * --------------------
 * uttamis.co.tz/fund-performance renders an empty table and fills it from a
 * DataTables endpoint. That endpoint wants a session cookie and a CSRF token,
 * both of which the public homepage hands out, and it filters server-side on a
 * scheme-name search. Ask for one scheme with a large page size and it returns
 * that fund's entire NAV history.
 *
 * This is the same request the site's own page makes. It runs once for a
 * backfill, then the nightly capture keeps it current — so it is not a load
 * anyone will notice.
 */

const UTT_ORIGIN = "https://uttamis.co.tz";
const UTT_HOME = `${UTT_ORIGIN}/`;
const UTT_NAVS = `${UTT_ORIGIN}/navs`;
const PAGE_SIZE = 5000;

// scheme-name search term -> the symbol used in our instrument table
const FUNDS = [
  { search: "Umoja",  symbol: "UMOJA" },
  { search: "Wekeza", symbol: "WEKEZA" },
  { search: "Watoto", symbol: "WATOTO" },
  { search: "Jikimu", symbol: "JIKIMU" },
  { search: "Liquid", symbol: "LIQUID" },
  { search: "Bond",   symbol: "BOND" },
];

// v1 handler shape, matching the other functions on this site.
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
 * UTT writes DD-MM-YYYY. Day-first is the correct reading for a Tanzanian
 * source, but the first twelve days of a month are ambiguous against MM-DD, so
 * anything that could be read either way is reported back for a spot check
 * rather than trusted silently.
 */
function toIso(raw) {
  const m = String(raw ?? "").match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (!m) return null;
  const d = +m[1], mo = +m[2], y = +m[3];
  if (d > 31 || mo > 12) return null;
  return {
    iso: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    ambiguous: d <= 12 && mo <= 12 && d !== mo,
  };
}

function cookiesFrom(res) {
  const g = res.headers.getSetCookie;
  if (typeof g === "function") {
    const list = g.call(res.headers);
    if (list?.length) return list.map((c) => c.split(";")[0]).join("; ");
  }
  const single = res.headers.get("set-cookie");
  if (!single) return "";
  return single.split(/,(?=[^;]+?=)/).map((p) => p.split(";")[0].trim()).join("; ");
}

async function getSession() {
  const res = await fetch(UTT_HOME, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "SokoviewDataCapture/1.0 (+https://sokoview.co.tz)",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`UTT homepage ${res.status}`);
  const html = await res.text();
  const csrf = /<meta\s+name="csrf-token"\s+content="([^"]+)"/i.exec(html)?.[1];
  if (!csrf) throw new Error("No CSRF token on the UTT homepage — the page may have changed");
  return { csrf, cookie: cookiesFrom(res) };
}

function navsBody({ csrf, draw, start, length, search }) {
  const p = new URLSearchParams();
  p.append("csrf-token", csrf);
  p.append("draw", String(draw));
  p.append("start", String(start));
  p.append("length", String(length));
  p.append("search[value]", "");
  p.append("search[regex]", "false");

  const cols = [
    ["DT_RowIndex", "", false, false, ""],
    ["sname", "sname.name", true, true, search],
    ["net_asset_value", "net_asset_value", true, true, ""],
    ["outstanding_number_of_units", "outstanding_number_of_units", true, true, ""],
    ["nav_per_unit", "nav_per_unit", true, true, ""],
    ["sale_price_per_unit", "sale_price_per_unit", true, true, ""],
    ["repurchase_price_per_unit", "repurchase_price_per_unit", true, true, ""],
    ["date_valued", "date_valued", true, true, ""],
  ];
  cols.forEach(([data, name, searchable, orderable, sv], i) => {
    p.append(`columns[${i}][data]`, data);
    p.append(`columns[${i}][name]`, name);
    p.append(`columns[${i}][searchable]`, String(searchable));
    p.append(`columns[${i}][orderable]`, String(orderable));
    p.append(`columns[${i}][search][value]`, sv);
    p.append(`columns[${i}][search][regex]`, "false");
  });
  p.append("order[0][column]", "7");
  p.append("order[0][dir]", "desc");
  return p.toString();
}

async function fetchHistory(search, session) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    "X-CSRF-TOKEN": session.csrf,
    Referer: UTT_HOME,
    Origin: UTT_ORIGIN,
    "User-Agent": "SokoviewDataCapture/1.0 (+https://sokoview.co.tz)",
  };
  if (session.cookie) headers.Cookie = session.cookie;

  const rows = [];
  let start = 0, draw = 1, total = Infinity;

  while (start < total) {
    const res = await fetch(UTT_NAVS, {
      method: "POST", headers,
      body: navsBody({ csrf: session.csrf, draw, start, length: PAGE_SIZE, search }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`/navs ${res.status}`);
    const body = await res.json();
    if (body?.message === "Unauthenticated") throw new Error("UTT rejected the session");

    const page = body?.data ?? [];
    total = body?.recordsFiltered ?? body?.recordsTotal ?? page.length;
    if (!page.length) break;
    rows.push(...page);
    start += page.length;
    draw += 1;
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function upsert(rows, cfg) {
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

export const handler = async (event) => {
  const expected = process.env.CAPTURE_TRIGGER_TOKEN;
  if (!expected) return json({ error: "Manual trigger disabled" }, 404);
  if (event.queryStringParameters?.token !== expected) return json({ error: "Bad token" }, 401);

  const cfg = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_KEY,
  };
  if (!cfg.url || !cfg.key) return json({ error: "Supabase env vars not set" }, 500);

  const only = event.queryStringParameters?.fund;
  const since = event.queryStringParameters?.since || null;
  const targets = only
    ? FUNDS.filter((f) => f.search.toLowerCase() === only.toLowerCase())
    : FUNDS;
  if (!targets.length) return json({ error: `Unknown fund '${only}'` }, 400);

  try {
    const session = await getSession();
    const summary = [];
    const ambiguousSet = new Set();

    for (const f of targets) {
      const raw = await fetchHistory(f.search, session);

      const rows = [];
      let skipped = 0;
      for (const r of raw) {
        const d = toIso(r.date_valued);
        const nav = num(r.nav_per_unit);
        if (!d || nav == null || nav <= 0) { skipped += 1; continue; }
        if (since && d.iso < since) continue;
        if (d.ambiguous) ambiguousSet.add(`${f.symbol}|${d.iso}`);
        rows.push({
          symbol: f.symbol,
          trade_date: d.iso,
          source: "utt_amis",
          close: nav,
          sale_price: num(r.sale_price_per_unit),
          repurchase_price: num(r.repurchase_price_per_unit),
          units_outstanding: num(r.outstanding_number_of_units),
          fund_size: num(r.net_asset_value),
        });
      }

      // One row per date. The endpoint returns newest first and occasionally
      // repeats a valuation, so keep the FIRST occurrence — letting later rows
      // overwrite it replaces the authoritative record with a stale restatement.
      const byDate = {};
      rows.forEach((r) => { if (!(r.trade_date in byDate)) byDate[r.trade_date] = r; });
      const deduped = Object.values(byDate).sort((a, b) =>
        a.trade_date < b.trade_date ? -1 : 1);

      const written = await upsert(deduped, cfg);
      summary.push({
        symbol: f.symbol,
        returned: raw.length,
        written,
        duplicates_collapsed: rows.length - deduped.length,
        unparseable: skipped,
        first: deduped[0]?.trade_date ?? null,
        last: deduped[deduped.length - 1]?.trade_date ?? null,
      });
    }

    return json({
      ok: true,
      funds: summary,
      total_written: summary.reduce((t, s) => t + s.written, 0),
      ambiguous_dates: ambiguousSet.size,
      note: ambiguousSet.size
        ? "Some dates could be read day-first or month-first. Day-first was used; " +
          "spot-check a few against uttamis.co.tz/fund-performance."
        : undefined,
    });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
};
