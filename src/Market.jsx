import { useEffect, useMemo, useState } from 'react';
import SiteNav, { PageIntro, SvMark, dividendsHref, replayHref, stockHref } from './nav/SiteNav.jsx';
import { loadMarket } from './lib/marketData.js';
import { loadCalendarData } from './lib/dividendData.js';
import {
  EVENT_TYPES, adjustedAmount, calendarDividends, daysBetween, formatAmount, fromISO, toEvents, todayISO,
} from './lib/dividends.js';
import './home.css';

const fmt = (s, opts) => fromISO(s).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
const nf = new Intl.NumberFormat('en-US');
const pct = (n, d = 1) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(d)}%`;

function urlToday() {
  const q = new URLSearchParams(window.location.search).get('today');
  return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayISO();
}

// ---------- hero ----------
function MarketIntro({ snapshot }) {
  const date = snapshot.reduce((d, r) => (r.trade_date > d ? r.trade_date : d), '');
  const up = snapshot.filter((r) => r.pct_change > 0).length;
  const down = snapshot.filter((r) => r.pct_change < 0).length;
  const flat = snapshot.length - up - down;
  const biggest = snapshot.filter((r) => r.pct_change).sort((a, b) => Math.abs(b.pct_change) - Math.abs(a.pct_change))[0];
  return (
    <PageIntro title={`Market close, ${date ? fmt(date, { weekday: 'short', day: 'numeric', month: 'short' }) : '—'}`}>
      <b>{up}</b> up, <b>{down}</b> down, <b>{flat}</b> unchanged.
      {biggest && <> Biggest move <a href={stockHref(biggest.symbol)}><b>{biggest.symbol}</b></a> {pct(biggest.pct_change)}.</>}
    </PageIntro>
  );
}

// ---------- market board ----------
function tint(p) {
  if (!p) return undefined;
  const a = Math.min(0.1 + (Math.abs(p) / 6) * 0.45, 0.55);
  return { background: p > 0 ? `rgba(34, 197, 94, ${a})` : `rgba(239, 68, 68, ${a})` };
}

function MarketBoard({ snapshot }) {
  const [sort, setSort] = useState('az');
  const rows = useMemo(() => {
    const r = [...snapshot];
    if (sort === 'move') r.sort((a, b) => (b.pct_change || 0) - (a.pct_change || 0) || a.symbol.localeCompare(b.symbol));
    else r.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return r;
  }, [snapshot, sort]);

  return (
    <section className="hm-board" aria-labelledby="hm-board-h">
      <div className="hm-section-head">
        <h2 id="hm-board-h">All stocks</h2>
        <div className="hm-seg" role="group" aria-label="Sort">
          <button type="button" aria-pressed={sort === 'az'} onClick={() => setSort('az')}>A–Z</button>
          <button type="button" aria-pressed={sort === 'move'} onClick={() => setSort('move')}>Biggest rise</button>
        </div>
      </div>
      <ul className="hm-board__grid">
        {rows.map((r) => (
          <li key={r.symbol}>
            <a className={`hm-tile${r.pct_change > 0 ? ' is-up' : r.pct_change < 0 ? ' is-down' : ''}`} href={stockHref(r.symbol)}
              style={tint(r.pct_change)} title={r.name}
              aria-label={`${r.symbol}, ${r.name}, TZS ${nf.format(r.close)}, ${r.pct_change ? pct(r.pct_change) : 'unchanged'}`}>
              <span className="hm-tile__top">
                <SvMark symbol={r.symbol} size={22} />
                <b>{r.symbol}</b>
              </span>
              <span className="hm-tile__close">{nf.format(r.close)}</span>
              <span className="hm-tile__chg">{r.pct_change ? pct(r.pct_change) : 'unchanged'}</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="hm-note">Closing prices in TZS. Tap a stock for its price history, dividends and a Replay.</p>
    </section>
  );
}

// ---------- dividends ----------
function DividendsPanel({ cal, today }) {
  const upcoming = useMemo(() => {
    if (!cal) return [];
    const divs = calendarDividends(cal.dividends, { today, splits: cal.splits });
    return toEvents(divs, { splits: cal.splits, types: ['lastbuy', 'pay'], today })
      .filter((e) => e.date >= today)
      .slice(0, 5);
  }, [cal, today]);

  return (
    <section className="hm-panel" aria-labelledby="hm-div-h">
      <div className="hm-section-head">
        <h2 id="hm-div-h">Coming up: dividends</h2>
        <a className="hm-more" href={dividendsHref()}>Calendar</a>
      </div>
      {!cal ? <p className="hm-empty">Loading…</p> : !upcoming.length ? (
        <p className="hm-empty">Nothing scheduled. New declarations appear in the calendar as they're announced.</p>
      ) : (
        <ul className="hm-list">
          {upcoming.map((e) => {
            const d = e.dividend;
            const n = daysBetween(today, e.date);
            const amt = d.expected ? formatAmount(d.based_on?.amount, d.currency) : formatAmount(adjustedAmount(d, cal.splits), d.currency);
            return (
              <li key={e.id}>
                <a href={dividendsHref(d.symbol)} className="hm-row">
                  <span className={`hm-date hm-date--${e.type}`}>
                    <b>{Number(e.date.slice(8))}</b><small>{fmt(e.date, { month: 'short' })}</small>
                  </span>
                  <span className="hm-row__text">
                    <span className="hm-row__title">{d.symbol} <span className={`hm-type hm-type--${e.type}`}>{EVENT_TYPES[e.type].label}</span></span>
                    <span className="hm-row__meta">
                      {d.expected ? `Expected, last time ${amt}` : `${amt} a share`}
                      {n <= 60 ? `, ${n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`}` : ''}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------- replay ----------
