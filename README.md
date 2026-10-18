# Sokoview

## Site map

| Address | Page | Audience |
|---|---|---|
| `/` | Home dashboard: market close, market board, upcoming dividends, biggest climbers since Jan 2025 | Investors |
| `/replay` | Replay (was at `/`). Deep link: `/replay?symbol=CRDB&from=2025` | Investors |
| `/dividends` | Dividend calendar. Deep link: `/dividends?symbol=CRDB` | Investors |
| `/stock` | Stock price history, liquidity and dividends. Deep link: `/stock?symbol=NMB` | Investors |
| `/capture`, `/report` | Capture monitor and DSE report parser | Admin only, not in the navigation |

Every investor page shares one navigation bar (`src/nav/SiteNav.jsx`) with a stock search; on phones the tabs move to a bottom bar.
The home page reads `market_snapshot()` and `growth_since_jan_2025()` from Supabase, plus the `dividend_calendar` view.

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
