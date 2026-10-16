import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { keyDates, calendarDividends, toEvents, buildICS, adjustedAmount, googleCalendarUrl, prevBusinessDay } from '../src/lib/dividends.js';

const seed = JSON.parse(readFileSync(new URL('../src/data/seed.json', import.meta.url)));
const splits = [{ symbol: 'NMB', ex_date: '2026-08-26', ratio: 10 }];
const today = '2026-10-16';

// CRDB: ex 5 May (Tue) → last day to buy Mon 4 May — matches the notice ("cum dividend to 4th May").
const crdb = seed.find((d) => d.symbol === 'CRDB' && d.fiscal_year === 'FY2025');
assert.equal(keyDates(crdb).lastbuy, '2026-05-04');
// NMB notice: last cum day 10 June.
const nmb = seed.find((d) => d.symbol === 'NMB' && d.kind === 'final' && d.fiscal_year === 'FY2025');
assert.equal(keyDates(nmb).lastbuy, '2026-06-10');
// VODA notice: cum to 17 Aug.
const voda = seed.find((d) => d.symbol === 'VODA' && d.fiscal_year.startsWith('FY2026'));
assert.equal(keyDates(voda).lastbuy, '2026-08-17');
// Record-only: estimated ex one business day before.
const nico = seed.find((d) => d.symbol === 'NICO');
const kn = keyDates(nico);
assert.equal(kn.ex, '2025-09-23'); assert.ok(kn.estimated.ex && kn.estimated.lastbuy);
assert.equal(prevBusinessDay('2026-05-18'), '2026-05-15');
// Split adjustment.
assert.equal(adjustedAmount(nmb, splits).toFixed(3), '50.426');
assert.equal(adjustedAmount(crdb, splits), 90);

const divs = calendarDividends(seed, { today, splits });
assert.equal(divs.find((d) => d.expected && d.symbol === 'NMB').amount.toFixed(3), '50.426');
const exp = divs.filter((d) => d.expected);
console.log('expected:', exp.map((d) => `${d.symbol} ${d.kind} pay ${d.pay_date}`).join(' | '));
assert.ok(!exp.find((d) => d.kind === 'special'));
assert.deepEqual(exp.filter((d) => d.stale).map((d) => d.symbol).sort(), ['NICO', 'TCC']);
assert.ok(!exp.find((d) => d.symbol === 'AFRIPRISE').stale);
assert.ok(exp.find((d) => d.symbol === 'AFRIPRISE'));
assert.ok(exp.find((d) => d.symbol === 'CRDB' && d.pay_date.startsWith('2027')));
const evs = toEvents(divs, { splits, today });
assert.ok(!evs.find((e) => e.dividend.expected && e.date < today));
const upcoming = evs.filter((e) => e.date >= today).slice(0, 8);
console.log(upcoming.map((e) => `${e.date} ${e.title}`).join('\n'));

const ics = buildICS(toEvents(divs, { splits, today, types: ['lastbuy', 'pay'] }), { splits, now: new Date('2026-10-16T10:00:00Z') });
for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, 'line too long: ' + line);
assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);

console.log('ics events:', (ics.match(/BEGIN:VEVENT/g) || []).length, 'url ok:', googleCalendarUrl(evs[0], splits).startsWith('https://calendar.google.com'));
console.log('all tests passed');
