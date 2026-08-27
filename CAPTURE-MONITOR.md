# Capture monitor

Lives at **`/capture`** on the same Netlify site. Reads Supabase directly with the
publishable key — no function in between, no secrets in the browser.

## Setup

Add two variables in Netlify → Environment variables (neither is secret):

| Key | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://iwzgkhncmsodfccwatht.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | your `sb_publishable_…` key |

The `VITE_` prefix means Vite inlines these into the browser bundle — correct here,
and exactly why the **secret** key must never get one.

Skip this and the page shows a connection form instead; handy for pointing it at a
different project without redeploying.

## What each panel answers

**Health strip** — did today's capture actually happen, and is it complete?
*Volume coverage* is the one to watch: 0% means the session run isn't landing inside
market hours, so you have no direct trade evidence.

**Needs a look** — moves of 18%+ over the last 14 days, symbols missing from the
latest capture, and upstream timestamps that haven't moved in 5+ days. Large moves
are usually corporate actions; the panel marks whether one is already recorded in
`corporate_action`. It scans a rolling window rather than just today, so a split
stays visible until you record it.

**Market table** — today's closes, moves and volume. `Traded` comes from volume when
available and falls back to the `traded` flag otherwise, and says which it used.

**Capture coverage** — one cell per symbol per day. Gaps mean a run failed. With one
day it's a single column; the value builds as history accumulates.

**Liquidity** — share of captured days each stock actually traded. Needs volume.
Nobody publishes this cleanly for the DSE, which is what makes it worth having.

**Reconciliation** — where two sources disagree on the same symbol and day. Empty
until you load a second source. Once African Markets history is in with
`source = 'african_markets'`, overlapping days get compared automatically, and
disagreements usually point at an unrecorded corporate action.

## Known caveats

- Reads `price_raw`, so it reflects what was captured rather than the cleaned series.
- Fetches the most recent 5,000 rows. At 30 instruments a day that's about six
  months; raise the limit in `load()` when you outgrow it.
- The `traded` column in the database currently means *seen in today's sync*, not
  *traded*. Once volume arrives, `volume > 0` is the honest signal and the flag can
  be recomputed across all history.
