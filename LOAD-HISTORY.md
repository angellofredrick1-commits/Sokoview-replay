# Loading African Markets history

64,275 rows · 28 symbols · Aug 2016 → Aug 2026 · one CSV.

## 1. Run migration 0002 first

`supabase/migrations/0002_ohlc_and_liquidity.sql` in the SQL Editor. It adds
`open`, `high`, `low`, rebuilds `price_daily` and `price_adjusted` to expose them,
and adds a `liquidity_profile` view over the full history.

The CSV has OHLC columns, so importing before this migration drops them.

## 2. Import the CSV

Supabase → **Table Editor → price_raw → Insert → Import data from CSV**, upload
`african_markets.csv`.

Columns map by name, so nothing to configure. The autoregister trigger creates any
instrument row that doesn't exist yet. 4.7 MB takes a minute or two.

If the dashboard import struggles at this size, split by symbol:

```bash
python3 scripts/load_african_markets.py ./xlsx -o out.csv
# then in psql:
\copy price_raw(symbol,trade_date,source,open,high,low,close,volume,change,pct_change,traded) \
  FROM 'out.csv' WITH (FORMAT csv, HEADER true)
```

## 3. Monthly top-ups

African Markets updates daily; re-export and re-run whenever you want:

```bash
python3 scripts/load_african_markets.py ~/Downloads/african-markets -o out.csv
```

The `(symbol, trade_date, source)` primary key makes re-imports idempotent —
overlapping days update rather than duplicate. Duplicate exports of the same stock
collapse automatically, so you can keep dropping files into one folder.

## What the loader does and doesn't do

**Does**: maps vendor company names to your symbols (note **NICOL → NICO**),
computes `change`/`pct_change` from consecutive closes, sets `traded = volume > 0`,
collapses duplicate exports, reports anything moving 18%+.

**Doesn't**: adjust for corporate actions. Raw stays raw; `price_adjusted` handles
adjustment from the `corporate_action` table. This is deliberate — when you record
a missed bonus issue in 2021, every adjusted series recomputes and no re-import is
needed.

## Two things to fix

**NMB's split ex-date is wrong in your database.** The vendor data shows the drop
on **2026-08-24**, not 26 August. Correct it:

```sql
update corporate_action set ex_date = '2026-08-24'
where symbol = 'NMB' and ex_date = '2026-08-26' and kind = 'split';
```

Until this is right, NMB reads as −29% over ten years instead of roughly +7x.

**51 moves of 18%+ need triage.** Most are on zero volume, which means a price that
moved without trading — mechanical, not market. The largest are almost certainly
corporate actions or vendor artifacts:

| Symbol | Date | Move | Volume |
|---|---|---|---|
| JHL | 2018-05-21 | +1027% | 0 |
| KA | 2017-12-18 | +225% | 0 |
| KCB | 2024-07-25 | +100% | 0 |
| JHL | 2018-05-18 | −91% | 0 |
| NMB | 2026-08-24 | −89.5% | 2,301,840 |
| TTP | 2018-03-19 | −78% | 0 |

NMB is the only one with real volume behind it — a genuine corporate action on a
day the stock traded. The rest are cross-listed Kenyan names (JHL, KA, KCB, EABL,
NMG) where the vendor appears to reprice stale quotes. Worth deciding whether to
carry those symbols at all.

## Liquidity: which symbols can actually be replayed

Percentage of the last ten years each stock printed a trade:

| Replayable | | Marginal | | Not viable |
|---|---|---|---|---|
| CRDB 98% | TPCC 80% | AFRIPRISE 42% | TTP 22% | KCB 8.1% |
| DSE 79% | NICO 78% | TCC 30% | MUCOBA 16% | SWALA 4.2% |
| VODA 66% | NMB 64% | JATU 28% | | YETU 1.5% |
| TBL 58% | SWIS 56% | TOL 28% | | JHL 1.3% |
| DCB 50% | TCCL 48% | MBP 27% | | NMG 0.8% |
| | | MCB 22% | PAL 26% | EABL 0% · KA 0% |

A monthly-investment simulation on a stock trading 1% of days is fiction — you
would be modelling purchases that could not have happened. Gate the replayer's
symbol picker on this, and mark the rest as reference-only.

USL (Uchumi) has 21 days because it only appears in the one-month all-stocks file.
`IEACLC-ETF` has no history at all. Both need separate exports if you want them.
