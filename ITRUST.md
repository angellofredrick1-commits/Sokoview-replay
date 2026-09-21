# iTrust Finance schemes

iTrust serves every scheme's full history as plain JSON — no session, no token,
no scraping:

```
GET https://api.itrust.co.tz/api/fund/iGrowth
[ { "date": "9/18/2026", "netAssetValue": 284009866260.9,
    "outStandingUnits": 1114726473.1491, "navPerUnit": 254.7799,
    "salePricePerUnit": 254.7799, "repurchasePricePerUnit": 252.2321,
    "fundName": "iGrowth" }, … ]
```

| API id | symbol | history | spread on exit |
|---|---|---|---|
| `iCash` | `ICASH` | Aug 2025 → | none |
| `iGrowth` | `IGROWTH` | Aug 2025 → | 1% |
| `iSave` | `ISAVE` | Aug 2025 → | 1% |
| `iIncome` | `IINCOME` | Aug 2025 → | 1% |
| `Imaan` | `IMAAN` | Jun 2025 → | 1% |
| `iDollar` | `IDOLLAR` | Aug 2025 → | none — **priced in USD** |
| `iEACLC-ETF` | `IEACLC-ETF` | Jan 2026 → | n/a — this is NAV, not the traded price |

## Running it

```
# everything, once
/.netlify/functions/backfill-itrust?token=YOUR_TOKEN

# one scheme
/.netlify/functions/backfill-itrust?token=…&fund=iGrowth

# see what would be written without writing it
/.netlify/functions/backfill-itrust?token=…&dry=1
```

After the first run, `capture-funds` keeps them current on its own at 18:00 EAT
daily. It asks for the last 21 days each time, so a day the job was down repairs
itself on the next run.

## Three things that are not like the UTT schemes

**Dates are month-first.** iTrust writes `9/18/2026` for 18 September. Within
the first twelve days of a month that is indistinguishable from day-first, so
the function does not take the convention on trust: it scans each feed for a
date that can only be read one way and refuses the whole fund if none exists or
if the evidence points both ways. A transposed date is the one error that leaves
no trace — `3/4/2026` looks reasonable either way, and it would sit in the middle
of a replay quietly skewing the answer.

**iDollar is in dollars.** `instrument.currency` exists because of this one fund.
The replayer refuses to race it against a shilling fund rather than drawing a
chart whose gap is mostly the exchange rate.

**The ETF has two prices now.** `IEACLC-ETF` carries the traded close from the
exchange report and broker digest, and the manager's NAV from this feed. They
are different numbers and both are correct. `price_daily` reports the market
close — for a listed security that is the price. The `etf_premium` view shows
the gap, which is not published anywhere else in Tanzania because nobody else
holds both series.

## Feeds that have gone quiet

`Imaan` last published 14 Aug 2026 and the ETF NAV 17 Aug 2026, while the other
five are current. That is not an error and the backfill does not treat it as
one — it reports them under `stale_feeds`, and `source_freshness` (migration
0007) shows the same thing from the database side.
