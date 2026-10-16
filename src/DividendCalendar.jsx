import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EVENT_TYPES, DEFAULT_FEED_TYPES, adjustedAmount, buildICS, calendarDividends, daysBetween,
  dividendId, formatAmount, fromISO, googleCalendarUrl, googleSubscribeUrl, keyDates,
  outlookCalendarUrl, toEvents, todayISO,
} from './lib/dividends.js';
import { isLive, loadCalendarData, readWatchlist, writeWatchlist } from './lib/dividendData.js';
import { logoUrl, monogramColor, monogramText } from './logos.js';
import './dividend-calendar.css';

const WHT = 0.05; // withholding tax on dividends from DSE-listed companies
const TYPE_KEYS = Object.keys(EVENT_TYPES);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const fmtDate = (s, opts = { day: 'numeric', month: 'short' }) =>
  fromISO(s).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
const fmtLong = (s) => fmtDate(s, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const relDays = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`);

function urlToday() {
  const q = new URLSearchParams(window.location.search).get('today');
  return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayISO();
}

// ---------- small pieces ----------
function StockMark({ symbol, size = 32 }) {
  const url = logoUrl(symbol);
  const [failed, setFailed] = useState(false);
  const mono = !url || failed;
  return (
    <span className={`dc-mark${mono ? ' dc-mark--mono' : ''}`} aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.32, ...(mono ? { background: monogramColor(symbol) } : {}) }}>
      {mono ? monogramText(symbol) : <img src={url} alt="" onError={() => setFailed(true)} />}
    </span>
  );
}

function Badge({ div }) {
  if (div.expected) return <span className="dc-badge dc-badge--expected">Expected</span>;
  if (!div.verified) return <span className="dc-badge dc-badge--check">Check source</span>;
  return null;
}

function downloadICS(filename, ics) {
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

function AddMenu({ ev, splits, label = 'Add to calendar' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  return (
    <span className="dc-add" ref={ref}>
      <button type="button" className="dc-btn dc-btn--small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && (
        <span className="dc-add__menu" role="menu">
          <a role="menuitem" href={googleCalendarUrl(ev, splits)} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>Google Calendar</a>
          <a role="menuitem" href={outlookCalendarUrl(ev, splits)} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>Outlook</a>
          <button role="menuitem" type="button" onClick={() => { downloadICS(`${ev.id}.ics`, buildICS([ev], { splits })); setOpen(false); }}>
            Apple Calendar (.ics)
          </button>
        </span>
      )}
    </span>
  );
}

function Sheet({ title, onClose, children, labelledBy }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.focus();
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    document.body.classList.add('dc-noscroll');
    return () => { document.removeEventListener('keydown', esc); document.body.classList.remove('dc-noscroll'); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="dc-sheet-wrap" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dc-sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} ref={ref}>
        <button type="button" className="dc-sheet__close" onClick={onClose} aria-label={`Close ${title}`}>×</button>
        {children}
      </div>
    </div>
  );
}

// ---------- hero ----------
function Hero({ events, today, splits, onOpen, overdue }) {
  const upcoming = events.filter((e) => e.date >= today);
  const declared = upcoming.filter((e) => !e.dividend.expected);
  const buy = declared.find((e) => e.type === 'lastbuy');
  const pay = declared.find((e) => e.type === 'pay');
  const expected = upcoming.find((e) => e.dividend.expected && (e.type === 'announce' || e.type === 'pay'));

  let lead; let sub; let target;
  if (buy) {
    const k = keyDates(buy.dividend);
    const n = daysBetween(today, buy.date);
    lead = <>Buy <b>{buy.dividend.symbol}</b> by {fmtDate(buy.date)} to collect {formatAmount(adjustedAmount(buy.dividend, splits), buy.dividend.currency)} a share.</>;
    sub = `${n === 0 ? 'Today is the last day to qualify' : `${n} day${n === 1 ? '' : 's'} left to qualify`}${k.pay ? `. Paid ${fmtDate(k.pay)}.` : '.'}`;
    target = buy;
  } else if (pay) {
    lead = <><b>{pay.dividend.symbol}</b> pays {formatAmount(adjustedAmount(pay.dividend, splits), pay.dividend.currency)} a share on {fmtDate(pay.date)}.</>;
    sub = `Payment ${relDays(daysBetween(today, pay.date))}. The cut-off to qualify has passed.`;
    target = pay;
  } else if (expected) {
    const d = expected.dividend;
    const when = relDays(daysBetween(today, expected.date));
    lead = <>No dividend is declared for the weeks ahead. <b>{d.symbol}</b> is likely next.</>;
    sub = `Last year ${d.symbol} paid ${formatAmount(d.based_on?.amount, d.currency)} a share on ${fmtDate(d.based_on?.pay_date, { day: 'numeric', month: 'short', year: 'numeric' })}. If it keeps to that cycle, ${expected.type === 'announce' ? `expect an announcement ${when}` : `payment would land ${when}`}.`;
    target = expected;
  } else {
    lead = <>No dividends on the calendar yet.</>;
    sub = 'New declarations appear here as companies announce them.';
  }
  return (
    <section className="dc-hero" aria-live="polite">
      <p className="dc-hero__lead">{lead}</p>
      <p className="dc-hero__sub">
        {sub}{' '}
        {target && <button type="button" className="dc-link" onClick={() => onOpen(target.dividend)}>See all dates</button>}
      </p>
      {overdue.length > 0 && (
        <p className="dc-hero__overdue">
          Usually declared by now, not announced yet:{' '}
          {overdue.map((d, i) => (
            <span key={d.symbol}>{i > 0 && ', '}<button type="button" className="dc-link" onClick={() => onOpen(d)}>{d.symbol}</button></span>
          ))}
        </p>
      )}
    </section>
  );
}

// ---------- month grid ----------
function MonthGrid({ month, events, today, selected, onSelectDay, onOpen }) {
  const [y, m] = month;
  const first = new Date(Date.UTC(y, m, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  const byDay = useMemo(() => {
    const map = {};
    for (const e of events) (map[e.date] ||= []).push(e);
    return map;
  }, [events]);

  return (
    <div className="dc-grid" role="grid" aria-label={`${MONTHS[m]} ${y}`}>
      <div className="dc-grid__head" role="row">
        {WEEKDAYS.map((w) => <span key={w} role="columnheader">{w}</span>)}
      </div>
      <div className="dc-grid__body">
        {cells.map((iso, i) => {
          if (!iso) return <span key={`x${i}`} className="dc-day dc-day--empty" aria-hidden="true" />;
          const evs = byDay[iso] || [];
          const cls = ['dc-day', iso === today && 'is-today', iso < today && 'is-past', iso === selected && 'is-selected', evs.length && 'has-events'].filter(Boolean).join(' ');
          return (
            <div key={iso} className={cls} role="gridcell">
              <button type="button" className="dc-day__num" onClick={() => onSelectDay(iso)}
                aria-label={`${fmtLong(iso)}, ${evs.length ? `${evs.length} dividend date${evs.length > 1 ? 's' : ''}` : 'no dividend dates'}`}>
                {Number(iso.slice(8))}
              </button>
              <ul className="dc-day__chips">
                {evs.slice(0, 3).map((e) => (
                  <li key={e.id}>
                    <button type="button" className={`dc-chip dc-chip--${e.type}${e.dividend.expected ? ' is-expected' : ''}`} onClick={() => onOpen(e.dividend)} title={e.title}>
                      <span className="dc-chip__sym">{e.dividend.symbol}</span> {EVENT_TYPES[e.type].short}
                    </button>
                  </li>
                ))}
                {evs.length > 3 && <li><button type="button" className="dc-chip dc-chip--more" onClick={() => onSelectDay(iso)}>{evs.length - 3} more</button></li>}
              </ul>
              {evs.length > 0 && (
                <span className="dc-day__dots" aria-hidden="true">
                  {evs.slice(0, 4).map((e) => <i key={e.id} className={`dc-dot dc-dot--${e.type}${e.dividend.expected ? ' is-expected' : ''}`} />)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventRow({ e, today, splits, onOpen }) {
  const d = e.dividend;
  const n = daysBetween(today, e.date);
  return (
    <li className={`dc-row${e.date < today ? ' is-past' : ''}`}>
      <span className={`dc-row__date dc-row__date--${e.type}`}>
        <b>{Number(e.date.slice(8))}</b>
        <small>{fmtDate(e.date, { weekday: 'short' })}</small>
      </span>
      <button type="button" className="dc-row__main" onClick={() => onOpen(d)}>
        <StockMark symbol={d.symbol} size={28} />
        <span className="dc-row__text">
          <span className="dc-row__title">{d.symbol}</span>
          <span className="dc-row__meta">
            <span className={`dc-type dc-type--${e.type}`}>{EVENT_TYPES[e.type].label}</span>
            {e.estimated && <span className="dc-est" title="Worked out from books closure"> (est.)</span>}
            {', '}
            {d.expected ? `expected, last time ${formatAmount(d.based_on?.amount, d.currency)}` : `${formatAmount(adjustedAmount(d, splits), d.currency)} ${d.kind}`}
            {e.date >= today && n <= 60 && `, ${relDays(n)}`}
          </span>
        </span>
        {!d.expected && <Badge div={d} />}
      </button>
      {e.date >= today && <AddMenu ev={e} splits={splits} label="Add" />}
    </li>
  );
}

function Agenda({ events, today, splits, onOpen, showPast, setShowPast }) {
  const shown = showPast ? events : events.filter((e) => e.date >= today);
  const groups = [];
  for (const e of shown) {
    const key = e.date.slice(0, 7);
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, items: [] });
    groups[groups.length - 1].items.push(e);
  }
  return (
    <div className="dc-agenda">
      {!showPast && events.some((e) => e.date < today) && (
        <button type="button" className="dc-link dc-agenda__past" onClick={() => setShowPast(true)}>Show earlier dates</button>
      )}
      {groups.length === 0 && <p className="dc-empty">Nothing coming up for these stocks. Add more to your list, or turn on expected dividends.</p>}
      {groups.map((g) => (
        <section key={g.key} className="dc-agenda__month">
          <h3>{MONTHS[Number(g.key.slice(5)) - 1]} {g.key.slice(0, 4)}</h3>
          <ul>{g.items.map((e) => <EventRow key={e.id} e={e} today={today} splits={splits} onOpen={onOpen} />)}</ul>
        </section>
      ))}
    </div>
  );
}

// ---------- detail ----------
function DividendSheet({ div, today, splits, onClose, inWatch, toggleWatch }) {
  const [shares, setShares] = useState('100');
  const evs = useMemo(() => toEvents([div], { splits }), [div, splits]);
  const amt = adjustedAmount(div, splits);
  const split = amt !== Number(div.amount);
  const n = Math.max(0, Number(shares) || 0);
  const gross = n * amt;
  const net = gross * (1 - WHT);
  const yieldPct = div.price && div.currency === 'TZS' ? (amt / div.price) * 100 : null;
  const titleId = `dc-sheet-${dividendId(div)}`;

  return (
    <Sheet title={div.symbol} onClose={onClose} labelledBy={titleId}>
      <header className="dc-detail__head">
        <StockMark symbol={div.symbol} size={44} />
        <div>
          <h2 id={titleId}>{div.symbol}</h2>
          <p>{div.name || div.symbol}</p>
        </div>
      </header>

      <div className="dc-detail__amount">
        <span className="dc-detail__big">{formatAmount(amt, div.currency)}</span>
        <span className="dc-detail__per">a share, {div.fiscal_year} {div.kind}{div.expected ? ', if repeated' : ''}</span>
        <Badge div={div} />
      </div>
      {split && <p className="dc-note">Declared as {formatAmount(Number(div.amount), div.currency)} before NMB's 1-for-10 split. Shown per share you hold today.</p>}
      {div.expected && <p className="dc-note">{div.notes}</p>}
      {!div.expected && !div.verified && <p className="dc-note">{div.notes || 'Some details come from a secondary source.'}</p>}

      <dl className="dc-facts">
        {yieldPct != null && (<><dt>Against today's price</dt><dd>{yieldPct.toFixed(2)}% of {formatAmount(div.price)}</dd></>)}
        <dt><label htmlFor="dc-shares">Shares you hold</label></dt>
        <dd><input id="dc-shares" inputMode="numeric" value={shares} onChange={(e) => setShares(e.target.value.replace(/[^\d]/g, ''))} /></dd>
        <dt>You'd receive</dt>
        <dd><b>{formatAmount(net, div.currency)}</b> <small>after 5% withholding tax ({formatAmount(gross, div.currency)} gross)</small></dd>
      </dl>

      <h3 className="dc-detail__h">{div.expected ? (div.stale ? 'No dates yet' : "Expected dates, based on last year") : 'Key dates'}</h3>
      <ol className="dc-timeline">
        {evs.map((e) => {
          const past = e.date < today;
          return (
            <li key={e.id} className={`dc-tl dc-tl--${e.type}${past ? ' is-past' : ''}${e.date === today ? ' is-today' : ''}`}>
              <span className="dc-tl__dot" aria-hidden="true" />
              <span className="dc-tl__body">
                <span className="dc-tl__label">{EVENT_TYPES[e.type].label}{e.estimated && <span className="dc-est"> (estimated)</span>}</span>
                <span className="dc-tl__date">{fmtLong(e.date)} <small>{relDays(daysBetween(today, e.date))}</small></span>
                {e.type === 'lastbuy' && <span className="dc-tl__hint">Own the shares by the close of trading on this day.</span>}
              </span>
              {!past && <AddMenu ev={e} splits={splits} label="Add" />}
            </li>
          );
        })}
      </ol>

      <div className="dc-detail__actions">
        <button type="button" className="dc-btn" onClick={() => downloadICS(`${dividendId(div)}.ics`, buildICS(evs.filter((e) => e.date >= today), { splits }))}
          disabled={!evs.some((e) => e.date >= today)}>
          Download upcoming dates (.ics)
        </button>
        <button type="button" className="dc-btn dc-btn--ghost" aria-pressed={inWatch} onClick={() => toggleWatch(div.symbol)}>
          {inWatch ? `Remove ${div.symbol} from my stocks` : `Add ${div.symbol} to my stocks`}
        </button>
      </div>
      {div.source_url && <p className="dc-source">Source: <a href={div.source_url} target="_blank" rel="noreferrer">{new URL(div.source_url).hostname.replace(/^www\./, '')}</a>. Gross amounts; not investment advice.</p>}
    </Sheet>
  );
}

// ---------- subscribe ----------
function SubscribeSheet({ onClose, watchlist, allSymbols, includeExpected }) {
  const [scope, setScope] = useState(watchlist.length ? 'mine' : 'all');
  const [types, setTypes] = useState(DEFAULT_FEED_TYPES);
  const [expected, setExpected] = useState(includeExpected);
  const [copied, setCopied] = useState(false);
  const symbols = scope === 'mine' ? watchlist : [];
  const params = new URLSearchParams();
  if (symbols.length) params.set('symbols', symbols.join(','));
  params.set('types', types.join(','));
  if (expected) params.set('expected', '1');
  const feed = `${window.location.origin}/dividends.ics?${params.toString()}`;
  const webcal = feed.replace(/^https?:/, 'webcal:');
  const toggle = (t) => setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : TYPE_KEYS.filter((k) => k === t || cur.includes(k))));
  const disabled = types.length === 0 || (scope === 'mine' && !watchlist.length);

  return (
    <Sheet title="Subscribe" onClose={onClose} labelledBy="dc-sub-title">
      <h2 id="dc-sub-title" className="dc-sub__title">Keep dividend dates in your calendar</h2>
      <p className="dc-sub__lead">Subscribe once. New declarations show up on their own, with a reminder two days before the last day to buy.</p>

      <fieldset className="dc-field">
        <legend>Which stocks</legend>
        <label><input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} /> All {allSymbols.length} dividend payers</label>
        <label><input type="radio" name="scope" checked={scope === 'mine'} onChange={() => setScope('mine')} disabled={!watchlist.length} />
          My stocks{watchlist.length ? ` (${watchlist.join(', ')})` : ' (none added yet)'}</label>
      </fieldset>

      <fieldset className="dc-field">
        <legend>Which dates</legend>
        {TYPE_KEYS.map((t) => (
          <label key={t}><input type="checkbox" checked={types.includes(t)} onChange={() => toggle(t)} /> {EVENT_TYPES[t].label}</label>
        ))}
        <label className="dc-field__sep"><input type="checkbox" checked={expected} onChange={(e) => setExpected(e.target.checked)} /> Also show expected dividends, marked tentative</label>
      </fieldset>

      <div className="dc-sub__actions">
        <a className={`dc-btn${disabled ? ' is-disabled' : ''}`} aria-disabled={disabled} href={disabled ? undefined : googleSubscribeUrl(feed)} target="_blank" rel="noreferrer">Add to Google Calendar</a>
        <a className={`dc-btn dc-btn--ghost${disabled ? ' is-disabled' : ''}`} aria-disabled={disabled} href={disabled ? undefined : webcal}>Apple Calendar or Outlook</a>
      </div>
      <div className="dc-copy">
        <input readOnly value={feed} aria-label="Calendar feed link" onFocus={(e) => e.target.select()} />
        <button type="button" className="dc-btn dc-btn--small" disabled={disabled}
          onClick={async () => { try { await navigator.clipboard.writeText(feed); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* ignore */ } }}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p className="dc-source">Google refreshes subscribed calendars every few hours, so a new declaration can take up to a day to appear there.</p>
    </Sheet>
  );
}

// ---------- page ----------
export default function DividendCalendar() {
  const today = useMemo(urlToday, []);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState(() => (window.matchMedia?.('(max-width: 640px)').matches ? 'list' : 'month'));
  const [month, setMonth] = useState(() => [Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1]);
  const [selectedDay, setSelectedDay] = useState(today);
  const [scope, setScope] = useState('all');
  const [watchlist, setWatchlist] = useState(readWatchlist);
  const [types, setTypes] = useState(DEFAULT_FEED_TYPES);
  const [includeExpected, setIncludeExpected] = useState(true);
  const [showPast, setShowPast] = useState(false);
  const [openDiv, setOpenDiv] = useState(null);
  const [subscribing, setSubscribing] = useState(false);

  useEffect(() => {
    loadCalendarData().then(setData).catch((e) => setError(e.message || String(e)));
  }, []);
  useEffect(() => { if (watchlist.length === 0 && scope === 'mine') setScope('all'); }, [watchlist, scope]);

  const splits = data?.splits || [];
  const allDivs = useMemo(() => (data ? calendarDividends(data.dividends, { today, includeExpected, splits }) : []), [data, today, includeExpected, splits]);
  const allSymbols = useMemo(() => [...new Set((data?.dividends || []).map((d) => d.symbol))].sort(), [data]);
  const scoped = useMemo(() => (scope === 'mine' ? allDivs.filter((d) => watchlist.includes(d.symbol)) : allDivs), [allDivs, scope, watchlist]);
  const events = useMemo(() => toEvents(scoped, { splits, types, today }), [scoped, splits, types, today]);
  const heroEvents = useMemo(() => toEvents(scoped, { splits, today }), [scoped, splits, today]);

  const closeDiv = useCallback(() => setOpenDiv(null), []);
  const closeSub = useCallback(() => setSubscribing(false), []);
  const toggleWatch = (sym) => setWatchlist((cur) => {
    const next = cur.includes(sym) ? cur.filter((s) => s !== sym) : [...cur, sym].sort();
    writeWatchlist(next);
    return next;
  });
  const toggleType = (t) => setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : TYPE_KEYS.filter((k) => k === t || cur.includes(k))));
  const shiftMonth = (n) => setMonth(([y, m]) => { const d = new Date(Date.UTC(y, m + n, 1)); return [d.getUTCFullYear(), d.getUTCMonth()]; });
  const dayEvents = events.filter((e) => e.date === selectedDay);
  const monthKey = `${month[0]}-${String(month[1] + 1).padStart(2, '0')}`;
  const monthCount = events.filter((e) => e.date.startsWith(monthKey)).length;

  return (
    <div className="dc">
      <header className="dc-top">
        <div className="dc-brand">
          <a href="/" className="dc-logo" aria-label="Sokoview home"><span className="dc-logo__mark" aria-hidden="true" />Sokoview</a>
          <span className={`dc-pill${data?.mode === 'live' ? ' is-live' : ''}`}>{!data ? 'Loading' : data.mode === 'live' ? 'Live' : 'Sample data'}</span>
        </div>
        <button type="button" className="dc-btn" onClick={() => setSubscribing(true)} disabled={!data}>Subscribe<span className="dc-wide"> in your calendar</span></button>
      </header>

      <main className="dc-main">
        <h1 className="dc-title">Dividend calendar</h1>
        {data?.notice && <p className="dc-banner">{data.notice}</p>}
        {error && <p className="dc-banner dc-banner--error">Couldn't load dividends: {error}. Refresh to try again.</p>}

        {data && <Hero events={heroEvents} today={today} splits={splits} onOpen={setOpenDiv} overdue={scoped.filter((d) => d.stale)} />}

        <div className="dc-controls">
          <div className="dc-seg" role="group" aria-label="View">
            <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')}>Month</button>
            <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
          </div>
          <div className="dc-seg" role="group" aria-label="Stocks">
            <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All stocks</button>
            <button type="button" aria-pressed={scope === 'mine'} onClick={() => setScope('mine')} disabled={!watchlist.length}
              title={watchlist.length ? undefined : 'Open a dividend and add the stock to your list'}>
              My stocks{watchlist.length ? ` (${watchlist.length})` : ''}
            </button>
          </div>
          <label className="dc-toggle">
            <input type="checkbox" checked={includeExpected} onChange={(e) => setIncludeExpected(e.target.checked)} />
            Show expected
          </label>
        </div>
        <div className="dc-types" role="group" aria-label="Dates to show">
          {TYPE_KEYS.map((t) => (
            <button key={t} type="button" className={`dc-filter dc-filter--${t}`} aria-pressed={types.includes(t)} onClick={() => toggleType(t)}>
              <i aria-hidden="true" />{EVENT_TYPES[t].label}
            </button>
          ))}
        </div>

        {!data && !error && <div className="dc-skeleton" aria-hidden="true" />}

        {data && view === 'month' && (
          <section className="dc-month" aria-label="Month view">
            <div className="dc-month__nav">
              <h2>{MONTHS[month[1]]} {month[0]}</h2>
              <span className="dc-month__count">{monthCount ? `${monthCount} date${monthCount > 1 ? 's' : ''}` : 'Nothing this month'}</span>
              <div className="dc-month__btns">
                <button type="button" className="dc-icon" onClick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
                <button type="button" className="dc-btn dc-btn--small dc-btn--ghost" onClick={() => { setMonth([Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1]); setSelectedDay(today); }}>Today</button>
                <button type="button" className="dc-icon" onClick={() => shiftMonth(1)} aria-label="Next month">›</button>
              </div>
            </div>
            <MonthGrid month={month} events={events} today={today} selected={selectedDay} onSelectDay={setSelectedDay} onOpen={setOpenDiv} />
            <div className="dc-day-detail" aria-live="polite">
              <h3>{fmtLong(selectedDay)}</h3>
              {dayEvents.length
                ? <ul>{dayEvents.map((e) => <EventRow key={e.id} e={e} today={today} splits={splits} onOpen={setOpenDiv} />)}</ul>
                : <p className="dc-empty">No dividend dates on this day.</p>}
            </div>
          </section>
        )}

        {data && view === 'list' && (
          <Agenda events={events} today={today} splits={splits} onOpen={setOpenDiv} showPast={showPast} setShowPast={setShowPast} />
        )}

        <footer className="dc-foot">
          <p>Amounts are gross, per share, before the 5% withholding tax. Expected dividends repeat last year's dates and amount until the company announces; they can change or not happen. {isLive ? '' : 'Sample data from DSE and company notices as of 15 Oct 2026.'} Not investment advice.</p>
        </footer>
      </main>

      {openDiv && (
        <DividendSheet div={openDiv} today={today} splits={splits} onClose={closeDiv}
          inWatch={watchlist.includes(openDiv.symbol)} toggleWatch={toggleWatch} />
      )}
      {subscribing && <SubscribeSheet onClose={closeSub} watchlist={watchlist} allSymbols={allSymbols} includeExpected={includeExpected} />}
    </div>
  );
}
