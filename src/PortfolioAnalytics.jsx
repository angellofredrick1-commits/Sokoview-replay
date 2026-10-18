import { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Sparkles } from 'lucide-react';
import { SvMark, stockHref } from './nav/SiteNav.jsx';
import { activity, performers, valueHistory, vsBenchmark } from './lib/portfolio.js';
import { SetupError, indexAt, indexMonthly, monthlyCloses, portfolioInsight } from './lib/portfolioData.js';

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
// Data: benchmark comparison + value history (needs migration 0011)
// ---------------------------------------------------------------------------
export function useBenchmark(trades, { splits, today, value, dividendRows, dividendsReceived }) {
  const [raw, setRaw] = useState({ status: 'loading' });
  const key = useMemo(() => trades.map((t) => `${t.id}:${t.symbol}:${t.side}:${t.trade_date}:${t.shares}:${t.price}:${t.fees}`).join('|'), [trades]);

  useEffect(() => {
    if (!trades.length) return undefined;
    let live = true;
    const first = trades.reduce((d, t) => (t.trade_date < d ? t.trade_date : d), today);
    const symbols = [...new Set(trades.map((t) => t.symbol))];
    setRaw((r) => ({ ...r, status: r.status === 'ok' ? 'ok' : 'loading' }));
    Promise.all([
      indexAt([...trades.map((t) => t.trade_date), today]),
      indexMonthly(`${first.slice(0, 7)}-01`),
      monthlyCloses(symbols, `${first.slice(0, 7)}-01`),
    ]).then(([at, monthly, closes]) => {
      if (!live) return;
      const last = monthly[monthly.length - 1];
      setRaw({
        status: 'ok', at, closes,
        monthly: Object.fromEntries(monthly.map((m) => [m.date.slice(0, 7), m.level])),
        now: at[today] ? { date: last?.date ?? today, level: at[today] } : null,
      });
    }).catch((e) => live && setRaw({ status: e instanceof SetupError ? 'missing' : 'error', message: e.message }));
    return () => { live = false; };
  }, [key, today]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    if (raw.status !== 'ok') return raw;
    const vb = vsBenchmark(trades, { splits, value, today, indexAt: raw.at, indexNow: raw.now, dividendsReceived, dividendRows });
    const history = valueHistory(trades, { splits, closes: raw.closes, indexMonthly: raw.monthly, indexAt: raw.at, today });
    return { status: vb ? 'ok' : 'error', vb, history };
  }, [raw, trades, splits, value, today, dividendRows, dividendsReceived]);
}

