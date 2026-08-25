/**
 * GET /api/prices?symbol=CRDB&from=2018-01-01&to=2026-08-25
 *
 * Runs on Netlify's servers, so SOKOVIEW_API_KEY never reaches the browser.
 * Also sidesteps CORS entirely — the page calls its own origin.
 *
 * Configure in Netlify → Site settings → Environment variables:
 *   SOKOVIEW_API_KEY     (required, secret)
 *   SOKOVIEW_API_BASE    default https://api-staging.sokoview.co.tz
 *   SOKOVIEW_PRICES_PATH default /api/v1/market/prices/{symbol}
 *   SOKOVIEW_AUTH_STYLE  x-api-key | bearer | token   (default x-api-key)
 */

const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });

export default async (req) => {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";

  // Validate before touching upstream — this endpoint is public.
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) {
    return json({ error: "Invalid or missing symbol" }, 400);
  }
  const dateOk = (d) => d === "" || /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!dateOk(from) || !dateOk(to)) {
    return json({ error: "Dates must be YYYY-MM-DD" }, 400);
  }

  const key = process.env.SOKOVIEW_API_KEY;
  if (!key) {
    return json({ error: "SOKOVIEW_API_KEY is not set on this deploy" }, 500);
  }

  const base = (process.env.SOKOVIEW_API_BASE || "https://api-staging.sokoview.co.tz")
    .replace(/\/$/, "");
  const pathTpl = process.env.SOKOVIEW_PRICES_PATH || "/api/v1/market/prices/{symbol}";

  // {symbol} in the path means a REST-style route; otherwise pass as a query param.
  let upstream;
  if (pathTpl.includes("{symbol}")) {
    upstream = new URL(base + pathTpl.replace("{symbol}", encodeURIComponent(symbol)));
  } else {
    upstream = new URL(base + pathTpl);
    upstream.searchParams.set("symbol", symbol);
  }
  if (from) upstream.searchParams.set("from", from);
  if (to) upstream.searchParams.set("to", to);

  const style = (process.env.SOKOVIEW_AUTH_STYLE || "x-api-key").toLowerCase();
  const authHeader =
    style === "bearer" ? { Authorization: `Bearer ${key}` }
    : style === "token" ? { Authorization: `Token ${key}` }
    :                     { "x-api-key": key };

  try {
    const res = await fetch(upstream, {
      headers: { Accept: "application/json", ...authHeader },
      signal: AbortSignal.timeout(15000),
    });

    const text = await res.text();

    if (!res.ok) {
      // Surface the status, but never echo the upstream body — it can contain
      // internal detail, and on a 401 it may reflect the key back.
      return json(
        { error: `Upstream responded ${res.status}. Check SOKOVIEW_PRICES_PATH and SOKOVIEW_AUTH_STYLE.` },
        res.status === 404 ? 502 : res.status
      );
    }

    // EOD data — cache hard at the CDN, serve stale while revalidating.
    return new Response(text, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (e) {
    const msg = e.name === "TimeoutError" ? "Upstream timed out" : "Could not reach upstream";
    return json({ error: msg }, 504);
  }
};

export const config = { path: "/api/prices" };
