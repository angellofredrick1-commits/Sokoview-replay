# Dividend calendar

Page at `/dividends`, subscribable feed at `/dividends.ics`.

## Turn it on
1. Supabase → SQL editor → run `supabase/migrations/0009_dividend_calendar.sql`. Additive only; undo with
   `drop view public.dividend_calendar; drop table public.dividend;`. Until then the page shows "Sample data".
2. Deploy. The page uses the existing `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`.
   The feed function reads `SUPABASE_URL` (or `VITE_SUPABASE_URL`) and the publishable key, falling back to `SUPABASE_SERVICE_KEY`.

## Files
- `src/DividendCalendar.jsx`, `src/dividend-calendar.css`, `src/dividends-main.jsx`, `dividends.html` — the page (own scoped styles, no Tailwind)
- `src/lib/dividends.js` — shared logic: derived dates, split adjustment, expected dividends, calendar links, `.ics`
- `src/lib/dividendData.js` — Supabase REST reads, sample fallback, per-browser watchlist
- `src/data/seed.json` — 21 dividends with sources; also the migration seed (`npm run dividends:seed-sql`)
- `netlify/functions/dividends-ics.mjs` — the feed. `?symbols=CRDB,NMB&types=lastbuy,pay&expected=1`
- `npm run test:dividends` — checks derived dates against the CRDB, NMB and VODA notices, splits, ICS validity

## Adding a declaration
```sql
insert into public.dividend
  (symbol, fiscal_year, kind, amount, currency, announced_on, ex_date, record_date, pay_date, agm_date, verified, source_url)
values ('CRDB', 'FY2026', 'final', 100, 'TZS', '2027-04-14', '2027-05-04', '2027-05-05', '2027-06-01', null, true, 'https://dse.co.tz/...');
```
Leave unknown dates `null`. Last day to buy and ex-date are derived from books closure when missing (marked "est.").

## Notes
- Expected dividends repeat last year's cycle until announced. If last year's books-closure date has passed with
  nothing declared, the stock is listed as "usually declared by now" instead (currently NICO and TCC's interim).
- NMB amounts are stored as declared and shown per current share using splits in `corporate_action`.
- TPCC FY2025 and DSE FY2025 ex/pay dates are from secondary sources (`verified = false`).
- `corporate_action` has PAL and KCB dividends of TZS 61.59 on the same date — likely a copy error.
