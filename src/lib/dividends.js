// Pure dividend-calendar logic, shared by the React page and the Netlify ICS feed.
// No DOM, no network. Dates are ISO strings (YYYY-MM-DD) and treated as all-day,
// Tanzania-local dates, so nothing here touches time zones.

export const EVENT_TYPES = {
  announce: { label: 'Announced', short: 'Announced', order: 0 },
  lastbuy:  { label: 'Last day to buy', short: 'Last buy', order: 1 },
  ex:       { label: 'Ex-dividend', short: 'Ex-date', order: 2 },
  record:   { label: 'Books closure', short: 'Books close', order: 3 },
  agm:      { label: 'AGM', short: 'AGM', order: 4 },
  pay:      { label: 'Payment', short: 'Paid', order: 5 },
};

export const DEFAULT_FEED_TYPES = ['lastbuy', 'pay'];

const KIND_LABEL = { final: 'final', interim: 'interim', special: 'special' };

// ---------- date helpers ----------
const pad = (n) => String(n).padStart(2, '0');
export const toISO = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const fromISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const addDays = (s, n) => { const d = fromISO(s); d.setUTCDate(d.getUTCDate() + n); return toISO(d); };
const isWeekend = (s) => { const w = fromISO(s).getUTCDay(); return w === 0 || w === 6; };
// Weekends only; DSE public holidays are not modelled, hence "estimated".
export const prevBusinessDay = (s) => { let d = addDays(s, -1); while (isWeekend(d)) d = addDays(d, -1); return d; };
export const nextBusinessDayOnOrAfter = (s) => { let d = s; while (isWeekend(d)) d = addDays(d, 1); return d; };
export const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000);
export const todayISO = () => {
  // Tanzania is UTC+3 all year.
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  return toISO(d);
};

// ---------- amounts ----------
/** Amount restated per current share, after any later splits (e.g. NMB 1:10 in Aug 2026). */
export function adjustedAmount(div, splits = []) {
  const ref = div.ex_date || div.record_date || div.pay_date;
  const factor = splits
    .filter((s) => s.symbol === div.symbol && ref && s.ex_date > ref)
    .reduce((f, s) => f * Number(s.ratio || 1), 1);
  return factor === 1 ? Number(div.amount) : Number(div.amount) / factor;
}

export function formatAmount(n, currency = 'TZS') {
  if (n == null || Number.isNaN(n)) return '—';
  const digits = n < 100 && n % 1 !== 0 ? 2 : n % 1 !== 0 ? 2 : 0;
  return `${currency} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: 2 })}`;
}

// ---------- key dates for one dividend ----------
/**
 * Fills in the dates a declaration usually leaves implicit.
 * On the DSE the ex-date is one trading day before books closure, and the
 * last day to buy is the trading day before the ex-date.
 */
export function keyDates(div) {
  const out = { estimated: {} };
  out.announce = div.announced_on || null;
  out.record = div.record_date || null;
  out.pay = div.pay_date || null;
  out.agm = div.agm_date || null;
  if (div.ex_date) out.ex = div.ex_date;
  else if (div.record_date) { out.ex = prevBusinessDay(div.record_date); out.estimated.ex = true; }
  else out.ex = null;
  if (out.ex) {
    out.lastbuy = prevBusinessDay(out.ex);
    if (out.estimated.ex) out.estimated.lastbuy = true;
  } else out.lastbuy = null;
  return out;
}

export const dividendId = (d) =>
  `${d.symbol}-${String(d.fiscal_year || '').replace(/[^A-Za-z0-9]+/g, '')}-${d.kind}${d.expected ? '-exp' : ''}`.toLowerCase();

// ---------- expected (not yet announced) dividends ----------
/**
 * For each symbol and dividend kind, takes last year's cycle and rolls it forward
 * a year, but only when nothing newer has been declared and the projected payment
 * is still ahead. Special dividends are one-offs and are never projected.
 */
