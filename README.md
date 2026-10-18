# Sokoview

## Site map

| Address | Page | Audience |
|---|---|---|
| `/` | About Sokoview, with a live board strip and a Sign in link to `/portfolio` (reads "Open your portfolio" when a session exists). The only public page | Everyone |
| `/portfolio` | Signed-in users' own buys and sells: holdings, gains, dividends, highlights, money in vs value now, buying activity, AI insight. Needs migration 0010 and Supabase Auth (see below) | Signed in |
| `/market` | Market close and the grid of every listed share (each tile opens `/stock`), upcoming dividends, climbers since Jan 2025 (was the home page) | Signed in |
| `/dividends` | Dividend calendar; opens on **My holdings** (your dividends and amounts, from Portfolio trades) when you have trades. Deep link: `/dividends?symbol=CRDB` | Signed in |
| `/replay` | Replay. Deep link: `/replay?symbol=CRDB&from=2025` | Signed in |
| `/stock` | Stock price history, liquidity and dividends. Deep link: `/stock?symbol=NMB`. No tab of its own: reached from the Market grid and search | Signed in |
| `/capture`, `/report` | Capture monitor and DSE report parser | Admin only, not in the navigation |

The tabs, in order: Portfolio, Market, Dividends, Replay.

**Sign-in.** Everything except `/` needs a signed-in user. Each protected page checks for a stored Supabase
session in its `<head>` and, without one, goes to `/portfolio?next=<page>`; after the emailed link signs you in
you land back on that page. `SiteNav` also watches the session, so signing out or an expired session sends you
to sign-in. This controls what the site shows; the market data itself stays readable with the public key (the
landing page uses it), and the `/dividends.ics` feed stays public so calendar apps can subscribe. The gate is
skipped when the build has no `VITE_SUPABASE_URL` (sample mode). Every investor page shares one navigation bar (`src/nav/SiteNav.jsx`) with a stock search; on phones the tabs move to a bottom bar.
The Market page reads `market_snapshot()` and `growth_since_jan_2025()` from Supabase, plus the `dividend_calendar` view.

## Design language

One set of tokens in `src/theme/tokens.css` drives every investor page, in light and dark:

- **Colour**: `--sv-page`, `--sv-surface`, `--sv-ink`, `--sv-muted`, `--sv-line`, brand green `--sv-accent`, falls `--sv-down`, action dates `--sv-warn`. Tailwind pages use the same values as `bg-page`, `text-ink`, `border-line`, `bg-accent`… (mapped in `src/index.css`). Charts use `var(--sv-chart-grid)` etc. directly, so they switch with the theme.
- **Type**: Sora only. Pages open with a small green title and a sentence headline; labels are sentence case; nothing smaller than 11px.
- **Components**: black primary buttons (white in dark), green for the one main call to action, grey segmented controls, 16px-radius cards.
- **Theme**: the moon/sun button in the nav. The choice is saved per browser (`sv.theme`), follows the OS until someone picks, and is applied in each page's `<head>` before first paint.

Don't hard-code greys or white in new UI; reach for a token.


# Sokoview Replay

Replays DSE price history to compare investment approaches: a one-time investment
versus buying regularly, two stocks head to head, or any mix of the two.

## Architecture

```
browser  ──►  /api/prices        ──►  Netlify Function  ──►  Sokoview API
             (same origin,             (holds the key,        (never exposed
              no CORS)                  caches 1h)             to the browser)
```

The API key lives only in a Netlify environment variable. It is read inside the
function at request time and never reaches the client bundle. **Do not** put the
key in a `VITE_`-prefixed variable — Vite inlines those into the JavaScript that
ships to every visitor.

## Before you deploy: find your endpoint

The proxy needs to know the real path to price history. Run:

```bash
export SOKOVIEW_API_KEY='skv_...'
./discover.sh
```

It probes common route shapes and reports which ones don't 404, then checks
whether your API wants `Bearer`, `X-API-Key`, or `Token` auth. Feed the results
into `SOKOVIEW_PRICES_PATH` and `SOKOVIEW_AUTH_STYLE` below.

## Deploy

```bash
npm install
npx netlify-cli login
npx netlify init          # creates the site, links the repo
```

Set the environment variables — via the Netlify UI under
**Site configuration → Environment variables**, or on the CLI:

