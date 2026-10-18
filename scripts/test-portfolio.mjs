import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { positions, summarise, portfolioDividends, checkTrade, splitFactor } from '../src/lib/portfolio.js';

const seed = JSON.parse(readFileSync(new URL('../src/data/seed.json', import.meta.url)));
const splits = [{ symbol: 'NMB', ex_date: '2026-08-26', ratio: 10 }];
const today = '2026-10-18';
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

// --- average cost, fees, partial sell
let id = 1;
const t = (symbol, side, trade_date, shares, price, fees = 0) => ({ id: id++, symbol, side, trade_date, shares, price, fees });
const crdb = [
  t('CRDB', 'buy', '2024-03-08', 1000, 520, 9000),
  t('CRDB', 'buy', '2025-01-02', 500, 670, 5700),
  t('CRDB', 'sell', '2026-02-02', 600, 1800, 18360),
];
let p = positions(crdb, splits).CRDB;
const avgBefore = (1000 * 520 + 9000 + 500 * 670 + 5700) / 1500;
near(p.shares, 900);
near(p.avgCost, avgBefore);
near(p.realised, 600 * 1800 - 18360 - 600 * avgBefore);
console.log('average cost ok: avg', p.avgCost.toFixed(2), 'realised', Math.round(p.realised));

// --- splits: pre-split NMB buy restated in today's shares
assert.equal(splitFactor('NMB', '2026-06-01', splits), 10);
assert.equal(splitFactor('NMB', '2026-08-26', splits), 1);
const nmb = [t('NMB', 'buy', '2026-06-01', 100, 17000), t('NMB', 'buy', '2026-09-01', 500, 1900)];
p = positions(nmb, splits).NMB;
near(p.shares, 1500);
near(p.cost, 100 * 17000 + 500 * 1900);
console.log('split ok: 100 pre-split + 500 post = 1500 shares');

// --- oversell is flagged, not silently allowed
const bad = [t('TBL', 'buy', '2025-01-02', 10, 10900), t('TBL', 'sell', '2025-06-01', 15, 11000)];
p = positions(bad, splits).TBL;
assert.equal(p.problems.length, 1);
assert.equal(p.shares, 0);
assert.match(checkTrade({ symbol: 'TBL', side: 'sell', trade_date: '2025-06-01', shares: 15, price: 1 }, [bad[0]], splits), /only 10/);
assert.equal(checkTrade({ symbol: 'TBL', side: 'sell', trade_date: '2025-06-01', shares: 10, price: 1 }, [bad[0]], splits), null);
// deleting/editing an earlier buy that a later sell depends on is caught too
assert.ok(checkTrade({ ...bad[0], shares: 5 }, [bad[0], { ...bad[1], shares: 8 }], splits));
console.log('oversell checks ok');

// --- dividends: entitlement by ex-date, split-adjusted cash, withholding
// CRDB FY2025: ex 5 May 2026, pays 90 on 1 Jun 2026. Holding then: 900 shares.
// CRDB FY2024: books close 9 May 2025 (ex est. 8 May), 65/share; holding then 1,500.
const divs = portfolioDividends(crdb, splits, seed, { today });
const crdb25 = divs.find((r) => r.symbol === 'CRDB' && r.dividend.fiscal_year === 'FY2025');
const crdb24 = divs.find((r) => r.symbol === 'CRDB' && r.dividend.fiscal_year === 'FY2024');
assert.equal(crdb25.status, 'received'); near(crdb25.shares, 900); near(crdb25.net, 900 * 90 * 0.95);
assert.equal(crdb24.status, 'received'); near(crdb24.shares, 1500); near(crdb24.net, 1500 * 65 * 0.95);
const crdbNext = divs.find((r) => r.symbol === 'CRDB' && r.status === 'expected');
near(crdbNext.shares, 900);
console.log('CRDB dividends ok:', divs.filter((r) => r.symbol === 'CRDB').map((r) => `${r.dividend.fiscal_year} ${r.status} ${Math.round(r.net)}`).join(' | '));

// NMB: 100 shares bought 1 Jun 2026 (before ex 11 Jun) -> entitled to FY2025 final + special.
// Declared 504.26 + 105.89 per pre-split share = 61.015 per current share, on 1,000 current shares.
const nd = portfolioDividends(nmb, splits, seed, { today }).filter((r) => r.status === 'received');
near(nd.reduce((s, r) => s + r.gross, 0), 1000 * (504.26 + 105.89) / 10, 0.05);
near(nd.reduce((s, r) => s + r.gross, 0), 100 * (504.26 + 105.89), 0.05); // same cash as declared on 100 old shares
console.log('NMB split-adjusted dividend ok: TZS', Math.round(nd.reduce((s, r) => s + r.gross, 0)), 'gross');

// Bought after the ex-date: not entitled.
const late = portfolioDividends([t('VODA', 'buy', '2026-08-18', 1000, 1250)], splits, seed, { today });
assert.ok(!late.some((r) => r.dividend.fiscal_year === 'FY2026 (Mar)' && !r.dividend.expected));
const ontime = portfolioDividends([t('VODA', 'buy', '2026-08-17', 1000, 1250)], splits, seed, { today });
const voda = ontime.find((r) => r.dividend.fiscal_year === 'FY2026 (Mar)');
assert.equal(voda.status, 'received'); near(voda.gross, 23910);
console.log('ex-date cut-off ok (bought 17 Aug qualifies, 18 Aug does not)');

// --- summary
const s = summarise([...crdb, ...nmb], { splits, prices: { CRDB: { close: 2830, date: '2026-10-16' }, NMB: { close: 1990, date: '2026-10-16' } }, dividends: seed, today });
near(s.totals.value, 900 * 2830 + 1500 * 1990);
assert.ok(s.totals.dividendsReceived > 0 && s.totals.dividendsNext12m > 0);
assert.equal(s.problems.length, 0);
console.log('summary ok:', JSON.stringify({ value: Math.round(s.totals.value), unrealised: Math.round(s.totals.unrealised), realised: Math.round(s.totals.realised), received: Math.round(s.totals.dividendsReceived), next12m: Math.round(s.totals.dividendsNext12m) }));
console.log('all portfolio tests passed');