export function projectExpected(dividends, today, { splits = [], horizonDays = 400 } = {}) {
  const groups = new Map();
  for (const d of dividends) {
    if (d.kind === 'special' || !d.pay_date) continue;
    const key = `${d.symbol}|${d.kind}`;
    const cur = groups.get(key);
    if (!cur || d.pay_date > cur.pay_date) groups.set(key, d);
  }
  const out = [];
  for (const last of groups.values()) {
    const shift = (s) => (s ? nextBusinessDayOnOrAfter(addDays(s, 365)) : null);
    const projectedPay = shift(last.pay_date);
    if (projectedPay <= today || daysBetween(today, projectedPay) > horizonDays) continue;
    // If last year's cycle says the books should already have closed, a dividend that
    // hasn't been declared can't land on those dates. Flag it rather than project fiction.
    const cutoff = shift(last.record_date) || shift(last.ex_date);
    const stale = Boolean(cutoff && cutoff < today);
    out.push({
      symbol: last.symbol,
      fiscal_year: nextFiscalYear(last.fiscal_year),
      kind: last.kind,
      // Restated per current share, so a later split doesn't inflate the projection.
      amount: adjustedAmount(last, splits),
      currency: last.currency,
      announced_on: shift(last.announced_on),
      ex_date: shift(last.ex_date),
      record_date: shift(last.record_date),
      pay_date: projectedPay,
      agm_date: shift(last.agm_date),
      verified: false,
      expected: true,
      stale,
      based_on: { fiscal_year: last.fiscal_year, amount: adjustedAmount(last, splits), pay_date: last.pay_date },
      source_url: last.source_url,
      notes: stale
        ? `Usually declared by now (last year's books closed ${humanDate(last.record_date || last.ex_date)}), but no announcement yet.`
        : `Not yet announced. Dates follow last year's cycle (${last.fiscal_year}, paid ${humanDate(last.pay_date)}).`,
      name: last.name,
      price: last.price,
    });
  }
  return out;
}

