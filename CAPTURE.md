# Price history capture

Nightly job that snapshots DSE quotes into Supabase, building the historical
series Sokoview doesn't currently store.

## Why two runs a day

Your quote endpoint returns `volume` only while the market is open, and the
settled close only after it shuts. So:

| Function | Cron (UTC) | EAT | Purpose |
|---|---|---|---|
| `capture-session` | `55 12 * * 1-5` | 15:55 | 5 min before close — captures **volume** |
| `capture-close` | `30 13 * * 1-5` | 16:30 | after close — captures **settled price** |

Both upsert the same `(symbol, trade_date, source)` row. The close run omits the
`volume` key entirely, so Postgres `merge-duplicates` leaves the session run's
value intact.

DSE trades Mon–Fri 10:30–16:00 EAT. Netlify crons are UTC; EAT is UTC+3 with no
DST, so the offset is fixed.

## The `traded` flag

On the DSE many stocks go days without printing a trade, but the API still
returns a price with `change: 0`. Storing that as a real close manufactures flat
days that never happened and corrupts every volatility and drawdown figure
downstream.

We derive `traded` from `updatedAt`: if its date is older than the trading date,
no trade printed. Falls back to volume, and stays `null` when neither signal is
available — an honest unknown beats a confident wrong answer.

> **Verify this assumption** before trusting the data: check an illiquid name
> like `TTP` or `TCC` and confirm `updatedAt` is genuinely stale for them. If
> your backend touches `updatedAt` on every poll regardless of trades, this
> signal is worthless and needs replacing.

## Setup

**1. Supabase** — create a project, open SQL Editor, run
`supabase/migrations/0001_price_history.sql`.

**2. Netlify environment variables** (Site configuration → Environment variables):

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://YOUR-PROJECT.supabase.co` |
| `SUPABASE_SERVICE_KEY` | service role key — **mark Secret** |
| `SOKOVIEW_API_KEY` | your rotated key — **mark Secret** |
| `SOKOVIEW_API_BASE` | `https://api-staging.sokoview.co.tz` |
| `SOKOVIEW_AUTH_STYLE` | `x-api-key` |
| `CAPTURE_TRIGGER_TOKEN` | any random string, for manual testing |
| `CAPTURE_SYMBOLS` | *optional* — comma-separated, defaults to all 28 |

The **service role key bypasses row-level security**. It belongs only in this
env var, never in the frontend bundle and never in the repo.

**3. Deploy**, then test immediately rather than waiting for the cron:

```
https://YOUR-SITE.netlify.app/.netlify/functions/capture-now?phase=session&token=YOUR_TOKEN
```

Returns a summary:

```json
{ "phase":"session", "trade_date":"2026-08-25", "fetched":28,
  "written":28, "traded_today":11, "bulk_endpoint":true, "errors":[] }
```

`traded_today` well below `fetched` is expected on the DSE — that gap *is* the
liquidity signal.

**4. Confirm the schedule** registered: Netlify → Functions should list both
capture functions with their cron expressions.

## Reading it back

Supabase auto-generates REST over the tables, so no endpoint to write:

```
GET https://YOUR-PROJECT.supabase.co/rest/v1/price_daily
    ?symbol=eq.CRDB&order=trade_date.asc&select=trade_date,close,volume,traded
Headers: apikey: YOUR_ANON_KEY
```

The anon key is safe in the frontend — RLS grants read-only access.

That response shape (`[{trade_date, close}, …]`) needs one tweak in
`normalizeSeries()` to map `trade_date` → `date`, and the replayer runs on real
data.

## Views

| View | What it gives you |
|---|---|
| `price_daily` | One row per symbol/day, best source available |
| `price_adjusted` | Split/bonus-adjusted closes, computed not stored |
| `liquidity_90d` | % of days traded per symbol — the scarce asset |

## Backfill

Capture alone only replays from tonight forward. To load history, insert rows
with a different `source` value (`dse_report`, `eodhd`) and the composite key
keeps them side by side with your own capture. Where they disagree, log it in
`reconciliation` — mismatches are usually an unrecorded corporate action.
