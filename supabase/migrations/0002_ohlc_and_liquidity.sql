-- ============================================================================
-- Sokoview price history · migration 0002
-- Adds OHLC columns. The quote endpoint only gives a close, but African Markets
-- supplies full OHLC + volume, so there is no reason to throw it away.
-- ============================================================================

alter table price_raw add column if not exists open  numeric(14,2);
alter table price_raw add column if not exists high  numeric(14,2);
alter table price_raw add column if not exists low   numeric(14,2);

-- Vendor rows report a close outside the high/low band on non-trading days.
-- Flag rather than reject: raw stays raw, and the flag warns you off using
-- their high/low for volatility work.
alter table price_raw add column if not exists ohlc_consistent boolean
  generated always as (
    case
      when open is null or high is null or low is null then null
      else (low <= open and open <= high and low <= close and close <= high)
    end
  ) stored;

create index if not exists price_raw_source_idx on price_raw (source, trade_date desc);

-- Expose OHLC through the preferred-source view.
create or replace view price_daily as
select distinct on (symbol, trade_date)
  symbol, trade_date, open, high, low, close, volume, turnover, traded, source
from price_raw
order by
  symbol,
  trade_date,
  case source
    when 'dse_report'      then 1
    when 'african_markets' then 2
    when 'sokoview_quote'  then 3
    else 4
  end;

alter view price_daily set (security_invoker = on);

-- price_adjusted rebuilt on the new price_daily.
create or replace view price_adjusted as
select
  p.symbol,
  p.trade_date,
  p.close as close_raw,
  round(
    p.close / coalesce((
      select exp(sum(ln(
        case ca.kind
          when 'split' then ca.value
          when 'bonus' then 1 + ca.value
          else 1
        end
      )))
      from corporate_action ca
      where ca.symbol = p.symbol
        and ca.ex_date > p.trade_date
        and ca.kind in ('split','bonus')
    ), 1),
  2) as close_adj,
  p.volume,
  p.traded,
  p.source
from price_daily p;

alter view price_adjusted set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- Liquidity over the full captured history, not just 90 days. With ten years
-- of vendor volume this becomes genuinely informative.
-- ---------------------------------------------------------------------------
create or replace view liquidity_profile as
select
  symbol,
  min(trade_date)                                       as first_day,
  max(trade_date)                                       as last_day,
  count(*)                                              as days,
  count(*) filter (where volume > 0)                    as days_traded,
  round(100.0 * count(*) filter (where volume > 0) / nullif(count(*),0), 1)
                                                        as pct_days_traded,
  sum(volume)                                           as total_volume,
  round(avg(volume) filter (where volume > 0))          as avg_volume_when_traded,
  -- longest run of consecutive non-trading days
  max(gap)                                              as longest_dry_spell
from (
  select
    symbol, trade_date, volume,
    row_number() over (partition by symbol order by trade_date)
      - row_number() over (partition by symbol, (volume > 0) order by trade_date) as grp,
    count(*) filter (where volume = 0) over (
      partition by symbol,
        row_number() over (partition by symbol order by trade_date)
        - row_number() over (partition by symbol, (volume > 0) order by trade_date)
    ) as gap
  from price_daily
  where volume is not null
) t
group by symbol;

alter view liquidity_profile set (security_invoker = on);
