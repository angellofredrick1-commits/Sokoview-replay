-- 0011 · DSE benchmark for portfolio comparisons
--
-- The database has no official DSE index series, so this builds one the same way
-- the Tanzania Share Index (TSI) is built: every Tanzanian-listed company, weighted
-- by market value. Cross-listed Kenyan companies (EABL, JHL, KA, KCB, NMG, USL) are
-- left out, as in the TSI.
--
-- Weights are shares in issue, taken from the market capitalisation the DSE
-- published for 15 Oct 2026 divided by that day's close. They are held constant
-- through history, and prices are split-adjusted, so NMB's 1-for-10 split doesn't
-- move the index. The index is chain-linked (each day compares today's and
-- yesterday's prices for the same companies), so later listings such as VODA (2017)
-- and NICO (2018) join without jumps. Price only; dividends are not included.
-- Base: 1,000 on the first day with prices (29 Aug 2016).
--
-- Additive only. To undo:
--   drop function public.index_at(date[]); drop function public.index_monthly(date);
--   drop function public.monthly_closes(text[], date);
--   drop view public.market_index; drop table public.index_member;

create table if not exists public.index_member (
  symbol      varchar primary key references public.instrument(symbol),
  shares      numeric not null check (shares > 0),
  as_of       date not null,
  source      text not null
);

alter table public.index_member enable row level security;
drop policy if exists "public read index members" on public.index_member;
create policy "public read index members" on public.index_member for select to anon, authenticated using (true);

insert into public.index_member (symbol, shares, as_of, source)
select symbol, round(mcap_bn * 1e9 / close_ref), date '2026-10-15', 'DSE market capitalisation, 15 Oct 2026'
from (values
  ('AFRIPRISE', 107.3, 735), ('CRDB', 7391.5, 2830), ('DCB', 74.7, 390), ('DSE', 148.4, 6230),
  ('JATU', 4.6, 230), ('MBP', 60.3, 2010), ('MCB', 92.7, 375), ('MKCB', 89.7, 3810),
  ('MUCOBA', 13.7, 420), ('NICO', 217.6, 3530), ('NMB', 9950.0, 1990), ('PAL', 48.1, 300),
  ('SWALA', 47.8, 450), ('SWIS', 83.2, 2310), ('TBL', 2891.6, 9800), ('TCC', 1337.0, 13370),
  ('TCCL', 796.5, 4170), ('TOL', 96.6, 1680), ('TPCC', 1027.4, 5710), ('TTP', 39.9, 420),
  ('VODA', 2844.8, 1270), ('YETU', 6.2, 510)
) v(symbol, mcap_bn, close_ref)
on conflict (symbol) do update set shares = excluded.shares, as_of = excluded.as_of, source = excluded.source;

-- One row per trading day: index level, total market value of the members, member count.
create or replace view public.market_index with (security_invoker = true) as
with px as (
  select pa.symbol, pa.trade_date, pa.close_adj, m.shares,
         lag(pa.close_adj) over (partition by pa.symbol order by pa.trade_date) as prev
  from public.price_adjusted pa
  join public.index_member m on m.symbol = pa.symbol
  where pa.close_adj > 0
), d as (
  select trade_date,
         sum(shares * close_adj) filter (where prev is not null) as cap_now,
         sum(shares * prev)      filter (where prev is not null) as cap_prev,
         sum(shares * close_adj) as market_value,
         count(*) as members
  from px
  group by trade_date
)
select trade_date,
       round((1000 * exp(sum(ln(coalesce(cap_now / nullif(cap_prev, 0), 1))) over (order by trade_date)))::numeric, 4) as level,
       round(market_value) as market_value,
       members
from d;

grant select on public.market_index to anon, authenticated;

-- Index level on each requested date (or the last trading day before it).
create or replace function public.index_at(p_dates date[])
returns table (asked date, trade_date date, level numeric)
language sql stable security invoker set search_path = '' as $$
  with idx as (select mi.trade_date, mi.level from public.market_index mi)
  select q.asked, i.trade_date, i.level
  from unnest(p_dates) as q(asked)
  cross join lateral (
    select idx.trade_date, idx.level from idx where idx.trade_date <= q.asked order by idx.trade_date desc limit 1
  ) i;
$$;

-- Last level of each month from p_from, plus the latest day. Small enough for charts.
create or replace function public.index_monthly(p_from date)
returns table (trade_date date, level numeric)
language sql stable security invoker set search_path = '' as $$
  select distinct on (date_trunc('month', mi.trade_date)) mi.trade_date, mi.level
  from public.market_index mi
  where mi.trade_date >= p_from
  order by date_trunc('month', mi.trade_date), mi.trade_date desc;
$$;

-- Last split-adjusted close of each month for a few symbols (portfolio value history).
create or replace function public.monthly_closes(p_symbols text[], p_from date)
returns table (symbol text, trade_date date, close numeric)
language sql stable security invoker set search_path = '' as $$
  select distinct on (pa.symbol, date_trunc('month', pa.trade_date)) pa.symbol::text, pa.trade_date, pa.close_adj
  from public.price_adjusted pa
  where pa.symbol = any (p_symbols) and pa.trade_date >= p_from and pa.close_adj > 0
  order by pa.symbol, date_trunc('month', pa.trade_date), pa.trade_date desc;
$$;

grant execute on function public.index_at(date[]) to anon, authenticated;
grant execute on function public.index_monthly(date) to anon, authenticated;
grant execute on function public.monthly_closes(text[], date) to anon, authenticated;
