# Reconciliation

Two sources for the same market means they can be checked against each other.
Disagreements are signal: usually an unrecorded corporate action, sometimes a
pipeline fault.

## Run it

```sql
select * from reconcile(30);      -- last 30 days
select * from reconcile(3650);    -- everything
```

Returns `checked / matched / mismatched`. Idempotent — it clears the window
first, so re-run as often as you like. Worth running after every vendor import.

Then look at what disagrees:

```sql
select * from reconciliation_open limit 20;
```

Sorted by percentage gap, worst first.

## Check for a time offset first

Before treating mismatches as price disagreements, check whether one source is
simply shifted in time:

```sql
select * from source_lag;
```

| trading_days_behind | compared | agreed | pct_agreed |
|---|---|---|---|
| 0 | 6 | 1 | 16.7 |
| 1 | 6 | 6 | **100.0** |

That is the real result from 26 August 2026. Same-day comparison agrees 17% of
the time; comparing against the vendor's **previous trading day** agrees 100%.

**The Sokoview quote endpoint returns the previous trading day's close.** On the
26th it served the 24th's price. Every capture row is stamped with the wrong date.

This is not a rounding difference or a stale cache on some symbols — it is exact,
across every instrument. A same-date reconciliation would have called it a
market-wide disagreement and told you nothing.

## What to do about the lag

Three options, and the choice depends on where the fault belongs:

**Fix upstream.** The quote endpoint is serving day-old data at close. If the main
Sokoview app values portfolios from it, users see yesterday's prices labelled as
today's. That is the real fix and it matters well beyond this project.

**Shift at capture.** Stamp the row with the previous trading day. One line, but it
hardcodes an assumption that breaks silently the day the API is corrected.

**Correct downstream.** Leave `price_raw` untouched, shift in a view. Raw stays raw
and `source_lag` keeps telling you the offset is still there — so if upstream is
fixed, you notice.

The third is the most conservative and the easiest to unwind. Do not shift the
data until the API question is settled either way.

## Reading the statuses

| status | meaning |
|---|---|
| `match` | closes agree within tolerance (default 0.005) |
| `mismatch` | they disagree — check for a corporate action first |
| `missing_b` | one source has the day, the other does not, inside its own coverage |

`missing_b` only fires within the other source's own date range, so a decade of
backfill does not report a gap for every day before capture started.
