import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LogOut, Pencil, Plus, Trash2, X } from 'lucide-react';
import SiteNav, { PageIntro, SvMark, dividendsHref, stockHref } from './nav/SiteNav.jsx';
import { loadInstruments } from './lib/marketData.js';
import { loadCalendarData } from './lib/dividendData.js';
import { checkTrade, positions, splitFactor, summarise, WITHHOLDING } from './lib/portfolio.js';
import { fromISO, todayISO } from './lib/dividends.js';
import {
  SetupError, configured, deleteTrade, getSession, latestPrices, listTrades, onAuthChange,
  priceOn, saveTrade, sendSignInLink, signOut,
} from './lib/portfolioData.js';
import { ActivityCard, BenchmarkCard, Highlights, InsightCard, buildInsightSummary, useBenchmark } from './PortfolioAnalytics.jsx';
import { activity, performers } from './lib/portfolio.js';
import './portfolio.css';

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const tzs = (n, cur = 'TZS') => (n == null || !Number.isFinite(n) ? '—' : `${cur} ${nf0.format(Math.round(n))}`);
const price = (n) => (n == null ? '—' : nf2.format(n));
const signed = (n, cur = 'TZS') => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${cur} ${nf0.format(Math.abs(Math.round(n)))}`);
const pct = (n) => (n == null ? '' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`);
const tone = (n) => (n > 0 ? 'is-up' : n < 0 ? 'is-down' : '');
const day = (s, o = { day: 'numeric', month: 'short', year: 'numeric' }) => fromISO(s).toLocaleDateString('en-GB', { timeZone: 'UTC', ...o });

function urlToday() {
  const q = new URLSearchParams(window.location.search).get('today');
  return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayISO();
}

// ---------- signed out ----------
function SignIn() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState({ status: 'idle' });
  const submit = async (e) => {
    e.preventDefault();
    setState({ status: 'sending' });
    try { await sendSignInLink(email.trim()); setState({ status: 'sent', email: email.trim() }); }
    catch (err) { setState({ status: 'error', message: err.message }); }
  };
  return (
    <section className="pf-card pf-signin" aria-labelledby="pf-signin-h">
      <h2 id="pf-signin-h">Track your DSE portfolio</h2>
      <p>Enter your buys and sells; Sokoview works out what you hold, your gain, and the dividends coming to you. Only you can see your trades.</p>
      {state.status === 'sent' ? (
        <p className="pf-note pf-note--ok" role="status">Check your email. We sent a sign-in link to <b>{state.email}</b>. Open it on this device.</p>
      ) : (
        <form onSubmit={submit} className="pf-signin__form">
          <label className="pf-sr" htmlFor="pf-email">Email</label>
          <input id="pf-email" type="email" required autoComplete="email" placeholder="you@example.com"
            value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="pf-btn pf-btn--accent" disabled={state.status === 'sending'}>
            {state.status === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
          </button>
        </form>
      )}
      {state.status === 'error' && <p className="pf-note pf-note--bad" role="alert">{state.message}</p>}
    </section>
  );
}

// ---------- trade form ----------
const KIND_LABEL = { equity: 'Stocks', etf: 'ETFs', fund: 'Unit trusts' };

