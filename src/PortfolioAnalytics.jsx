import { useEffect, useMemo, useState } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Sparkles } from 'lucide-react';
import { SvMark, stockHref } from './nav/SiteNav.jsx';
import { valueHistory } from './lib/portfolio.js';
import { monthlyCloses, portfolioInsight } from './lib/portfolioData.js';

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const tzs = (n) => (n == null || !Number.isFinite(n) ? '—' : `TZS ${nf0.format(Math.round(n))}`);
const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}TZS ${nf0.format(Math.abs(Math.round(n)))}`);
const pct = (n, d = 1) => (n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(d)}%`);
const compact = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (mk, withYear = true) => `${MONTHS[Number(mk.slice(5)) - 1]}${withYear ? ` ${mk.slice(2, 4)}` : ''}`;
const tone = (n) => (n > 0 ? 'is-up' : n < 0 ? 'is-down' : '');
const tooltipStyle = {
  contentStyle: { borderRadius: 12, border: '1px solid var(--sv-line)', background: 'var(--sv-page)', color: 'var(--sv-ink)', fontSize: 12.5, boxShadow: 'var(--sv-shadow)' },
  labelStyle: { color: 'var(--sv-muted)', fontWeight: 600, marginBottom: 4 },
  itemStyle: { color: 'var(--sv-ink)', padding: 0 },
};
const axis = { tick: { fontSize: 11.5, fill: 'var(--sv-chart-axis)' }, axisLine: false, tickLine: false };

// ---------------------------------------------------------------------------
// Data: month-end value of the portfolio (prices from price_adjusted)
// ---------------------------------------------------------------------------
export function useValueHistory(trades, { splits, today }) {
  const [raw, setRaw] = useState({ status: 'loading' });
  const key = useMemo(() => trades.map((t) => `${t.id}:${t.symbol}:${t.side}:${t.trade_date}:${t.shares}:${t.price}:${t.fees}`).join('|'), [trades]);

  useEffect(() => {
    if (!trades.length) return undefined;
    let live = true;
    const first = trades.reduce((d, t) => (t.trade_date < d ? t.trade_date : d), today);
    const symbols = [...new Set(trades.map((t) => t.symbol))];
    monthlyCloses(symbols, `${first.slice(0, 7)}-01`)
      .then((closes) => live && setRaw({ status: 'ok', closes }))
      .catch((e) => live && setRaw({ status: 'error', message: e.message }));
    return () => { live = false; };
  }, [key, today]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => (raw.status !== 'ok' ? raw
    : { status: 'ok', history: valueHistory(trades, { splits, closes: raw.closes, today }) }), [raw, trades, splits, today]);
}

const since = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

