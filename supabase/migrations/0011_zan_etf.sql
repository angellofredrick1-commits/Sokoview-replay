-- ============================================================================
-- migration 0011 · Zan Timiza ETF
--
-- Zan Securities' fund of funds (East African collective investment schemes),
-- NMB Bank as custodian and trustee. IPO 17 Aug - 17 Sep 2026 at TZS 100 a
-- unit; listed on the DSE around 12 Oct 2026 (Daily News, 13 Oct 2026).
--
-- Registered up front, like IEACLC-ETF and VERTEX-ETF in 0007, so it shows in
-- search, the stock page and the Portfolio stock list before its first price,
-- and so a capture under this symbol can't create a nameless row.
--
-- Symbol: ZAN-ETF. If the DSE daily report prints a different ticker, change
-- it here before running (and in src/ReportParser.jsx / scripts/parse_dse_report.py).
-- ============================================================================

insert into instrument (symbol, name, kind, currency, listed_on) values
  ('ZAN-ETF', 'Zan Timiza ETF', 'etf', 'TZS', null)
on conflict (symbol) do update set
  name     = excluded.name,
  kind     = 'etf',
  currency = excluded.currency;

-- Set the listing date once confirmed from the DSE notice, e.g.:
-- update instrument set listed_on = '2026-10-12' where symbol = 'ZAN-ETF';

-- After the first trading day is captured, check it arrived:
-- select source, trade_date, close from price_raw where symbol = 'ZAN-ETF' order by trade_date desc limit 10;
