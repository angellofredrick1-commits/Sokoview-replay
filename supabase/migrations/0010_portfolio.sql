-- 0010 · Portfolios
-- Each signed-in user records their own buys and sells. Holdings, profit and
-- dividends are worked out from these rows in the browser (src/lib/portfolio.js).
-- Additive only. To undo:
--   drop function public.price_on(text, date); drop table public.portfolio_txn;

create table if not exists public.portfolio_txn (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol      varchar not null references public.instrument(symbol),
  side        text not null check (side in ('buy', 'sell')),
  trade_date  date not null check (trade_date >= '2000-01-01' and trade_date <= current_date + 1),
  shares      numeric(18,4) not null check (shares > 0),
  price       numeric(14,4) not null check (price > 0),   -- per share, as actually paid/received on that date
  fees        numeric(14,2) not null default 0 check (fees >= 0),  -- total brokerage + levies for the trade
  note        text check (char_length(note) <= 280),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists portfolio_txn_user_idx on public.portfolio_txn (user_id, trade_date);

create or replace function public.portfolio_txn_touch() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists portfolio_txn_touch on public.portfolio_txn;
create trigger portfolio_txn_touch before update on public.portfolio_txn
  for each row execute function public.portfolio_txn_touch();

-- Private by design: a user can only ever see and change their own rows.
alter table public.portfolio_txn enable row level security;

drop policy if exists "own trades: read"   on public.portfolio_txn;
drop policy if exists "own trades: add"    on public.portfolio_txn;
drop policy if exists "own trades: change" on public.portfolio_txn;
drop policy if exists "own trades: delete" on public.portfolio_txn;

create policy "own trades: read"   on public.portfolio_txn for select to authenticated using ((select auth.uid()) = user_id);
create policy "own trades: add"    on public.portfolio_txn for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own trades: change" on public.portfolio_txn for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own trades: delete" on public.portfolio_txn for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.portfolio_txn from anon;
grant select, insert, update, delete on public.portfolio_txn to authenticated;

-- Closing price for a stock on a date, or the last close before it when the
-- market was shut (weekends, holidays). Raw price, not split-adjusted: it is
-- what the investor actually paid that day.
create or replace function public.price_on(p_symbol text, p_date date)
returns table (trade_date date, close numeric)
language sql stable security invoker set search_path = '' as $$
  select pd.trade_date, pd.close
  from public.price_daily pd
  where pd.symbol = upper(p_symbol)
    and pd.trade_date <= p_date
    and pd.trade_date >= p_date - 30
    and pd.close > 0
  order by pd.trade_date desc
  limit 1;
$$;

grant execute on function public.price_on(text, date) to anon, authenticated;
