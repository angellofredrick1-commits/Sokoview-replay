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

function urlSymbol() {
  const q = new URLSearchParams(window.location.search).get('symbol');
  return q ? q.toUpperCase() : null;
}

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
function Hero({ events, today, splits, onOpen, overdue, single }) {
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
    lead = single
      ? <><b>{d.symbol}</b> hasn't announced its next dividend.</>
      : <>No dividend is declared for the weeks ahead. <b>{d.symbol}</b> is likely next.</>;
    sub = `Last time ${d.symbol} paid ${formatAmount(d.based_on?.amount, d.currency)} a share on ${fmtDate(d.based_on?.pay_date, { day: 'numeric', month: 'short', year: 'numeric' })}. If it keeps to that cycle, ${expected.type === 'announce' ? `expect an announcement ${when}` : `payment would land ${when}`}.`;
    target = expected;
  } else {
    if (single && overdue.length) {
      lead = <><b>{single}</b> is later than usual this year.</>;
      sub = `${overdue[0].notes} Its dates appear here as soon as it's declared.`;
    } else {
      lead = single ? <>No upcoming dividend for <b>{single}</b>.</> : <>No dividends on the calendar yet.</>;
      sub = 'New declarations appear here as companies announce them.';
    }
  }
  return (
    <section className="dc-hero" aria-live="polite">
      <p className="dc-hero__lead">{lead}</p>
      <p className="dc-hero__sub">
        {sub}{' '}
        {target && <button type="button" className="dc-link" onClick={() => onOpen(target.dividend)}>See all dates</button>}
      </p>
      {overdue.length > 0 && !single && (
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

// ---------- year grid ----------
const TYPE_RANK = { lastbuy: 0, pay: 1, ex: 2, record: 3, agm: 4, announce: 5 };

function MiniMonth({ y, m, byDay, today, onPickDay, onPickMonth }) {
  const first = new Date(Date.UTC(y, m, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  const key = `${y}-${String(m + 1).padStart(2, '0')}`;
  const monthEvents = Object.entries(byDay).filter(([d]) => d.startsWith(key)).flatMap(([, v]) => v);
  const pays = monthEvents.filter((e) => e.type === 'pay').length;
  const buys = monthEvents.filter((e) => e.type === 'lastbuy').length;
  const isCurrent = today.startsWith(key);
  const summary = [buys && `${buys} last buy`, pays && `${pays} paid`].filter(Boolean).join(', ');

  return (
    <section className={`dc-mini${isCurrent ? ' is-current' : ''}${monthEvents.length ? '' : ' is-quiet'}`} aria-label={`${MONTHS[m]} ${y}`}>
      <button type="button" className="dc-mini__head" onClick={() => onPickMonth(m)}>
        <span className="dc-mini__name">{MONTHS[m]}</span>
        <span className="dc-mini__sum">{summary || (monthEvents.length ? `${monthEvents.length} date${monthEvents.length > 1 ? 's' : ''}` : '')}</span>
      </button>
      <div className="dc-mini__grid">
        {WEEKDAYS.map((w) => <span key={w} className="dc-mini__wd" aria-hidden="true">{w[0]}</span>)}
        {cells.map((iso, i) => {
          if (!iso) return <span key={`x${i}`} aria-hidden="true" />;
          const evs = byDay[iso] || [];
          const n = Number(iso.slice(8));
          if (!evs.length) {
            return <span key={iso} className={`dc-mini__d${iso === today ? ' is-today' : ''}${iso < today ? ' is-past' : ''}`}>{n}</span>;
          }
          const top = [...evs].sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type])[0];
          const allExpected = evs.every((e) => e.dividend.expected);
          const label = `${fmtLong(iso)}: ${evs.map((e) => `${e.dividend.symbol} ${EVENT_TYPES[e.type].label.toLowerCase()}${e.dividend.expected ? ' (expected)' : ''}`).join(', ')}`;
          return (
            <button key={iso} type="button" title={label} aria-label={label} onClick={() => onPickDay(iso)}
              className={`dc-mini__d dc-mini__d--ev dc-mini__d--${top.type}${allExpected ? ' is-expected' : ''}${iso === today ? ' is-today' : ''}${iso < today ? ' is-past' : ''}`}>
              {n}
              {evs.length > 1 && <i className="dc-mini__more" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function YearGrid({ year, events, today, onPickDay, onPickMonth }) {
  const byDay = useMemo(() => {
    const map = {};
    for (const e of events) if (e.date.startsWith(String(year))) (map[e.date] ||= []).push(e);
    return map;
  }, [events, year]);
  return (
    <div className="dc-year">
      {MONTHS.map((_, m) => (
        <MiniMonth key={m} y={year} m={m} byDay={byDay} today={today} onPickDay={onPickDay} onPickMonth={onPickMonth} />
      ))}
    </div>
  );
}

// ---------- stock picker ----------
function StockPicker({ value, onChange, stocks, watchlist }) {
  return (
    <label className="dc-picker">
      <span className="dc-sr">Stock</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="all">All dividend payers ({stocks.length})</option>
        {watchlist.length > 0 && <option value="mine">My stocks ({watchlist.length})</option>}
        <optgroup label="One stock">
          {stocks.map((st) => (
            <option key={st.symbol} value={st.symbol}>{st.symbol} · {st.name}</option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}

function StockSummary({ symbol, declared, all, today, splits, inWatch, toggleWatch, onOpen, onSubscribe }) {
  const mine = declared.filter((d) => d.symbol === symbol);
  const any = mine[0] || all.find((d) => d.symbol === symbol);
  if (!any) return null;
  const currency = any.currency || 'TZS';
  const paid = mine.filter((d) => d.pay_date && d.pay_date <= today).sort((a, b) => (a.pay_date < b.pay_date ? 1 : -1));
  const last = paid[0];
  const next = all
    .filter((d) => d.symbol === symbol && !d.stale && (d.pay_date || '') > today)
    .sort((a, b) => (a.pay_date < b.pay_date ? -1 : 1))[0];
  // Per-share cash by calendar year of payment, restated for later splits.
  const byYear = {};
  for (const d of mine) if (d.pay_date) byYear[d.pay_date.slice(0, 4)] = (byYear[d.pay_date.slice(0, 4)] || 0) + adjustedAmount(d, splits);
  const years = Object.keys(byYear).sort();
  const lastYear = String(Number(today.slice(0, 4)) - 1);
  const trailing = mine
    .filter((d) => d.pay_date && d.pay_date <= today && d.pay_date > `${lastYear}${today.slice(4)}`)
    .reduce((t, d) => t + adjustedAmount(d, splits), 0);
  const price = any.price;
  const yieldPct = price && currency === 'TZS' && trailing ? (trailing / price) * 100 : null;
  const overdue = all.find((d) => d.symbol === symbol && d.stale);

  return (
    <section className="dc-stock" aria-label={`${symbol} dividends`}>
      <div className="dc-stock__id">
        <StockMark symbol={symbol} size={44} />
        <div>
          <h2>{symbol}</h2>
          <p>{any.name || symbol}{price ? `, ${formatAmount(price)} last close` : ''}</p>
        </div>
      </div>
      <dl className="dc-stock__facts">
        <div>
          <dt>Last paid</dt>
          <dd>{last
            ? <button type="button" className="dc-link dc-link--plain" onClick={() => onOpen(last)}>{formatAmount(adjustedAmount(last, splits), currency)}<small> on {fmtDate(last.pay_date, { day: 'numeric', month: 'short', year: 'numeric' })}</small></button>
            : <span className="dc-faint">Nothing on record</span>}</dd>
        </div>
        <div>
          <dt>Next</dt>
          <dd>{next
            ? <button type="button" className="dc-link dc-link--plain" onClick={() => onOpen(next)}>{next.expected ? 'Expected ' : ''}{fmtDate(next.pay_date, { day: 'numeric', month: 'short', year: 'numeric' })}<small> {next.expected ? `if it repeats ${formatAmount(next.based_on?.amount, currency)}` : formatAmount(adjustedAmount(next, splits), currency)}</small></button>
            : <span className="dc-faint">{overdue ? 'Overdue, not announced yet' : 'Not announced'}</span>}</dd>
        </div>
        {yieldPct != null && (
          <div>
            <dt>Paid in the last 12 months</dt>
            <dd>{formatAmount(trailing, currency)}<small> {yieldPct.toFixed(1)}% of today's price</small></dd>
          </div>
        )}
      </dl>
      {years.length > 0 && (
        <div className="dc-stock__years" aria-label="Paid per share by year">
          {years.map((y) => {
            const max = Math.max(...years.map((k) => byYear[k]));
            return (
              <div key={y} className="dc-stock__bar">
                <span className="dc-stock__track"><i style={{ height: `${Math.max(8, (byYear[y] / max) * 100)}%` }} /></span>
                <b>{formatAmount(byYear[y], currency).replace(`${currency} `, '')}</b>
                <small>{y}</small>
              </div>
            );
          })}
        </div>
      )}
      <div className="dc-stock__actions">
        <button type="button" className="dc-btn dc-btn--small" onClick={onSubscribe}>Subscribe to {symbol} dates</button>
        <button type="button" className="dc-btn dc-btn--small dc-btn--ghost" aria-pressed={inWatch} onClick={() => toggleWatch(symbol)}>
          {inWatch ? 'In my stocks' : 'Add to my stocks'}
        </button>
      </div>
    </section>
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
      {groups.length === 0 && <p className="dc-empty">Nothing coming up here. Pick another stock, show earlier dates, or turn on expected dividends.</p>}
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
function SubscribeSheet({ onClose, watchlist, allSymbols, includeExpected, symbol }) {
  const [scope, setScope] = useState(symbol ? 'one' : watchlist.length ? 'mine' : 'all');
  const [types, setTypes] = useState(DEFAULT_FEED_TYPES);
  const [expected, setExpected] = useState(includeExpected);
  const [copied, setCopied] = useState(false);
  const symbols = scope === 'one' && symbol ? [symbol] : scope === 'mine' ? watchlist : [];
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
        {symbol && <label><input type="radio" name="scope" checked={scope === 'one'} onChange={() => setScope('one')} /> {symbol} only</label>}
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
  const [watchlist, setWatchlist] = useState(readWatchlist);
  // 'all', 'mine', or a single symbol such as 'CRDB'.
  const [scope, setScope] = useState(() => urlSymbol() || 'all');
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
  const stocks = useMemo(() => allSymbols.map((sym) => ({ symbol: sym, name: (data.dividends.find((d) => d.symbol === sym) || {}).name || sym })), [allSymbols, data]);
  const single = scope !== 'all' && scope !== 'mine' ? scope : null;
  // An unknown ?symbol= (or a stock that has since dropped out) falls back to everything.
  useEffect(() => { if (data && single && !allSymbols.includes(single)) setScope('all'); }, [data, single, allSymbols]);
  const scoped = useMemo(() => (
    scope === 'mine' ? allDivs.filter((d) => watchlist.includes(d.symbol))
      : single ? allDivs.filter((d) => d.symbol === single)
        : allDivs
  ), [allDivs, scope, single, watchlist]);
  const events = useMemo(() => toEvents(scoped, { splits, types, today }), [scoped, splits, types, today]);
  const heroEvents = useMemo(() => toEvents(scoped, { splits, today }), [scoped, splits, today]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (single) url.searchParams.set('symbol', single); else url.searchParams.delete('symbol');
    window.history.replaceState(null, '', url);
  }, [single]);

  const pickScope = (value) => {
    setScope(value);
    if (value === 'all' || value === 'mine' || !data) return;
    // Stay put if this stock already has dates in the period on screen;
    // otherwise move to where it has something to show.
    const evs = toEvents(allDivs.filter((d) => d.symbol === value), { splits, types, today });
    const onScreen = view === 'year' ? String(month[0]) : `${month[0]}-${String(month[1] + 1).padStart(2, '0')}`;
    if (view !== 'list' && evs.some((e) => e.date.startsWith(onScreen))) return;
    const target = evs.find((e) => e.date >= today) || evs[evs.length - 1];
    if (target) {
      setMonth([Number(target.date.slice(0, 4)), Number(target.date.slice(5, 7)) - 1]);
      setSelectedDay(target.date);
    }
  };

  const closeDiv = useCallback(() => setOpenDiv(null), []);
  const closeSub = useCallback(() => setSubscribing(false), []);
  const toggleWatch = (sym) => setWatchlist((cur) => {
    const next = cur.includes(sym) ? cur.filter((s) => s !== sym) : [...cur, sym].sort();
    writeWatchlist(next);
    return next;
  });
  const toggleType = (t) => setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : TYPE_KEYS.filter((k) => k === t || cur.includes(k))));
  const shiftYear = (n) => setMonth(([y, m]) => [y + n, m]);
  const yearCount = events.filter((e) => e.date.startsWith(String(month[0]))).length;
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

        {data && <Hero events={heroEvents} today={today} splits={splits} onOpen={setOpenDiv} overdue={scoped.filter((d) => d.stale)} single={single} />}
        {data && single && (
          <StockSummary symbol={single} declared={data.dividends} all={allDivs} today={today} splits={splits}
            inWatch={watchlist.includes(single)} toggleWatch={toggleWatch} onOpen={setOpenDiv} onSubscribe={() => setSubscribing(true)} />
        )}

        <div className="dc-controls">
          <div className="dc-seg" role="group" aria-label="View">
            <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')}>Month</button>
            <button type="button" aria-pressed={view === 'year'} onClick={() => setView('year')}>Year</button>
            <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
          </div>
          {data && <StockPicker value={scope} onChange={pickScope} stocks={stocks} watchlist={watchlist} />}
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

        {data && view === 'year' && (
          <section className="dc-yearview" aria-label="Year view">
            <div className="dc-month__nav">
              <h2>{month[0]}</h2>
              <span className="dc-month__count">{yearCount ? `${yearCount} date${yearCount > 1 ? 's' : ''}${single ? ` for ${single}` : ''}` : `Nothing in ${month[0]}${single ? ` for ${single}` : ''}`}</span>
              <div className="dc-month__btns">
                <button type="button" className="dc-icon" onClick={() => shiftYear(-1)} aria-label="Previous year">‹</button>
                <button type="button" className="dc-btn dc-btn--small dc-btn--ghost" onClick={() => setMonth([Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1])}>This year</button>
                <button type="button" className="dc-icon" onClick={() => shiftYear(1)} aria-label="Next year">›</button>
              </div>
            </div>
            <YearGrid year={month[0]} events={events} today={today}
              onPickMonth={(m) => { setMonth([month[0], m]); setView('month'); }}
              onPickDay={(iso) => { setMonth([Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1]); setSelectedDay(iso); setView('month'); }} />
            <p className="dc-yearview__key">
              <span><i className="dc-key dc-key--lastbuy" />Last day to buy</span>
              <span><i className="dc-key dc-key--pay" />Payment</span>
              <span><i className="dc-key dc-key--other" />Other dates</span>
              <span><i className="dc-key dc-key--past" />Already happened (paler)</span>
              <span><i className="dc-key dc-key--expected" />Expected</span>
              <span className="dc-faint">Pick a day or month to open it.</span>
            </p>
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
      {subscribing && <SubscribeSheet onClose={closeSub} watchlist={watchlist} allSymbols={allSymbols} includeExpected={includeExpected} symbol={single} />}
    </div>
  );
}
