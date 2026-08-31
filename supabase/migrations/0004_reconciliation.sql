-- ============================================================================
-- migration 0004 · reconciliation
--
-- Compares sources against each other and records the result. Two jobs:
--
--   1. reconcile()      — populate the reconciliation table for a date window
--   2. source_lag       — detect whether one source is systematically offset in
--                         time from another, which a naive same-date comparison
--                         reports as "everything mismatches"
--
-- The lag view exists because of a real finding: the Sokoview quote endpoint
-- returns the PREVIOUS trading day's close, so on 2026-08-26 it reported the
-- 24th's price. Same-date comparison called that a market-wide disagreement.
-- Shifting by one trading day resolves it exactly.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Populate reconciliation for the last N days.
-- Compares every pair of sources that both have a row for a symbol/date.
-- Idempotent: clears the window first, so re-running is safe.
-- ---------------------------------------------------------------------------
create or replace function reconcile(
  days_back int default 30,
  tolerance numeric default 0.005
) returns table (checked int, matched int, mismatched int)
language plpgsql as $$
declare
  cutoff date := current_date - days_back;
begin
  delete from reconciliation where trade_date >= cutoff;

  insert into reconciliation (symbol, trade_date, source_a, source_b, value_a, value_b, status)
  select
    a.symbol, a.trade_date, a.source, b.source, a.close, b.close,
    case when abs(a.close - b.close) <= tolerance then 'match' else 'mismatch' end
  from price_raw a
  join price_raw b
    on  b.symbol = a.symbol
    and b.trade_date = a.trade_date
    and b.source > a.source            -- each pair once, not twice
  where a.trade_date >= cutoff;

  -- Rows one source has and the other does not, within the window.
  insert into reconciliation (symbol, trade_date, source_a, source_b, value_a, value_b, status)
  select a.symbol, a.trade_date, a.source, s.other, a.close, null, 'missing_b'
  from price_raw a
  cross join (select distinct source as other from price_raw) s
  where a.trade_date >= cutoff
    and s.other <> a.source
    and not exists (
      select 1 from price_raw b
      where b.symbol = a.symbol and b.trade_date = a.trade_date and b.source = s.other
    )
    -- only within the other source's own coverage, or every backfill gap shows up
    and a.trade_date between
        (select min(trade_date) from price_raw where source = s.other)
    and (select max(trade_date) from price_raw where source = s.other);

  return query
    select count(*)::int,
           count(*) filter (where status = 'match')::int,
           count(*) filter (where status = 'mismatch')::int
    from reconciliation where trade_date >= cutoff;
end $$;

-- ---------------------------------------------------------------------------
-- Is one source systematically shifted in time from another?
--
-- For each candidate offset (0, 1, 2 trading days) count how many symbol/days
-- agree. If offset 1 agrees far more often than offset 0, the source is a day
-- behind — a data pipeline problem, not a pricing disagreement.
-- ---------------------------------------------------------------------------
create or replace view source_lag as
with theirs as (
  select symbol, trade_date, close,
         lag(close, 1) over (partition by symbol order by trade_date) as close_1_back,
         lag(close, 2) over (partition by symbol order by trade_date) as close_2_back
  from price_raw where source = 'african_markets'
),
ours as (
  select symbol, trade_date, close from price_raw where source = 'sokoview_quote'
),
joined as (
  select o.symbol, o.trade_date, o.close as ours,
         t.close as theirs_same_day, t.close_1_back, t.close_2_back
  from ours o join theirs t on t.symbol = o.symbol and t.trade_date = o.trade_date
)
select 0 as trading_days_behind,
       count(*) as compared,
       count(*) filter (where ours = theirs_same_day) as agreed,
       round(100.0 * count(*) filter (where ours = theirs_same_day) / nullif(count(*),0), 1) as pct_agreed
from joined
union all
select 1, count(*) filter (where close_1_back is not null),
       count(*) filter (where ours = close_1_back),
       round(100.0 * count(*) filter (where ours = close_1_back)
             / nullif(count(*) filter (where close_1_back is not null),0), 1)
from joined
union all
select 2, count(*) filter (where close_2_back is not null),
       count(*) filter (where ours = close_2_back),
       round(100.0 * count(*) filter (where ours = close_2_back)
             / nullif(count(*) filter (where close_2_back is not null),0), 1)
from joined
order by 1;

-- ---------------------------------------------------------------------------
-- Everything currently disagreeing, worst first.
-- ---------------------------------------------------------------------------
create or replace view reconciliation_open as
select symbol, trade_date, source_a, source_b, value_a, value_b,
       abs(value_a - value_b) as gap,
       round(100.0 * abs(value_a - value_b) / nullif(greatest(value_a, value_b), 0), 2)
         as gap_pct
from reconciliation
where status = 'mismatch'
order by gap_pct desc nulls last;

alter view source_lag           set (security_invoker = on);
alter view reconciliation_open  set (security_invoker = on);

alter table reconciliation enable row level security;