export const humanDate = (s) => (s ? fromISO(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

function nextFiscalYear(fy = '') {
  return fy.replace(/(\d{4})/, (y) => String(Number(y) + 1)) || 'Next';
}

// ---------- events ----------
export function eventTitle(div, type, splits) {
  const amt = formatAmount(adjustedAmount(div, splits), div.currency);
  const exp = div.expected ? ' (expected)' : '';
  switch (type) {
    case 'announce': return `${div.symbol} · Dividend announced${div.expected ? ' (expected)' : ` · ${amt}`}`;
    case 'lastbuy':  return `${div.symbol} · Last day to buy for the ${KIND_LABEL[div.kind] || ''} dividend${exp}`;
    case 'ex':       return `${div.symbol} · Trades ex-dividend${exp}`;
    case 'record':   return `${div.symbol} · Books closure${exp}`;
    case 'agm':      return `${div.symbol} · AGM${exp}`;
    case 'pay':      return div.expected
      ? `${div.symbol} · Expected dividend payment (last: ${amt}/share)`
      : `${div.symbol} · Dividend paid · ${amt}/share`;
    default:         return div.symbol;
  }
}

export function eventDescription(div, type, splits) {
  const k = keyDates(div);
  const amt = formatAmount(adjustedAmount(div, splits), div.currency);
  const lines = [];
  lines.push(`${div.name || div.symbol} — ${div.fiscal_year || ''} ${div.kind} dividend${div.expected ? ' (expected, not yet announced)' : ''}.`);
  lines.push(div.expected ? `Last cycle: ${formatAmount(div.based_on?.amount, div.currency)} per share.` : `Amount: ${amt} per share (gross, before withholding tax).`);
  if (type === 'lastbuy') lines.push('Buy on or before this day to qualify. Shares bought from the ex-date onward do not get this dividend.');
  if (k.lastbuy) lines.push(`Last day to buy: ${k.lastbuy}${k.estimated.lastbuy ? ' (estimated)' : ''}`);
  if (k.ex) lines.push(`Ex-dividend: ${k.ex}${k.estimated.ex ? ' (estimated)' : ''}`);
  if (k.record) lines.push(`Books closure: ${k.record}`);
  if (k.pay) lines.push(`Payment: ${k.pay}`);
  if (!div.verified && !div.expected) lines.push('Some dates come from a secondary source — check the company notice.');
  if (div.source_url) lines.push(`Source: ${div.source_url}`);
  lines.push('Not investment advice. Track it on Sokoview.');
  return lines.join('\n');
}

export function toEvents(dividends, { splits = [], types, today } = {}) {
  const want = types ? new Set(types) : null;
  const events = [];
  for (const div of dividends) {
    if (div.stale) continue; // no dates worth showing; surfaced separately
    const k = keyDates(div);
    for (const type of Object.keys(EVENT_TYPES)) {
      const date = k[type];
      if (!date || (want && !want.has(type))) continue;
      // A projected date that has already passed carries no information.
      if (div.expected && today && date < today) continue;
      events.push({
        id: `${dividendId(div)}-${type}`,
        type,
        date,
        estimated: Boolean(k.estimated[type]),
        dividend: div,
        title: eventTitle(div, type, splits),
      });
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : EVENT_TYPES[a.type].order - EVENT_TYPES[b.type].order || a.dividend.symbol.localeCompare(b.dividend.symbol)));
  return events;
}

// ---------- add-to-calendar ----------
const compact = (s) => s.replace(/-/g, '');

export function googleCalendarUrl(ev, splits) {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    dates: `${compact(ev.date)}/${compact(addDays(ev.date, 1))}`,
    details: eventDescription(ev.dividend, ev.type, splits),
  });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

export function outlookCalendarUrl(ev, splits) {
  const p = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: ev.title,
    startdt: ev.date,
    enddt: addDays(ev.date, 1),
    allday: 'true',
    body: eventDescription(ev.dividend, ev.type, splits),
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${p.toString()}`;
}

/** Google "add calendar by URL" link for a webcal feed. */
export function googleSubscribeUrl(feedHttpsUrl) {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feedHttpsUrl.replace(/^https?:/, 'webcal:'))}`;
}

// ---------- ICS (RFC 5545) ----------
const icsEscape = (s = '') => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

function fold(line) {
  // Fold at 75 octets without splitting a UTF-8 character.
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '';
  let limit = 75;
  for (const ch of line) {
    if (enc.encode(cur + ch).length > limit) { parts.push(cur); cur = ch; limit = 74; }
    else cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

const ALARMS = {
  // All-day events start at local midnight.
  lastbuy: { trigger: '-P1DT15H', text: 'Last day to buy is in two days' }, // 09:00 two days before
  pay: { trigger: 'PT9H', text: 'Dividend payment day' },                   // 09:00 on the day
};

export function buildICS(events, { calName = 'Sokoview · DSE dividends', splits = [], alarms = true, now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const L = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sokoview//Dividend Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calName)}`,
    'X-WR-TIMEZONE:Africa/Dar_es_Salaam',
    'X-WR-CALDESC:Dar es Salaam Stock Exchange dividend dates from Sokoview',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];
  for (const ev of events) {
    L.push(
      'BEGIN:VEVENT',
      `UID:${ev.id}@sokoview.co.tz`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(ev.date)}`,
      `DTEND;VALUE=DATE:${compact(addDays(ev.date, 1))}`,
      `SUMMARY:${icsEscape(ev.title)}`,
      `DESCRIPTION:${icsEscape(eventDescription(ev.dividend, ev.type, splits))}`,
      `CATEGORIES:${icsEscape(EVENT_TYPES[ev.type].label)}`,
      `STATUS:${ev.dividend.expected ? 'TENTATIVE' : 'CONFIRMED'}`,
      'TRANSP:TRANSPARENT',
    );
    if (ev.dividend.source_url) L.push(`URL:${ev.dividend.source_url}`);
    const a = alarms && !ev.dividend.expected && ALARMS[ev.type];
    if (a) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(`${a.text}: ${ev.title}`)}`, `TRIGGER:${a.trigger}`, 'END:VALARM');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

// ---------- assembling a calendar ----------
/** Declared dividends plus projections, ready for toEvents(). */
export function calendarDividends(declared, { today = todayISO(), includeExpected = true, splits = [] } = {}) {
  const base = declared.map((d) => ({ ...d, expected: false }));
  return includeExpected ? [...base, ...projectExpected(base, today, { splits })] : base;
}