function TradeSheet({ initial, trades, splits, instruments, today, onClose, onSaved }) {
  const editing = Boolean(initial?.id);
  const [side, setSide] = useState(initial?.side || 'buy');
  const [symbol, setSymbol] = useState(initial?.symbol || '');
  const [date, setDate] = useState(initial?.trade_date || today);
  const [shares, setShares] = useState(initial ? String(initial.shares) : '');
  const [px, setPx] = useState(initial ? String(initial.price) : '');
  const [pxTouched, setPxTouched] = useState(editing);
  const [fees, setFees] = useState(initial?.fees ? String(initial.fees) : '');
  const [note, setNote] = useState(initial?.note || '');
  const [lookup, setLookup] = useState({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    ref.current?.querySelector('select, input')?.focus();
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    document.body.classList.add('pf-noscroll');
    return () => { document.removeEventListener('keydown', esc); document.body.classList.remove('pf-noscroll'); };
  }, [onClose]);

  // Fill the price from that day's close, unless the user has typed their own.
  useEffect(() => {
    if (!symbol || !date || date > today) { setLookup({ status: 'idle' }); return undefined; }
    let live = true;
    setLookup({ status: 'loading' });
    priceOn(symbol, date)
      .then((r) => {
        if (!live) return;
        setLookup(r ? { status: 'ok', ...r } : { status: 'none' });
        if (r && !pxTouched) setPx(String(r.close));
      })
      .catch(() => live && setLookup({ status: 'error' }));
    return () => { live = false; };
  }, [symbol, date, today]); // eslint-disable-line react-hooks/exhaustive-deps

  const nShares = Number(shares); const nPx = Number(px); const nFees = Number(fees || 0);
  const gross = nShares > 0 && nPx > 0 ? nShares * nPx : null;
  const total = gross == null ? null : side === 'buy' ? gross + nFees : gross - nFees;
  const holding = symbol ? positions(trades.filter((t) => t.symbol === symbol && t.id !== initial?.id), splits, { asOf: date })[symbol]?.shares ?? 0 : 0;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!symbol) return setError('Pick a stock.');
    if (!date || date > today) return setError('Pick a date on or before today.');
    if (!(nShares > 0)) return setError('Enter how many shares.');
    if (!(nPx > 0)) return setError('Enter the price per share.');
    if (nFees < 0) return setError('Fees can’t be negative.');
    const candidate = { id: initial?.id, symbol, side, trade_date: date, shares: nShares, price: nPx, fees: nFees, note: note.trim() };
    const problem = checkTrade(candidate, trades, splits);
    if (problem) return setError(problem);
    setSaving(true);
    try { onSaved(await saveTrade(candidate)); }
    catch (err) { setError(err.message); setSaving(false); }
  };

  const grouped = ['equity', 'etf', 'fund'].map((k) => ({ k, items: instruments.filter((i) => i.kind === k) })).filter((g) => g.items.length);

  return (
    <div className="pf-sheet-wrap" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="pf-sheet" role="dialog" aria-modal="true" aria-labelledby="pf-trade-h" ref={ref} onSubmit={submit} noValidate>
        <button type="button" className="pf-sheet__close" onClick={onClose} aria-label="Close"><X aria-hidden="true" /></button>
        <h2 id="pf-trade-h">{editing ? 'Edit trade' : 'Add a trade'}</h2>

        <div className="pf-seg pf-seg--wide" role="group" aria-label="Buy or sell">
          <button type="button" aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>Buy</button>
          <button type="button" aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>Sell</button>
        </div>

        <label className="pf-field">
          <span>Stock</span>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)} required>
            <option value="" disabled>Choose a stock</option>
            {grouped.map((g) => (
              <optgroup key={g.k} label={KIND_LABEL[g.k]}>
                {g.items.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol} · {i.name}</option>)}
              </optgroup>
            ))}
          </select>
          {side === 'sell' && symbol && <small>You held {nf2.format(holding)} {symbol} shares on that date.</small>}
        </label>

        <div className="pf-row">
          <label className="pf-field">
            <span>Date</span>
            <input type="date" value={date} max={today} min="2000-01-01" onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label className="pf-field">
            <span>Shares</span>
            <input inputMode="decimal" value={shares} placeholder="0" onChange={(e) => setShares(e.target.value.replace(/[^\d.]/g, ''))} required />
          </label>
        </div>

        <label className="pf-field">
          <span>Price per share (TZS)</span>
          <input inputMode="decimal" value={px} placeholder="0"
            onChange={(e) => { setPx(e.target.value.replace(/[^\d.]/g, '')); setPxTouched(true); }} required />
          <small aria-live="polite">
            {lookup.status === 'loading' && 'Looking up that day’s close…'}
            {lookup.status === 'ok' && (
              <>
                {lookup.date === date ? 'Close that day' : `Last close before that date (${day(lookup.date, { weekday: 'short', day: 'numeric', month: 'short' })})`}: TZS {price(lookup.close)}.
                {Number(px) !== lookup.close
                  ? <> <button type="button" className="pf-link" onClick={() => { setPx(String(lookup.close)); setPxTouched(false); }}>Use it</button></>
                  : ' Change it if you paid a different price.'}
              </>
            )}
            {lookup.status === 'none' && 'No closing price on record for that date. Enter what you paid.'}
            {lookup.status === 'error' && 'Couldn’t look up the price. Enter what you paid.'}
          </small>
        </label>

        <div className="pf-row">
          <label className="pf-field">
            <span>Fees (TZS, optional)</span>
            <input inputMode="decimal" value={fees} placeholder="0" onChange={(e) => setFees(e.target.value.replace(/[^\d.]/g, ''))} />
            <small>Brokerage and levies from your contract note.</small>
          </label>
          <label className="pf-field">
            <span>Note (optional)</span>
            <input value={note} maxLength={280} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>

        <p className="pf-total">
          {total == null ? ' ' : <>{side === 'buy' ? 'You paid' : 'You received'} <b>{tzs(total)}</b></>}
        </p>
        {error && <p className="pf-note pf-note--bad" role="alert">{error}</p>}
        <div className="pf-sheet__actions">
          <button type="button" className="pf-btn pf-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="pf-btn" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : side === 'buy' ? 'Add buy' : 'Add sell'}</button>
        </div>
      </form>
    </div>
  );
}

