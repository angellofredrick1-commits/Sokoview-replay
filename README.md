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

---

## The bucko-style frame

The replayer's main view is now built as a shareable frame in the bucko.ai idiom,
kept in Sokoview's own brand language (Sora, green, dot texture):

- **Editorial headline** generated live from the settings — "You put TZS 100,000/month
  into each of *CRDB Bank* and *NMB Bank* starting Jan 2018" — amounts in green,
  company names in Instrument Serif italic, the start date in grey.
- **Fixed axes.** The chart frame no longer rescales during playback: the x-axis
  spans the whole window plus ~27% of phantom future space, and the y-axis is
  pinned to the full-run ceiling, so the lines *grow across a still frame*.
- **End-of-line callouts** drawn as a Recharts `<Customized>` overlay: circled
  company logo riding the line end, numbered rank badge, 👑 on the leader, the
  value in a yellow highlighter pill, the return underneath. Callouts avoid each
  other vertically and flip to the marker's left when the right edge runs out;
  on narrow screens they collapse to logo + pill.
- **Brand-coloured lines** when two different stocks race (`brandColor()` in
  `logos.js`); same-stock comparisons keep green vs black, with callouts labelled
  by plan ("One-time" vs "Monthly top-up") instead of the company name twice.
- **Leaderboard rows** under the frame, winner tinted highlighter-yellow.
- **Quiet footer** inside the frame — letterspaced caption ("HISTORICAL PORTFOLIO
  VALUE · ADJUSTED PRICES", or "SAMPLE DATA · ILLUSTRATIVE ONLY" in demo mode)
  with the sokoview wordmark bottom-right, so every screenshot is branded.

Fonts: `index.html` now also loads Instrument Serif (italic) and IBM Plex Mono
(axis labels, tickers, captions) from Google Fonts.