// ---------------------------------------------------------------------------
// Against the DSE benchmark
// ---------------------------------------------------------------------------
export function BenchmarkCard({ bench }) {
  if (bench.status === 'loading') return <section className="pf-card pf-ana pf-ana--chart"><div className="pf-skel pf-skel--chart" aria-hidden="true" /></section>;
  if (bench.status === 'missing') {
    return (
      <section className="pf-card pf-ana pf-ana--chart">
        <h2>Against the DSE</h2>
        <p className="pf-empty">The DSE benchmark isn’t set up yet: run <code>supabase/migrations/0011_market_benchmark.sql</code>.</p>
      </section>
    );
  }
  if (bench.status !== 'ok') {
    return <section className="pf-card pf-ana pf-ana--chart"><h2>Against the DSE</h2><p className="pf-empty">Couldn’t load the DSE benchmark. Refresh to try again.</p></section>;
  }
  const { vb, history } = bench;
  const ahead = vb.edge >= 0;
  const last = history[history.length - 1];
  const showYear = history.length > 12;
  const summary = `Your portfolio is worth ${tzs(vb.value)}; the same money in the DSE benchmark would be worth ${tzs(vb.benchValue)}.`;
  return (
    <section className="pf-card pf-ana pf-ana--chart" aria-labelledby="pf-h-bench">
      <div className="pf-ana__head">
        <h2 id="pf-h-bench">Against the DSE</h2>
        <span className={`pf-chip ${ahead ? 'is-up' : 'is-down'}`}>{ahead ? 'Ahead' : 'Behind'} by {tzs(Math.abs(vb.edge))}</span>
      </div>
      <dl className="pf-vs">
        <div><dt><i className="pf-key pf-key--1" />You</dt><dd className={tone(vb.gainYou)}>{signed(vb.gainYou)} <small>{pct(vb.gainYouPct)}</small></dd>
          {vb.annualYou != null && <dd className="pf-vs__sub">{pct(vb.annualYou)} a year{vb.annualYouWithDividends != null ? `, ${pct(vb.annualYouWithDividends)} with dividends` : ''}</dd>}</div>
        <div><dt><i className="pf-key pf-key--2" />Same money in the DSE</dt><dd className={tone(vb.gainIdx)}>{signed(vb.gainIdx)} <small>{pct(vb.gainIdxPct)}</small></dd>
          {vb.annualIdx != null && <dd className="pf-vs__sub">{pct(vb.annualIdx)} a year</dd>}</div>
      </dl>
      {history.length >= 2 && (
        <div className="pf-chart" role="img" aria-label={summary}>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={history} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--sv-chart-grid)" vertical={false} />
              <XAxis dataKey="month" tickFormatter={(m) => monthLabel(m, showYear)} minTickGap={28} {...axis} />
              <YAxis tickFormatter={compact} width={44} {...axis} />
              <Tooltip {...tooltipStyle} labelFormatter={(m) => monthLabel(m, true)}
                formatter={(v, name) => [tzs(v), { portfolio: 'Your portfolio', benchmark: 'Same money in the DSE', invested: 'Money in' }[name]]} />
              <Line type="stepAfter" dataKey="invested" stroke="var(--sv-chart-axis)" strokeWidth={1.5} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="benchmark" stroke="var(--sv-series-2)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="portfolio" stroke="var(--sv-series-1)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
          <p className="pf-legend">
            <span><i className="pf-key pf-key--1" />Your portfolio {last?.portfolio != null && <b>{compact(last.portfolio)}</b>}</span>
            <span><i className="pf-key pf-key--2" />Same money in the DSE {last?.benchmark != null && <b>{compact(last.benchmark)}</b>}</span>
            <span><i className="pf-key pf-key--ref" />Money in</span>
          </p>
        </div>
      )}
      <p className="pf-fine">Benchmark: every Tanzanian-listed company weighted by market value, like the TSI. Price only, so the fair comparison leaves your dividends out; they’re added separately above.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AI insight
// ---------------------------------------------------------------------------
export function buildInsightSummary({ today, s, perf, act, bench, names }) {
  const r = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n));
  const r1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
  return {
    asOf: today,
    holdings: s.holdings.map((h) => ({
      symbol: h.symbol, company: names[h.symbol] || h.symbol,
      weightPct: r1(perf?.weights?.[h.symbol]), gainPct: r1(h.unrealisedPct), gainTZS: r(h.unrealised), heldSince: h.firstDate,
    })),
    totals: {
      valueTZS: r(s.totals.value), costTZS: r(s.totals.cost), gainPct: r1(s.totals.unrealisedPct),
      realisedOnSalesTZS: r(s.totals.realised), dividendsReceivedTZS: r(s.totals.dividendsReceived), dividendsNext12mTZS: r(s.totals.dividendsNext12m),
    },
    benchmark: bench?.status === 'ok' ? {
      description: 'Same shillings into the DSE benchmark on the same trade dates; price only',
      investedTZS: r(bench.vb.invested), yourGainTZS: r(bench.vb.gainYou), benchmarkGainTZS: r(bench.vb.gainIdx), differenceTZS: r(bench.vb.edge),
      yourGainPct: r1(bench.vb.gainYouPct), benchmarkGainPct: r1(bench.vb.gainIdxPct),
      yourAnnualPct: r1(bench.vb.annualYou), yourAnnualWithDividendsPct: r1(bench.vb.annualYouWithDividends), benchmarkAnnualPct: r1(bench.vb.annualIdx),
    } : null,
    activity: act ? { trades: act.trades, buys: act.buys, sells: act.sells, firstTrade: act.first, lastTrade: act.last, monthsWithBuys: act.activeMonths, mostBought: act.mostBought?.symbol ?? null } : null,
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


