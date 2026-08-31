-- ============================================================================
-- migration 0005 · accept DSE daily market reports as a source
--
-- The exchange's own report is the authoritative record, but its main table has
-- Low / High / Shares Traded and NO closing price. So report rows carry a range
-- and volume, and close must be allowed to be null.
--
-- This is the source that finally supplies VOLUME, which the quote endpoint
-- does not return after the close.
-- ============================================================================

alter table price_raw alter column close drop not null;

-- A row is useless without either a close or a range.
alter table price_raw drop constraint if exists price_raw_has_price;
alter table price_raw add constraint price_raw_has_price
  check (close is not null or (low is not null and high is not null));

-- price_daily: prefer a source that actually has a close, but take volume from
-- whichever source has it. The exchange report wins on volume.
create or replace view price_daily as
with best as (
  select distinct on (symbol, trade_date)
    symbol, trade_date, open, high, low, close, turnover, source
  from price_raw
  where close is not null
  order by symbol, trade_date,
    case source when 'dse_report' then 1 when 'african_markets' then 2
                when 'sokoview_quote' then 3 else 4 end
),
vol as (
  select distinct on (symbol, trade_date)
    symbol, trade_date, volume, traded
  from price_raw
  where volume is not null
  order by symbol, trade_date,
    case source when 'dse_report' then 1 when 'african_markets' then 2
                when 'sokoview_quote' then 3 else 4 end
)
select b.symbol, b.trade_date, b.open, b.high, b.low, b.close,
       v.volume, b.turnover, v.traded, b.source
from best b
left join vol v on v.symbol = b.symbol and v.trade_date = b.trade_date;

alter view price_daily set (security_invoker = on);

-- Where the exchange states a range, does the vendor's close fall inside it?
-- A close outside the day's high/low is either a mis-dated row or an
-- unrecorded corporate action.
create or replace view range_check as
select
  r.symbol, r.trade_date,
  r.low as dse_low, r.high as dse_high, r.volume as dse_volume,
  o.close as other_close, o.source as other_source,
  case
    when o.close between r.low and r.high then 'in_range'
    else 'OUT_OF_RANGE'
  end as verdict
from price_raw r
join price_raw o
  on o.symbol = r.symbol and o.trade_date = r.trade_date and o.source <> 'dse_report'
where r.source = 'dse_report' and r.low is not null and r.high is not null
  and o.close is not null;

alter view range_check set (security_invoker = on);
