-- ============================================================================
-- migration 0008 · iTrust Finance collective investment schemes
--
-- iTrust publishes every scheme as plain JSON at
--   https://api.itrust.co.tz/api/fund/{id}
-- with netAssetValue, outStandingUnits, navPerUnit, salePricePerUnit and
-- repurchasePricePerUnit per day. No session, no token, no scraping.
--
-- Six unit trusts plus the ETF:
--   iCash    money market, no spread
--   iGrowth  1% on the way out
--   iSave    1% on the way out
--   iIncome  1% on the way out
--   Imaan    1% on the way out (Shariah-compliant)
--   iDollar  USD-denominated, no spread
--
-- Two things here are not like the UTT schemes and need schema, not comments.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Currency.
--
-- iDollar is priced in US dollars. Every other instrument in this database is
-- in shillings, and nothing has ever needed to say so. Left unmarked, iDollar
-- would look like a fund that fell 99.96% against its peers, and a replay
-- comparing it to iGrowth would produce a confident, meaningless number. The
-- column exists so the comparison can be refused rather than rendered.
-- ---------------------------------------------------------------------------
alter table instrument add column if not exists currency varchar(3) not null default 'TZS';

-- ---------------------------------------------------------------------------
-- 2. The schemes.
-- ---------------------------------------------------------------------------
insert into instrument (symbol, name, kind, currency) values
  ('ICASH',   'iCash',   'fund', 'TZS'),
  ('IGROWTH', 'iGrowth', 'fund', 'TZS'),
  ('ISAVE',   'iSave',   'fund', 'TZS'),
  ('IINCOME', 'iIncome', 'fund', 'TZS'),
  ('IMAAN',   'Imaan',   'fund', 'TZS'),
  ('IDOLLAR', 'iDollar', 'fund', 'USD')
on conflict (symbol) do update set
  name = excluded.name, kind = excluded.kind, currency = excluded.currency;

-- ---------------------------------------------------------------------------
-- 3. Source priority.
--
-- The manager's NAV ranks below every market source. This matters only for
-- IEACLC-ETF, which now has two honest and different prices for the same day:
-- what the fund is worth, and what the market paid for it. For a listed
-- security the traded close is the price; the NAV is the thing it trades away
-- from. Ranking iTrust last keeps price_daily reporting the market.
--
-- For the unit trusts, where iTrust is the only source, the ranking is moot.
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
                when 'utt_amis'        then 5
                when 'itrust'          then 6
                else 7 end
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
-- 4. What the ETF's two prices say about each other.
--
-- An ETF can trade above or below the value of what it holds. Nobody publishes
-- that number for the DSE, because nobody holds both series in one place. We
-- now do: the manager's NAV from iTrust, the traded close from the exchange
-- report and the broker digest.
--
-- A persistent premium means buyers are paying more than the underlying is
-- worth — useful to know before a replay tells someone the ETF returned 22%.
-- ---------------------------------------------------------------------------
create or replace view etf_premium as
select
  n.symbol,
  n.trade_date,
  n.close                                   as nav_per_unit,
  m.close                                   as market_close,
  m.source                                  as market_source,
  round(m.close - n.close, 4)               as premium,
  round(100.0 * (m.close - n.close) / nullif(n.close, 0), 3) as premium_pct
from price_raw n
join instrument i on i.symbol = n.symbol and i.kind = 'etf'
join price_daily m on m.symbol = n.symbol and m.trade_date = n.trade_date
where n.source = 'itrust' and n.close is not null and m.close is not null;

alter view etf_premium set (security_invoker = on);