// ---------------------------------------------------------------------------
// Money in vs value now
// ---------------------------------------------------------------------------
export function GrowthCard({ ret, hist }) {
  if (!ret) return null;
  // Today's point uses the same prices as the summary above, so the line ends where the numbers say.
  const history = (hist.status === 'ok' ? hist.history : [])
    .map((h, i, all) => (i === all.length - 1 ? { ...h, value: Math.round(ret.value) } : h));
  const showYear = history.length > 12;
  const summary = `You put in ${tzs(ret.invested)}${ret.takenOut ? ` and took out ${tzs(ret.takenOut)}` : ''} since ${since(ret.first)}; what you hold is worth ${tzs(ret.value)} now.`;
  return (
    <section className="pf-card pf-ana pf-ana--chart" aria-labelledby="pf-h-growth">
      <div className="pf-ana__head">
        <h2 id="pf-h-growth">Money in vs value now</h2>
        <span className={`pf-chip ${tone(ret.gain)}`}>{signed(ret.gain)} since {since(ret.first)}</span>
      </div>
      <dl className="pf-vs pf-vs--3">
        <div><dt><i className="pf-key pf-key--ref" />Money in</dt><dd>{tzs(ret.netIn)}</dd>
          <dd className="pf-vs__sub">{ret.takenOut ? `${tzs(ret.invested)} in, ${tzs(ret.takenOut)} out` : `over ${ret.days} days`}</dd></div>
        <div><dt><i className="pf-key pf-key--1" />Value now</dt><dd>{tzs(ret.value)}</dd>
          <dd className="pf-vs__sub">at the last close</dd></div>
        <div><dt>Return</dt><dd className={tone(ret.gainPct)}>{pct(ret.gainPct)}</dd>
          <dd className="pf-vs__sub">{ret.annual != null
            ? `${pct(ret.annual)} a year${ret.dividendsReceived > 0 && ret.annualWithDividends != null ? `, ${pct(ret.annualWithDividends)} with dividends` : ''}`
            : `too early for a yearly rate${ret.dividendsReceived > 0 ? `; ${pct(ret.gainWithDividendsPct)} with dividends` : ''}`}</dd></div>
      </dl>
      {hist.status === 'loading' && <div className="pf-skel pf-skel--chart" aria-hidden="true" />}
      {hist.status === 'error' && <p className="pf-empty">Couldn’t load past prices for the chart. Refresh to try again.</p>}
      {history.length >= 2 && (
        <div className="pf-chart" role="img" aria-label={summary}>
          <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={history} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="pf-value-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--sv-series-1)" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="var(--sv-series-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--sv-chart-grid)" vertical={false} />
              <XAxis dataKey="month" tickFormatter={(m) => monthLabel(m, showYear)} minTickGap={28} {...axis} />
              <YAxis tickFormatter={compact} width={44} {...axis} />
              <Tooltip {...tooltipStyle} labelFormatter={(m) => monthLabel(m, true)}
                formatter={(v, name) => [tzs(v), name === 'value' ? 'Value' : 'Money in']} />
              <Area type="monotone" dataKey="value" stroke="var(--sv-series-1)" strokeWidth={2} fill="url(#pf-value-fill)" dot={false} isAnimationActive={false} connectNulls />
              <Line type="stepAfter" dataKey="invested" stroke="var(--sv-chart-axis)" strokeWidth={1.5} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="pf-legend">
            <span><i className="pf-key pf-key--1" />Value of what you held</span>
            <span><i className="pf-key pf-key--ref" />Money in (buys minus sales)</span>
          </p>
        </div>
      )}
      <p className="pf-fine">Return = value now plus money taken out on sales, minus everything you put in, fees included. “A year” weights each shilling by how long it was invested.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AI insight
// ---------------------------------------------------------------------------
export function buildInsightSummary({ today, s, perf, act, ret, names }) {
  const r = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n));
  const r1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
  return {
    asOf: today,
    period: ret ? {
      firstTrade: ret.first, days: ret.days,
      putInTZS: r(ret.invested), takenOutOnSalesTZS: r(ret.takenOut), valueNowTZS: r(ret.value),
      gainTZS: r(ret.gain), returnPct: r1(ret.gainPct), annualPct: r1(ret.annual),
      dividendsReceivedTZS: r(ret.dividendsReceived), returnWithDividendsPct: r1(ret.gainWithDividendsPct), annualWithDividendsPct: r1(ret.annualWithDividends),
    } : null,
    holdings: s.holdings.map((h) => ({
      symbol: h.symbol, company: names[h.symbol] || h.symbol,
      weightPct: r1(perf?.weights?.[h.symbol]), gainPct: r1(h.unrealisedPct), gainTZS: r(h.unrealised), heldSince: h.firstDate,
    })),
    totals: {
      costOfHoldingsTZS: r(s.totals.cost), unrealisedGainPct: r1(s.totals.unrealisedPct),
      realisedOnSalesTZS: r(s.totals.realised), dividendsNext12mTZS: r(s.totals.dividendsNext12m),
    },
    activity: act ? { trades: act.trades, buys: act.buys, sells: act.sells, lastTrade: act.last, monthsWithBuys: act.activeMonths, mostBought: act.mostBought?.symbol ?? null } : null,
    best: perf?.best ? { symbol: perf.best.symbol, gainPct: r1(perf.best.unrealisedPct) } : null,
    weakest: perf?.worst ? { symbol: perf.worst.symbol, gainPct: r1(perf.worst.unrealisedPct) } : null,
  };
}