// ---------- signed in ----------
function Stat({ label, value, sub, className = '' }) {
  return (
    <div className={`pf-stat ${className}`}>
      <span className="pf-stat__label">{label}</span>
      <span className="pf-stat__value">{value}</span>
      {sub && <span className="pf-stat__sub">{sub}</span>}
    </div>
  );
}

const STATUS = {
  due: 'Confirmed: you held on the ex-date',
  'if-held': null, // built per row
  expected: 'Expected, not announced yet',
  received: 'Paid',
};

function DividendRows({ rows, today }) {
  return (
    <ul className="pf-list">
      {rows.map((r) => (
        <li key={r.id}>
          <a className="pf-divrow" href={dividendsHref(r.symbol)}>
            <span className={`pf-date${r.status === 'received' ? ' is-past' : ''}${r.status === 'expected' ? ' is-expected' : ''}`}>
              <b>{Number(r.payDate.slice(8))}</b><small>{day(r.payDate, { month: 'short' })}{r.payDate.slice(0, 4) !== today.slice(0, 4) ? ` ${r.payDate.slice(2, 4)}` : ''}</small>
            </span>
            <span className="pf-divrow__text">
              <span className="pf-divrow__title">{r.symbol} <b>{tzs(r.net, r.currency)}</b></span>
              <span className="pf-divrow__meta">
                {nf2.format(r.shares)} shares × {r.currency} {price(r.perShare)}, after {WITHHOLDING * 100}% tax.{' '}
                {r.status === 'if-held' ? `Hold until ${day(r.lastBuy || r.exDate, { day: 'numeric', month: 'short' })} to qualify.` : STATUS[r.status]}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Dashboard({ trades, setTrades, splits, prices, dividends, instruments, today, dataReady, onAdd, onEdit }) {
  const s = useMemo(() => summarise(trades, { splits, prices, dividends, today }), [trades, splits, prices, dividends, today]);
  const [showReceived, setShowReceived] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const names = useMemo(() => Object.fromEntries(instruments.map((i) => [i.symbol, i.name])), [instruments]);

  const upcoming = s.dividends.filter((r) => r.status !== 'received');
  const received = s.dividends.filter((r) => r.status === 'received').reverse();
  const t = s.totals;
  const perf = useMemo(() => performers(s.holdings), [s.holdings]);
  const act = useMemo(() => activity(trades), [trades]);
  const bench = useBenchmark(trades, { splits, today, value: t.value, dividendRows: s.dividends, dividendsReceived: t.dividendsReceived });
  const benchSettled = bench.status !== 'loading';
  const insightSummary = useMemo(() => buildInsightSummary({ today, s, perf, act, bench, names }), [today, s, perf, act, bench, names]);

  const remove = async (trade) => {
    setErr(null);
    const others = trades.filter((x) => x.id !== trade.id);
    const p = positions(others.filter((x) => x.symbol === trade.symbol), splits)[trade.symbol];
    if (p?.problems?.length) { setErr(`Can’t delete: ${p.problems[0].message} Delete or change that sell first.`); setConfirming(null); return; }
    setBusy(trade.id);
    try { await deleteTrade(trade.id); setTrades(others); }
    catch (e) { setErr(e.message); }
    setBusy(null); setConfirming(null);
  };

  return (
    <>
      <section className="pf-stats" aria-label="Summary">
        <Stat label="Value at last close" value={tzs(t.value)} sub={`Cost ${tzs(t.cost)}`} />
        <Stat label="Gain on holdings" value={signed(t.unrealised)} sub={pct(t.unrealisedPct) || ' '} className={tone(t.unrealised)} />
        <Stat label="Dividends received" value={tzs(t.dividendsReceived)} sub="after tax" />
        <Stat label="Dividends, next 12 months" value={tzs(t.dividendsNext12m)} sub="declared and expected, after tax" />
      </section>
      <p className="pf-subline">
        Realised on sales <b className={tone(t.realised)}>{signed(t.realised)}</b>. Total return, including dividends <b className={tone(t.totalReturn)}>{signed(t.totalReturn)}</b>.
        {s.unpriced.length > 0 && ` No recent price for ${s.unpriced.join(', ')}, so ${s.unpriced.length > 1 ? 'they are' : 'it is'} left out of the value.`}
      </p>

      {s.problems.length > 0 && (
        <p className="pf-note pf-note--bad" role="alert">
          {s.problems[0].symbol}: {s.problems[0].message} Check that sell, or add the buy that came before it.
        </p>
      )}
      {err && <p className="pf-note pf-note--bad" role="alert">{err}</p>}

      {trades.length > 0 && (
        <>
          <Highlights perf={perf} names={names} />
          <div className="pf-ana-grid">
            <BenchmarkCard bench={bench} />
            <InsightCard summary={insightSummary} ready={dataReady && benchSettled && s.holdings.some((h) => h.value != null)} />
          </div>
        </>
      )}

      <section className="pf-section" aria-labelledby="pf-h-hold">
        <div className="pf-section__head"><h2 id="pf-h-hold">Holdings</h2></div>
        {s.holdings.length === 0 ? <p className="pf-empty">You don’t hold anything right now. Add a buy to start.</p> : (
          <div className="pf-tablewrap">
            <table className="pf-table">
              <thead>
                <tr><th scope="col">Stock</th><th scope="col">Shares</th><th scope="col">Avg cost</th><th scope="col">Last close</th><th scope="col">Value</th><th scope="col">Gain</th></tr>
              </thead>
              <tbody>
                {s.holdings.map((h) => (
                  <tr key={h.symbol}>
                    <th scope="row">
                      <a href={stockHref(h.symbol)} className="pf-stock">
                        <SvMark symbol={h.symbol} size={28} />
                        <span><b>{h.symbol}</b><small>{names[h.symbol] || ''}</small></span>
                      </a>
                    </th>
                    <td data-label="Shares">{nf2.format(h.shares)}</td>
                    <td data-label="Avg cost">{price(h.avgCost)}</td>
                    <td data-label="Last close">{price(h.last)}</td>
                    <td data-label="Value"><b>{tzs(h.value)}</b></td>
                    <td data-label="Gain" className={tone(h.unrealised)}>{signed(h.unrealised)}<small>{pct(h.unrealisedPct)}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(() => {
          const split = [...new Set(trades.filter((tr) => splitFactor(tr.symbol, tr.trade_date, splits) > 1).map((tr) => tr.symbol))];
          if (!split.length) return null;
          const notes = split.map((sym) => {
            const sp = splits.filter((x) => x.symbol === sym).sort((a, b) => (a.ex_date < b.ex_date ? 1 : -1))[0];
            return `${sym} split 1-for-${nf2.format(sp.ratio)} on ${day(sp.ex_date)}`;
          });
          return <p className="pf-subline">{notes.join('; ')}. Shares bought before that are counted in today’s shares, so the number held and the average cost differ from your contract note.</p>;
        })()}
        {s.closed.length > 0 && (
          <p className="pf-subline">Sold out of {s.closed.map((c) => `${c.symbol} (${signed(c.realised)})`).join(', ')}.</p>
        )}
      </section>

      <section className="pf-section" aria-labelledby="pf-h-div">
        <div className="pf-section__head">
          <h2 id="pf-h-div">Your dividends</h2>
          {received.length > 0 && (
            <button type="button" className="pf-link" onClick={() => setShowReceived((v) => !v)} aria-expanded={showReceived}>
              {showReceived ? 'Hide' : 'Show'} paid ({received.length})
            </button>
          )}
        </div>
        {upcoming.length ? <DividendRows rows={upcoming} today={today} /> : <p className="pf-empty">Nothing coming up for what you hold.</p>}
        {showReceived && received.length > 0 && <><h3 className="pf-h3">Paid to you</h3><DividendRows rows={received} today={today} /></>}
      </section>

      <ActivityCard act={act} today={today} />

      <section className="pf-section" aria-labelledby="pf-h-trades">
        <div className="pf-section__head">
          <h2 id="pf-h-trades">Trades</h2>
          <button type="button" className="pf-btn pf-btn--small" onClick={onAdd}><Plus aria-hidden="true" /> Add trade</button>
        </div>
        <ul className="pf-list">
          {[...trades].reverse().map((tr) => (
            <li key={tr.id} className="pf-trade">
              <span className="pf-trade__date">{day(tr.trade_date)}</span>
              <span className={`pf-side pf-side--${tr.side}`}>{tr.side === 'buy' ? 'Buy' : 'Sell'}</span>
              <span className="pf-trade__what"><b>{tr.symbol}</b> {nf2.format(tr.shares)} at {price(tr.price)}{tr.note ? <small> · {tr.note}</small> : null}</span>
              <span className="pf-trade__total">{tzs(tr.shares * tr.price + (tr.side === 'buy' ? 1 : -1) * tr.fees)}</span>
              <span className="pf-trade__actions">
                {confirming === tr.id ? (
                  <>
                    <button type="button" className="pf-btn pf-btn--small pf-btn--danger" disabled={busy === tr.id} onClick={() => remove(tr)}>Delete</button>
                    <button type="button" className="pf-btn pf-btn--small pf-btn--ghost" onClick={() => setConfirming(null)}>Keep</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="pf-icon" aria-label={`Edit ${tr.side} of ${tr.symbol} on ${tr.trade_date}`} onClick={() => onEdit(tr)}><Pencil aria-hidden="true" /></button>
                    <button type="button" className="pf-icon" aria-label={`Delete ${tr.side} of ${tr.symbol} on ${tr.trade_date}`} onClick={() => setConfirming(tr.id)}><Trash2 aria-hidden="true" /></button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

// ---------- page ----------
export default function Portfolio() {
  const today = useMemo(urlToday, []);
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [trades, setTrades] = useState(null);
  const [market, setMarket] = useState({ prices: {}, dividends: [], splits: [] });
  const [instruments, setInstruments] = useState([]);
  const [sheet, setSheet] = useState(null); // null | {} (new) | trade (edit)
  const [error, setError] = useState(null);

  useEffect(() => {
    getSession().then(setSession);
    loadInstruments().then(setInstruments);
    return onAuthChange(setSession);
  }, []);

  useEffect(() => {
    if (!session) { setTrades(null); return; }
    listTrades().then(setTrades).catch((e) => setError(e));
    loadCalendarData().then((c) => setMarket((m) => ({ ...m, dividends: c.dividends, splits: c.splits || [], calLoaded: true }))).catch(() => setMarket((m) => ({ ...m, calLoaded: true })));
  }, [session]);

  const symbols = useMemo(() => [...new Set((trades || []).map((t) => t.symbol))].sort().join(','), [trades]);
  useEffect(() => {
    if (!symbols) return;
    latestPrices(symbols.split(',')).then((prices) => setMarket((m) => ({ ...m, prices, pricedFor: symbols })));
  }, [symbols]);

  const onSaved = useCallback((saved) => {
    setTrades((cur) => {
      const rest = (cur || []).filter((t) => t.id !== saved.id);
      return [...rest, saved].sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : a.id - b.id));
    });
    setSheet(null);
  }, []);
  const close = useCallback(() => setSheet(null), []);

  const signedIn = Boolean(session);
  return (
    <div className="pf">
      <SiteNav active="portfolio" />
      <main className="pf-main">
        <PageIntro
          title="Portfolio"
          actions={signedIn ? (
            <>
              <span className="pf-who">{session.user?.email}</span>
              <button type="button" className="pf-icon" aria-label="Sign out" title="Sign out" onClick={() => signOut()}><LogOut aria-hidden="true" /></button>
              {trades?.length > 0 && <button type="button" className="pf-btn pf-btn--small" onClick={() => setSheet({})}><Plus aria-hidden="true" /> Add trade</button>}
            </>
          ) : null}>
          Your holdings, gains and dividend income, from the trades you enter.
        </PageIntro>

        {!configured && <p className="pf-note pf-note--bad">Sign-in needs VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.</p>}
        {error && <p className="pf-note pf-note--bad" role="alert">{error instanceof SetupError ? error.message : `Couldn’t load your trades: ${error.message}. Refresh to try again.`}</p>}

        {configured && session === undefined && <div className="pf-skeleton" aria-hidden="true" />}
        {configured && session === null && <SignIn />}

        {signedIn && trades && trades.length === 0 && !error && (
          <section className="pf-card pf-first">
            <h2>Add your first trade</h2>
            <p>Pick the stock and the date you bought. The price fills in from that day’s close; change it if you paid something different. Add sells the same way.</p>
            <button type="button" className="pf-btn pf-btn--accent" onClick={() => setSheet({})}><Plus aria-hidden="true" /> Add a buy</button>
          </section>
        )}

        {signedIn && trades && trades.length > 0 && (
          <Dashboard trades={trades} setTrades={setTrades} splits={market.splits} prices={market.prices}
            dividends={market.dividends} instruments={instruments} today={today}
            dataReady={market.pricedFor === symbols && Boolean(market.calLoaded)}
            onAdd={() => setSheet({})} onEdit={(t) => setSheet(t)} />
        )}

        <footer className="pf-foot">Values use the last DSE close. Dividends are estimates from declared and expected amounts, after 5% withholding tax. Not investment advice.</footer>
      </main>

      {sheet && (
        <TradeSheet initial={sheet.id ? sheet : null} trades={trades || []} splits={market.splits}
          instruments={instruments} today={today} onClose={close} onSaved={onSaved} />
      )}
    </div>
  );
}