function ReplayPanel({ growth }) {
  const top = growth.filter((g) => g.pct_change != null).sort((a, b) => b.pct_change - a.pct_change).slice(0, 5);
  const from = top[0]?.start_date ? Number(top[0].start_date.slice(0, 4)) : 2025;
  return (
    <section className="hm-panel" aria-labelledby="hm-rep-h">
      <div className="hm-section-head">
        <h2 id="hm-rep-h">If you'd bought in January {from}</h2>
        <a className="hm-more" href="/replay">Replay</a>
      </div>
      {!top.length ? <p className="hm-empty">Price history isn't available yet.</p> : (
        <ul className="hm-list">
          {top.map((g) => (
            <li key={g.symbol}>
              <a href={replayHref(g.symbol, from)} className="hm-row">
                <SvMark symbol={g.symbol} size={32} />
                <span className="hm-row__text">
                  <span className="hm-row__title">{g.symbol}</span>
                  <span className="hm-row__meta">TZS {nf.format(g.start_close)} then, {nf.format(g.latest_close)} now</span>
                </span>
                <span className="hm-growth">{pct(g.pct_change, 0)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="hm-note">Price change only, before fees and dividends. Tap one to replay it month by month.</p>
    </section>
  );
}

export default function Market() {
  const today = useMemo(urlToday, []);
  const [market, setMarket] = useState(null);
  const [cal, setCal] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadMarket().then(setMarket).catch((e) => setError(e.message || String(e)));
    loadCalendarData().then(setCal).catch(() => setCal({ dividends: [], splits: [] }));
  }, []);

  return (
    <div className="hm">
      <SiteNav active="market" />
      <main className="hm-main">
        {error && <p className="hm-banner">Couldn't load today's prices: {error}. Refresh to try again.</p>}
        {market?.mode === 'sample' && <p className="hm-banner hm-banner--quiet">Sample data. Set the Supabase variables to show live prices.</p>}
        {!market && !error && <div className="hm-skeleton" aria-hidden="true" />}
        {market && market.snapshot.length > 0 && <MarketIntro snapshot={market.snapshot} />}
        {market && market.snapshot.length > 0 && <MarketBoard snapshot={market.snapshot} />}
        <div className="hm-columns">
          <DividendsPanel cal={cal} today={today} />
          {market && <ReplayPanel growth={market.growth} />}
        </div>
        <footer className="hm-foot">
          Prices from the Dar es Salaam Stock Exchange via Sokoview. Not investment advice.
        </footer>
      </main>
    </div>
  );
}