export function InsightCard({ summary, ready }) {
  const [state, setState] = useState({ status: 'idle' });
  const body = useMemo(() => (ready ? JSON.stringify(summary) : null), [summary, ready]);
  useEffect(() => {
    if (!body) return undefined;
    let live = true;
    setState({ status: 'loading' });
    portfolioInsight(JSON.parse(body))
      .then((insights) => live && setState({ status: 'ok', insights }))
      .catch((e) => live && setState({ status: 'error', message: e.message }));
    return () => { live = false; };
  }, [body]);

  return (
    <section className="pf-card pf-ana pf-ana--ai" aria-labelledby="pf-h-ai" aria-busy={state.status === 'loading'}>
      <div className="pf-ana__head"><h2 id="pf-h-ai"><Sparkles aria-hidden="true" className="pf-ai-icon" />AI insight</h2></div>
      {(state.status === 'idle' || state.status === 'loading') && (
        <div className="pf-skel-lines" aria-label="Writing your insight"><i /><i /><i /><i /></div>
      )}
      {state.status === 'ok' && (
        <ul className="pf-insights">
          {state.insights.map((x, i) => <li key={i}><b>{x.title}</b><span>{x.body}</span></li>)}
        </ul>
      )}
      {state.status === 'error' && (
        <p className="pf-empty">{/ANTHROPIC_API_KEY|503/.test(state.message) ? 'AI insight isn’t switched on for this site yet.' : 'Couldn’t write an insight right now. Refresh to try again.'}</p>
      )}
      <p className="pf-fine">Written by AI from the numbers on this page. It describes what happened; it isn’t investment advice. Only stock symbols and amounts are sent, never your email.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Highlights: top performer, weakest, biggest contributor, largest holding
// ---------------------------------------------------------------------------
export function Highlights({ perf, names }) {
  if (!perf) return null;
  const items = [
    { label: 'Top performer', h: perf.best, value: pct(perf.best.unrealisedPct), sub: signed(perf.best.unrealised), cls: tone(perf.best.unrealisedPct) },
    perf.worst && { label: 'Weakest', h: perf.worst, value: pct(perf.worst.unrealisedPct), sub: signed(perf.worst.unrealised), cls: tone(perf.worst.unrealisedPct) },
    { label: 'Biggest contributor', h: perf.contributor, value: signed(perf.contributor.unrealised), sub: 'gain in shillings', cls: tone(perf.contributor.unrealised) },
    { label: 'Largest holding', h: perf.largest, value: `${Math.round(perf.weights[perf.largest.symbol])}%`, sub: `of your portfolio, ${tzs(perf.largest.value)}`, cls: '' },
  ].filter(Boolean);
  return (
    <section className="pf-highlights" aria-label="Highlights">
      {items.map((it) => (
        <a key={it.label} className="pf-hl" href={stockHref(it.h.symbol)}>
          <span className="pf-hl__label">{it.label}</span>
          <span className="pf-hl__stock"><SvMark symbol={it.h.symbol} size={22} /><b>{it.h.symbol}</b><small>{names[it.h.symbol] || ''}</small></span>
          <span className={`pf-hl__value ${it.cls}`}>{it.value}</span>
          <span className="pf-hl__sub">{it.sub}</span>
        </a>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Buying activity
// ---------------------------------------------------------------------------
export function ActivityCard({ act, today }) {
  if (!act || !act.series.length) return null;
  // Fill empty months so quiet stretches are visible, not collapsed.
  const months = [];
  const [fy, fm] = act.series[0].month.split('-').map(Number);
  const [ty, tm] = today.slice(0, 7).split('-').map(Number);
  const byMonth = Object.fromEntries(act.series.map((m) => [m.month, m]));
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y += 1, m = 1) : (m += 1)) {
    const mk = `${y}-${String(m).padStart(2, '0')}`;
    const row = byMonth[mk];
    months.push({ month: mk, bought: row ? row.bought : 0, sold: row ? -row.sold : 0 });
  }
  const showYear = months.length > 12;
  const anySells = act.sells > 0;
  return (
    <section className="pf-section" aria-labelledby="pf-h-act">
      <div className="pf-section__head"><h2 id="pf-h-act">Buying activity</h2></div>
      <div className="pf-act">
        <dl className="pf-act__stats">
          <div><dt>Trades</dt><dd>{act.trades}<small>{act.buys} buy{act.buys === 1 ? '' : 's'}, {act.sells} sell{act.sells === 1 ? '' : 's'}</small></dd></div>
          <div><dt>Money put in</dt><dd>{tzs(act.bought)}<small>over {act.activeMonths} month{act.activeMonths === 1 ? '' : 's'} with buys</small></dd></div>
          <div><dt>Average buy</dt><dd>{tzs(act.avgBuy)}</dd></div>
          {act.mostBought && <div><dt>Most bought</dt><dd>{act.mostBought.symbol}<small>{tzs(act.mostBought.amount)} in total</small></dd></div>}
          {anySells && <div><dt>Taken out</dt><dd>{tzs(act.sold)}</dd></div>}
        </dl>
        <div className="pf-chart" role="img" aria-label={`Money put in each month since ${monthLabel(months[0].month, true)}${anySells ? ', with sales below the line' : ''}.`}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={months} stackOffset="sign" margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="18%">
              <CartesianGrid stroke="var(--sv-chart-grid)" vertical={false} />
              <XAxis dataKey="month" tickFormatter={(m) => monthLabel(m, showYear)} minTickGap={24} {...axis} />
              <YAxis tickFormatter={compact} width={44} {...axis} />
              <ReferenceLine y={0} stroke="var(--sv-line-strong)" />
              <Tooltip {...tooltipStyle} cursor={{ fill: 'var(--sv-surface-2)' }} labelFormatter={(m) => monthLabel(m, true)}
                formatter={(v, name) => [tzs(Math.abs(v)), name === 'bought' ? 'Bought' : 'Sold']} />
              <Bar dataKey="bought" stackId="a" fill="var(--sv-series-1)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
              {anySells && <Bar dataKey="sold" stackId="a" fill="var(--sv-series-2)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />}
            </BarChart>
          </ResponsiveContainer>
          <p className="pf-legend">
            <span><i className="pf-key pf-key--1" />Bought</span>
            {anySells && <span><i className="pf-key pf-key--2" />Sold</span>}
          </p>
        </div>
      </div>
    </section>
  );
}


