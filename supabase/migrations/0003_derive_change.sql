-- ============================================================================
-- migration 0003 · derive change/pct_change instead of trusting upstream
--
-- The Sokoview quote endpoint keeps reporting `change` against a pre-split
-- price for days after a corporate action. NMB's 1:10 split on 2026-08-24 made
-- every subsequent capture row carry a phantom -89%, which the monitor then
-- flagged as a fresh corporate action each day.
--
-- Fix: compute from consecutive stored closes. The capture function now writes
-- null and this trigger fills it in.
-- ============================================================================

-- 1. Backfill existing rows
with fixed as (
  select p.symbol, p.trade_date,
         p.close - d.prev_close as new_change,
         round(100.0 * (p.close - d.prev_close) / nullif(d.prev_close, 0), 4) as new_pct
  from price_raw p
  join (
    select symbol, trade_date,
           lag(close) over (partition by symbol order by trade_date) as prev_close
    from price_daily
  ) d on d.symbol = p.symbol and d.trade_date = p.trade_date
  where p.source = 'sokoview_quote' and d.prev_close is not null
)
update price_raw p
set change = f.new_change, pct_change = f.new_pct
from fixed f
where p.symbol = f.symbol and p.trade_date = f.trade_date
  and p.source = 'sokoview_quote';

-- 2. Derive on every future capture insert
create or replace function derive_change()
returns trigger language plpgsql as $$
declare prev numeric;
begin
  if new.change is not null then
    return new;   -- vendor rows arrive with change already computed
  end if;
  select close into prev
  from price_daily
  where symbol = new.symbol and trade_date < new.trade_date
  order by trade_date desc
  limit 1;

  if prev is not null and prev <> 0 then
    new.change := new.close - prev;
    new.pct_change := round(100.0 * (new.close - prev) / prev, 4);
  end if;
  return new;
end $$;

drop trigger if exists price_raw_derive_change on price_raw;
create trigger price_raw_derive_change
  before insert or update on price_raw
  for each row execute function derive_change();