```bash
npx netlify env:set SOKOVIEW_API_KEY 'skv_...' --secret
npx netlify env:set SOKOVIEW_API_BASE 'https://api-staging.sokoview.co.tz'
npx netlify env:set SOKOVIEW_PRICES_PATH '/api/v1/prices'
npx netlify env:set SOKOVIEW_AUTH_STYLE 'bearer'
```

Then:

```bash
npx netlify deploy --build --prod
```

Environment variable changes need a redeploy to take effect.

## Local development

```bash
cp .env.example .env      # fill in your key; .env is gitignored
npx netlify dev           # serves the app AND the function on :8888
```

Use `netlify dev`, not `vite` — plain Vite won't run the function, so live mode
will 404. Sample-data mode works either way.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SOKOVIEW_API_KEY` | yes | — | Secret. Server-side only. |
| `SOKOVIEW_API_BASE` | no | `https://api-staging.sokoview.co.tz` | Swap for production when ready. |
| `SOKOVIEW_PRICES_PATH` | no |  `/api/v1/market/prices/{symbol}` | Use `{symbol}` for REST routes, e.g. `/api/v1/stocks/{symbol}/prices` |
| `SOKOVIEW_AUTH_STYLE` | no |  `x-api-key` | `bearer` · `x-api-key` · `token` |

## Data modes

**Sample data** is synthetic — a seeded random walk against real DSE tickers.
Useful for demos and for exercising the UI. The numbers are not real history.

**Sokoview API** pulls live data through the proxy.

**Paste JSON** accepts a raw API response directly, which is the quickest way to
sanity-check the adapter against real data before the proxy is configured.

## Adapting the response shape

`normalizeSeries()` in `src/SokoviewReplay.jsx` maps your API's response to
`[{ date, close, div }]`. It already probes the common field names
(`close`/`closing_price`/`price`/`c`, `date`/`trade_date`/`timestamp`). If your
API differs, that one function is the only thing to edit.

### Dividends

The engine reads a per-bar `div` field. If dividends come from a separate
endpoint on your API, they currently default to zero — which understates
long-run returns on dividend-paying stocks like CRDB and NMB, and will make
recurring-investment comparisons look worse than they should. Worth wiring up
as a second fetch merged into the series by date.

## Notes

- Bundle is ~583 kB (166 kB gzipped), mostly Recharts. Fine for a dashboard;
  code-split with `manualChunks` if it matters.
- Function responses are CDN-cached for an hour with a day of
  stale-while-revalidate, since DSE data is end-of-day.
- The `/api/prices` endpoint is public. It validates the symbol and date format
  before calling upstream, but add rate limiting if the site is public-facing.

## Portfolio

Users sign in with an emailed link (Supabase Auth) and enter each buy and sell. The price fills in from that day's
close (`price_on()`), or the last close before a weekend or holiday; they can change it to what they actually paid.
Everything else is worked out in the browser by `src/lib/portfolio.js` (tests: `npm run test:portfolio`):

- average-cost holdings, gain on holdings, realised gain on sales, fees included;
- splits: trades before a split are restated in today's shares (100 NMB pre-split = 1,000 now);
- dividends: entitled if held at the close before the ex-date; paid, due, and expected amounts after 5% tax;
- a sell can't exceed the shares held on its date, and a buy that a later sell depends on can't be deleted;
- highlights (top performer, weakest, biggest contributor, largest holding) and buying activity by month;
- **money in vs value now**: what went in, what came out on sales, what's held now, the return in % and a year
  (money-weighted, XIRR), with a month-end chart built from `price_adjusted` (already public, no migration needed);
- **AI insight**: `netlify/functions/portfolio-insight.mjs` sends a numeric summary (symbols, amounts, returns; never the
  email) to Claude Haiku and gets back 2–3 plain-language observations about the return over the period and what drove it. Cached in the browser for a day.

Trades are private: row-level security means a user can only read and change their own rows.

**To switch it on**
1. Run `supabase/migrations/0010_portfolio.sql` in the SQL editor.
1. Netlify → Site configuration → Environment variables: set `ANTHROPIC_API_KEY` (already needed for Replay insights).
   Without it, the AI insight card says it isn't switched on.
2. Supabase → Authentication → URL Configuration: set the Site URL to the live site and add `https://<your-site>/portfolio` to Redirect URLs (plus `http://localhost:5173/portfolio` for local work).
3. Supabase's built-in email sender is only meant for testing and sends very few emails an hour. Before inviting users, add your own SMTP under Authentication → Emails (any provider: Resend, Postmark, Amazon SES…), and adjust the "Magic link" email text if you like.
