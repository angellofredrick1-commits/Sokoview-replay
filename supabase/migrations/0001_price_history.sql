-- ============================================================================
-- Sokoview price history  ·  migration 0001
-- Run in Supabase → SQL Editor.
--
-- Design rules:
--   1. price_raw is IMMUTABLE observation. Never overwrite it with adjusted
--      numbers. When you discover a missed bonus issue from 2021, you add a
--      corporate_action row and every adjusted series recomputes correctly.
--   2. source is part of the key, so your capture, the DSE report, and any
--      vendor feed can coexist for the same day. Disagreements are signal.
--   3. Adjusted prices are DERIVED, never stored as ground truth.
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Instruments
-- ---------------------------------------------------------------------------
create table if not exists instrument (
  symbol        varchar(12) primary key,
  name          text        not null,
  is_active     boolean     not null default true,
  listed_on     date,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Raw observations — append-only
-- ---------------------------------------------------------------------------
create table if not exists price_raw (
  symbol        varchar(12)   not null references instrument(symbol),
  trade_date    date          not null,
  source        varchar(24)   not null,          -- sokoview_quote | dse_report | eodhd
  close         numeric(14,2) not null,
  volume        bigint,                          -- null after close; session run fills it
  turnover      numeric(18,2),
  change        numeric(14,2),
  pct_change    numeric(10,4),
  -- upstream's own "last updated" marker. If its date < trade_date the stock
  -- did not print a trade that day.
  upstream_at   timestamptz,
  traded        boolean,                         -- derived at write time, nullable if unknown
  captured_at   timestamptz   not null default now(),
  primary key (symbol, trade_date, source)
);

create index if not exists price_raw_symbol_date_idx
  on price_raw (symbol, trade_date desc);

create index if not exists price_raw_date_idx
  on price_raw (trade_date desc);

-- ---------------------------------------------------------------------------
-- Corporate actions — the part vendors get wrong on frontier markets.
-- value semantics by kind:
--   dividend : TZS per share
--   split    : ratio, e.g. 5 means 1 share became 5
--   bonus    : ratio, e.g. 0.2 means 1 bonus share per 5 held
--   rights   : ratio of new shares per held (subscription price in extra)
-- ---------------------------------------------------------------------------
create table if not exists corporate_action (
  symbol        varchar(12)   not null references instrument(symbol),
  ex_date       date          not null,
  kind          varchar(16)   not null
                check (kind in ('dividend','split','bonus','rights')),
  value         numeric(18,6) not null,
  extra         jsonb,                           -- subscription price, books-closure date, etc.
  announced_on  date,
  source_url    text,                            -- provenance. Always fill this in.
  verified      boolean       not null default false,
  created_at    timestamptz   not null default now(),
  primary key (symbol, ex_date, kind)
);

-- ---------------------------------------------------------------------------
-- Reconciliation log — this is what makes "verified" a defensible claim
-- ---------------------------------------------------------------------------
create table if not exists reconciliation (
  id            uuid          primary key default uuid_generate_v4(),
  symbol        varchar(12)   not null,
  trade_date    date          not null,
  source_a      varchar(24)   not null,
  source_b      varchar(24)   not null,
  value_a       numeric(14,2),
  value_b       numeric(14,2),
  status        varchar(12)   not null
                check (status in ('match','mismatch','missing_a','missing_b')),
  checked_at    timestamptz   not null default now()
);

create index if not exists reconciliation_status_idx
  on reconciliation (status, trade_date desc);

-- ---------------------------------------------------------------------------
-- Preferred series: one row per symbol/day, best available source.
-- Priority: exchange report > own capture > vendor.
-- ---------------------------------------------------------------------------
create or replace view price_daily as
select distinct on (symbol, trade_date)
  symbol, trade_date, close, volume, turnover, traded, source
from price_raw
order by
  symbol,
  trade_date,
  case source
    when 'dse_report'     then 1
    when 'sokoview_quote' then 2
    else 3
  end;

-- ---------------------------------------------------------------------------
-- Split/bonus-adjusted closes.
--
-- For each row, divide by the cumulative ratio of every split/bonus with an
-- ex_date AFTER that row. A 1:5 bonus makes older prices divide by 1.2, so the
-- series stays continuous instead of showing a phantom crash.
--
-- Dividends are deliberately NOT folded in here — total-return adjustment is a
-- separate concern and the replayer models reinvestment explicitly.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Liquidity profile — arguably the scarcest thing here. Nobody publishes
-- clean DSE liquidity stats, and it falls out of daily capture for free.
-- ---------------------------------------------------------------------------
create or replace view liquidity_90d as
select
  symbol,
  count(*)                                             as days_observed,
  count(*) filter (where traded)                       as days_traded,
  round(100.0 * count(*) filter (where traded) / nullif(count(*),0), 1)
                                                       as pct_days_traded,
  sum(volume)                                          as total_volume,
  round(avg(volume) filter (where traded))             as avg_volume_on_traded_days,
  max(trade_date)                                      as last_observation
from price_daily
where trade_date >= current_date - interval '90 days'
group by symbol;

-- ---------------------------------------------------------------------------
-- Seed the DSE equity list
-- ---------------------------------------------------------------------------
insert into instrument (symbol, name) values
  ('CRDB',      'CRDB Bank'),
  ('NMB',       'NMB Bank'),
  ('TBL',       'Tanzania Breweries'),
  ('TCC',       'Tanzania Cigarette Company'),
  ('TPCC',      'Tanzania Portland Cement (Twiga)'),
  ('TCCL',      'Tanga Cement'),
  ('DSE',       'Dar es Salaam Stock Exchange'),
  ('SWIS',      'Swissport Tanzania'),
  ('VODA',      'Vodacom Tanzania'),
  ('TOL',       'TOL Gases'),
  ('JATU',      'Jatu PLC'),
  ('DCB',       'DCB Commercial Bank'),
  ('MBP',       'Maendeleo Bank'),
  ('MCB',       'Mwalimu Commercial Bank'),
  ('MKCB',      'Mkombozi Commercial Bank'),
  ('MUCOBA',    'Mucoba Bank'),
  ('YETU',      'Yetu Microfinance'),
  ('NICO',      'National Investment Company'),
  ('PAL',       'Precision Air Services'),
  ('SWALA',     'Swala Gas and Oil'),
  ('TTP',       'Tatepa Company'),
  ('USL',       'Uchumi Supermarket'),
  ('AFRIPRISE', 'Afriprise Investment'),
  ('EABL',      'East African Breweries'),
  ('JHL',       'Jubilee Holdings'),
  ('KA',        'Kenya Airways'),
  ('KCB',       'Kenya Commercial Bank'),
  ('NMG',       'Nation Media Group')
on conflict (symbol) do nothing;

-- ---------------------------------------------------------------------------
-- Row-level security: public may read, only the service key may write.
-- ---------------------------------------------------------------------------
alter table price_raw        enable row level security;
alter table corporate_action enable row level security;
alter table instrument       enable row level security;

create policy "public read prices"  on price_raw        for select using (true);
create policy "public read actions" on corporate_action for select using (true);
create policy "public read instr"   on instrument       for select using (true);
-- No insert/update policies: the service role bypasses RLS, everyone else can't write.
