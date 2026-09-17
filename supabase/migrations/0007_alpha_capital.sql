-- ============================================================================
-- migration 0007 · accept the broker's daily digest as a source
--
-- Alpha Capital emails a summary of the DSE daily market report each session,
-- and that summary states a closing price for both ETFs. This matters because
-- the ETFs are the one place the quote endpoint fails outright: it has been
-- serving a frozen value, so every captured day looked identical and a replay
-- across them returned exactly 0.0%.
--
-- The digest is a restatement of the exchange's own report, so it ranks below
-- dse_report and above everything else. African Markets sits beneath it: that
-- feed was already shown to mis-price NMB around its split, while the digest
-- has so far agreed with the exchange report wherever the two overlap.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Source priority, in one place. price_daily is replaced rather than dropped
-- so that price_adjusted, which is built on it, survives untouched — the
-- column list is unchanged.
-- ---------------------------------------------------------------------------
create or replace view price_daily as
with best as (
  select distinct on (symbol, trade_date)
    symbol, trade_date, open, high, low, close, turnover, source
  from price_raw
  where close is not null
  order by symbol, trade_date,
    case source when 'dse_report'      then 1
                when 'alpha_capital'   then 2
                when 'african_markets' then 3
                when 'sokoview_quote'  then 4
                else 5 end
),
vol as (
  select distinct on (symbol, trade_date)
    symbol, trade_date, volume, traded
  from price_raw
  where volume is not null
  order by symbol, trade_date,
    case source when 'dse_report'      then 1
                when 'alpha_capital'   then 2
                when 'african_markets' then 3
                when 'sokoview_quote'  then 4
                else 5 end
)
select b.symbol, b.trade_date, b.open, b.high, b.low, b.close,
       v.volume, b.turnover, v.traded, b.source
from best b
left join vol v on v.symbol = b.symbol and v.trade_date = b.trade_date;

alter view price_daily set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- Both ETFs are equities-with-a-wrapper as far as pricing goes, but they are
-- not companies and should not sit in the equities tab. Registering them here
-- rather than relying on a trigger means the backfill cannot fail on a foreign
-- key if it is run against a fresh database.
-- ---------------------------------------------------------------------------
insert into instrument (symbol, name, kind, listed_on) values
  ('IEACLC-ETF', 'iTrust EAC Large Cap ETF',            'etf', '2026-01-28'),
  ('VERTEX-ETF', 'Vertex International Securities ETF', 'etf', null)
on conflict (symbol) do update set
  name = excluded.name,
  kind = 'etf',
  listed_on = coalesce(instrument.listed_on, excluded.listed_on);

-- ---------------------------------------------------------------------------
-- The autoregister trigger has been live in the database since the first
-- IEACLC-ETF capture failed on a foreign key, but it was never committed. It
-- belongs in the migrations, or a rebuild from this repo silently loses it.
-- ---------------------------------------------------------------------------
create or replace function autoregister_instrument() returns trigger as $$
begin
  insert into instrument (symbol, name, kind)
  values (new.symbol, new.symbol,
          case when new.symbol like '%-ETF' then 'etf' else 'equity' end)
  on conflict (symbol) do nothing;
  return new;
end;
$$ language plpgsql;

drop trigger if exists price_raw_autoregister on price_raw;
create trigger price_raw_autoregister
  before insert on price_raw
  for each row execute function autoregister_instrument();

-- ---------------------------------------------------------------------------
-- How complete is each ETF's history, and is any source still stuck?
-- A close that never moves while the day count climbs is the signature of a
-- frozen feed rather than an untraded security.
-- ---------------------------------------------------------------------------
create or replace view source_freshness as
select
  symbol,
  source,
  count(*)                                   as days,
  count(distinct close) filter (where close is not null) as distinct_closes,
  min(trade_date)                            as first_day,
  max(trade_date)                            as last_day,
  count(*) filter (where close is not null)  as days_with_close
from price_raw
group by symbol, source;

alter view source_freshness set (security_invoker = on);
