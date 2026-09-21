/**
 * Keeps the iTrust schemes current after the one-off backfill.
 *
 * Runs 18:00 EAT (15:00 UTC) daily. Funds are valued on their own schedule
 * rather than the exchange's — iTrust posts weekend valuations for the money
 * market funds — so this runs every day, not Mon–Fri, and separately from the
 * equity capture: a fund outage should not take the closing prices with it.
 *
 * It asks for the last 21 days rather than just today, which costs nothing
 * extra (the API returns the whole history either way) and quietly repairs any
 * day the job was down for.
 */
import { schedule } from "@netlify/functions";
import { FUNDS, fetchFund, buildRows, upsert } from "./backfill-itrust.mjs";

const WINDOW_DAYS = 21;

export const handler = schedule("0 15 * * *", async () => {
  const cfg = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY };
  if (!cfg.url || !cfg.key) {
    console.error("capture-funds: Supabase env vars not set");
    return { statusCode: 500, body: JSON.stringify({ error: "Supabase env vars not set" }) };
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const wrote = [];
  const failed = [];

  // Sequential, and one fund's failure does not abort the rest: a stalled feed
  // is normal here (Imaan and the ETF NAV have both gone quiet for weeks) and
  // should not cost us the funds that are still publishing.
  for (const f of FUNDS) {
    try {
      const built = buildRows(await fetchFund(f.id), f.symbol, { since });
      if (built.refused) { failed.push({ symbol: f.symbol, reason: built.refused }); continue; }
      const written = await upsert(built.rows, cfg);
      wrote.push({ symbol: f.symbol, written, last: built.rows[built.rows.length - 1]?.trade_date ?? null });
    } catch (e) {
      failed.push({ symbol: f.symbol, reason: e.message });
    }
  }

  const result = { ok: failed.length === 0, since, wrote, failed: failed.length ? failed : undefined };
  console.log("capture-funds", JSON.stringify(result));
  return { statusCode: 200, body: JSON.stringify(result) };
});
