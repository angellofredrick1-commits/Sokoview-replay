-- ============================================================================
-- migration 0006 · UTT AMIS unit trusts
--
-- Funds are not shares. The NAV table publishes three prices per scheme:
--   nav_per_unit    what a unit is worth
--   sale_price      what you pay to buy in
--   repurchase      what you receive on the way out
--
-- On 08-09-2026 sale = NAV on every fund (no entry fee) but repurchase sits
-- 1% below NAV on Umoja and Watoto, 2% below on Wekeza Maisha and Jikimu, and
-- level on Liquid and Bond. That exit spread is a real cost and belongs in the
-- data rather than in a footnote.
--
-- Overloading open/high/low for this would be semantic abuse, so funds get
-- their own columns.
-- ============================================================================

alter table instrument add column if not exists kind varchar(12) not null default 'equity';
-- equity | etf | fund | bond

-- Fund NAVs carry four decimals (Bond Fund trades at 123.8623). numeric(14,2)
-- would round that away, and the error compounds over a long replay. Widening
-- is lossless for the existing equity rows.
alter table price_raw alter column close type numeric(18,4);

alter table price_raw add column if not exists sale_price        numeric(18,4);
alter table price_raw add column if not exists repurchase_price  numeric(18,4);
alter table price_raw add column if not exists units_outstanding numeric(24,4);
alter table price_raw add column if not exists fund_size         numeric(24,4);

create index if not exists price_raw_fund_idx
  on price_raw (symbol, trade_date desc) where sale_price is not null;

-- The six UTT AMIS schemes.
insert into instrument (symbol, name, kind) values
  ('UMOJA',  'Umoja Fund',         'fund'),
  ('WEKEZA', 'Wekeza Maisha Fund', 'fund'),
  ('WATOTO', 'Watoto Fund',        'fund'),
  ('JIKIMU', 'Jikimu Fund',        'fund'),
  ('LIQUID', 'Liquid Fund',        'fund'),
  ('BOND',   'Bond Fund',          'fund')
on conflict (symbol) do update set name = excluded.name, kind = excluded.kind;

update instrument set kind = 'etf' where symbol in ('VERTEX-ETF','IEACLC-ETF');

-- ---------------------------------------------------------------------------
-- What an investor actually experiences: buy at sale, sell at repurchase.
-- round_trip_cost_pct is the immediate loss on buying and selling the same day.
-- ---------------------------------------------------------------------------
create or replace view fund_pricing as
select
  p.symbol, i.name, p.trade_date,
  p.close             as nav_per_unit,
  p.sale_price,
  p.repurchase_price,
  round(100.0 * (p.sale_price - p.repurchase_price)
        / nullif(p.sale_price, 0), 3)         as round_trip_cost_pct,
  p.units_outstanding,
  p.fund_size,
  p.source
from price_raw p
join instrument i on i.symbol = p.symbol
where i.kind = 'fund' and p.sale_price is not null;

alter view fund_pricing set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- Fund growth: units outstanding tells you whether money is flowing in or out,
-- which is information the DSE never gives you about a listed company.
-- ---------------------------------------------------------------------------
create or replace view fund_flows as
select
  symbol, trade_date, units_outstanding, fund_size, nav_per_unit,
  units_outstanding - lag(units_outstanding) over w as units_change,
  round(100.0 * (units_outstanding - lag(units_outstanding) over w)
        / nullif(lag(units_outstanding) over w, 0), 3) as units_change_pct
from fund_pricing
window w as (partition by symbol order by trade_date);

alter view fund_flows set (security_invoker = on);
