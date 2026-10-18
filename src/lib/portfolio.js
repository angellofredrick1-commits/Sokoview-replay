// Portfolio maths, from a user's own buys and sells. Pure functions: no DOM, no network.
//
// Conventions
// - Average cost: each sell takes out cost at the running average (common for retail
//   reporting; Tanzania doesn't tax DSE capital gains for residents, so no lot matching).
// - Fees are part of cost on a buy and come off proceeds on a sell.
// - Splits: every trade is restated in today's shares. A buy of 100 NMB at 17,700
//   before the 1-for-10 split counts as 1,000 shares at 1,770.
// - Dividends: you qualify if you held the shares at the close of the day before
//   the ex-date (i.e. bought on or before the last day to buy).

import { adjustedAmount, calendarDividends, keyDates } from './dividends.js';

export const WITHHOLDING = 0.05;
const EPS = 1e-6;

/** Split factor from a trade date to today: product of every later split's ratio. */
export function splitFactor(symbol, date, splits = []) {
  return splits
    .filter((s) => s.symbol === symbol && s.ex_date > date)
    .reduce((f, s) => f * Number(s.ratio || 1), 1);
}

const sortTxns = (txns) =>
  [...txns].sort((a, b) =>
    a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1
      // same day: buys before sells, then by entry order
      : a.side !== b.side ? (a.side === 'buy' ? -1 : 1) : (a.id ?? 0) - (b.id ?? 0));

/** Trades restated in today's shares. */
export function normalise(txns, splits = []) {
  return sortTxns(txns).map((t) => {
    const f = splitFactor(t.symbol, t.trade_date, splits);
    return { ...t, shares: Number(t.shares) * f, price: Number(t.price) / f, fees: Number(t.fees || 0), factor: f };
  });
}

/**
 * Holdings per symbol at a point in time (default: everything).
 * Returns { [symbol]: { shares, cost, avgCost, realised, bought, soldProceeds, firstDate, problems[] } }
 */
export function positions(txns, splits = [], { asOf, before } = {}) {
  const out = {};
  for (const t of normalise(txns, splits)) {
    if (asOf && t.trade_date > asOf) continue;
    if (before && t.trade_date >= before) continue;
    const p = (out[t.symbol] ||= { symbol: t.symbol, shares: 0, cost: 0, realised: 0, invested: 0, proceeds: 0, fees: 0, firstDate: t.trade_date, problems: [] });
    p.fees += t.fees;
    if (t.side === 'buy') {
      p.shares += t.shares;
      p.cost += t.shares * t.price + t.fees;
      p.invested += t.shares * t.price + t.fees;
    } else {
      let qty = t.shares;
      if (qty > p.shares + EPS) {
        p.problems.push({ id: t.id, date: t.trade_date, message: `Sells ${fmtShares(qty)} but only ${fmtShares(p.shares)} were held on ${t.trade_date}.` });
        qty = p.shares; // count what could have been sold, so the rest of the maths stays sane
      }
      const avg = p.shares > EPS ? p.cost / p.shares : 0;
      const costOut = avg * qty;
      const proceeds = qty * t.price - t.fees;
      p.realised += proceeds - costOut;
      p.proceeds += proceeds;
      p.shares -= qty;
      p.cost -= costOut;
      if (p.shares < EPS) { p.shares = 0; p.cost = 0; }
    }
  }
  for (const p of Object.values(out)) p.avgCost = p.shares > EPS ? p.cost / p.shares : null;
  return out;
}

const fmtShares = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });

/** Shares held when a dividend's entitlement was fixed, in today's shares. */
export function sharesEntitled(txns, splits, symbol, exDate) {
  const p = positions(txns.filter((t) => t.symbol === symbol), splits, { before: exDate })[symbol];
  return p ? p.shares : 0;
}

/**
 * Dividends for this user: received (paid, entitled), upcoming (declared, entitled or
 * still possible), and expected (not yet declared, at current holdings).
 */
export function portfolioDividends(txns, splits, declared, { today, withholding = WITHHOLDING } = {}) {
  const held = new Set(txns.map((t) => t.symbol));
  const relevant = declared.filter((d) => held.has(d.symbol));
  const all = calendarDividends(relevant, { today, splits, includeExpected: true });
  const current = positions(txns, splits, { asOf: today });
  const rows = [];
  for (const d of all) {
    if (d.stale) continue;
    const k = keyDates(d);
    const cutoff = k.ex || d.record_date || d.pay_date;
    if (!cutoff || !d.pay_date) continue;
    const perShare = d.expected ? Number(d.amount) : adjustedAmount(d, splits);
    let shares; let status;
    if (d.expected) {
      shares = current[d.symbol]?.shares || 0; status = 'expected';
    } else if (cutoff <= today) {
      shares = sharesEntitled(txns, splits, d.symbol, cutoff);
      status = d.pay_date <= today ? 'received' : 'due';
    } else {
      // Declared but the ex-date hasn't passed: what you'd get if you still hold then.
      shares = current[d.symbol]?.shares || 0; status = 'if-held';
    }
    if (shares <= EPS) continue;
    const gross = shares * perShare;
    rows.push({
      id: `${d.symbol}-${d.fiscal_year}-${d.kind}${d.expected ? '-exp' : ''}`,
      dividend: d, symbol: d.symbol, status, shares, perShare,
      currency: d.currency || 'TZS', gross, net: gross * (1 - withholding),
      payDate: d.pay_date, lastBuy: k.lastbuy, exDate: k.ex, estimated: Boolean(k.estimated.ex),
    });
  }
  rows.sort((a, b) => (a.payDate < b.payDate ? -1 : a.payDate > b.payDate ? 1 : a.symbol.localeCompare(b.symbol)));
  return rows;
}

/**
 * Everything the Portfolio page shows.
 * prices: { [symbol]: { close, date } } latest closes.
 */
export function summarise(txns, { splits = [], prices = {}, dividends = [], today }) {
  const pos = positions(txns, splits, { asOf: today });
  const holdings = Object.values(pos)
    .filter((p) => p.shares > EPS)
    .map((p) => {
      const last = prices[p.symbol]?.close ?? null;
      const value = last != null ? p.shares * last : null;
      const unrealised = value != null ? value - p.cost : null;
      return { ...p, last, lastDate: prices[p.symbol]?.date ?? null, value, unrealised, unrealisedPct: unrealised != null && p.cost > 0 ? (unrealised / p.cost) * 100 : null };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const closed = Object.values(pos).filter((p) => p.shares <= EPS && Math.abs(p.realised) > EPS);
  const divs = portfolioDividends(txns, splits, dividends, { today });
  const tzsOnly = (rows) => rows.filter((r) => r.currency === 'TZS');
  const received = tzsOnly(divs.filter((r) => r.status === 'received')).reduce((t, r) => t + r.net, 0);
  const yearAhead = addYears(today, 1);
  const nextYear = tzsOnly(divs.filter((r) => r.status !== 'received' && r.payDate <= yearAhead)).reduce((t, r) => t + r.net, 0);

  const value = holdings.reduce((t, h) => t + (h.value ?? 0), 0);
  const cost = holdings.reduce((t, h) => t + h.cost, 0);
  const realised = Object.values(pos).reduce((t, p) => t + p.realised, 0);
  const unpriced = holdings.filter((h) => h.value == null).map((h) => h.symbol);
  return {
    holdings, closed, dividends: divs,
    totals: {
      value, cost, unrealised: value - cost, unrealisedPct: cost > 0 ? ((value - cost) / cost) * 100 : null,
      realised, dividendsReceived: received, dividendsNext12m: nextYear,
      totalReturn: value - cost + realised + received,
    },
    problems: Object.values(pos).flatMap((p) => p.problems.map((x) => ({ ...x, symbol: p.symbol }))),
    unpriced,
  };
}

function addYears(iso, n) {
  const [y, m, d] = iso.split('-');
  return `${Number(y) + n}-${m}-${d}`;
}

/** Would adding/replacing this trade make any later sell exceed the shares held? */
export function checkTrade(candidate, txns, splits = []) {
  const others = txns.filter((t) => t.id == null || t.id !== candidate.id);
  const p = positions([...others, { ...candidate, id: candidate.id ?? Number.MAX_SAFE_INTEGER }].filter((t) => t.symbol === candidate.symbol), splits)[candidate.symbol];
  return p?.problems?.[0]?.message ?? null;
}

// ============================================================================
// Analytics
// ============================================================================

const monthKey = (iso) => iso.slice(0, 7);

/** Best and worst holding by % gain, and the biggest contributor in shillings. */
export function performers(holdings) {
  const priced = holdings.filter((h) => h.unrealisedPct != null);
  if (!priced.length) return null;
  const byPct = [...priced].sort((a, b) => b.unrealisedPct - a.unrealisedPct);
  const byTzs = [...priced].sort((a, b) => b.unrealised - a.unrealised);
  const total = priced.reduce((t, h) => t + h.value, 0);
  return {
    best: byPct[0],
    worst: byPct.length > 1 ? byPct[byPct.length - 1] : null,
    contributor: byTzs[0],
    largest: [...priced].sort((a, b) => b.value - a.value)[0],
    weights: Object.fromEntries(priced.map((h) => [h.symbol, total ? (h.value / total) * 100 : 0])),
  };
}

/** Money in and out per month, plus headline counts. Amounts in TZS, fees included. */
export function activity(txns) {
  const months = {};
  const bySymbol = {};
  let bought = 0; let sold = 0; let buys = 0; let sells = 0;
  for (const t of sortTxns(txns)) {
    const m = (months[monthKey(t.trade_date)] ||= { month: monthKey(t.trade_date), bought: 0, sold: 0, trades: 0 });
    const amt = Number(t.shares) * Number(t.price);
    m.trades += 1;
    if (t.side === 'buy') {
      const cash = amt + Number(t.fees || 0);
      m.bought += cash; bought += cash; buys += 1;
      bySymbol[t.symbol] = (bySymbol[t.symbol] || 0) + cash;
    } else {
      const cash = amt - Number(t.fees || 0);
      m.sold += cash; sold += cash; sells += 1;
    }
  }
  const series = Object.values(months).sort((a, b) => (a.month < b.month ? -1 : 1)).map((m) => ({ ...m, net: m.bought - m.sold }));
  const mostBought = Object.entries(bySymbol).sort((a, b) => b[1] - a[1])[0];
  const sorted = sortTxns(txns);
  return {
    series,
    trades: txns.length, buys, sells, bought, sold,
    avgBuy: buys ? bought / buys : null,
    mostBought: mostBought ? { symbol: mostBought[0], amount: mostBought[1] } : null,
    first: sorted[0]?.trade_date ?? null,
    last: sorted[sorted.length - 1]?.trade_date ?? null,
    activeMonths: series.filter((m) => m.bought > 0).length,
  };
}

/** Every month from the first trade's month to today's, as YYYY-MM. */
export function monthsBetween(fromIso, toIso) {
  const out = [];
  let [y, m] = fromIso.slice(0, 7).split('-').map(Number);
  const [ty, tm] = toIso.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * Money-weighted annual return (XIRR). flows: [{ date, amount }] with money in
 * negative and money out positive. null when it can't be solved or the span is
 * under ~3 months (annualising a few weeks exaggerates wildly).
 */
export function xirr(flows) {
  if (flows.length < 2) return null;
  const t0 = Date.parse(flows[0].date);
  const span = (Date.parse(flows[flows.length - 1].date) - t0) / 864e5;
  if (span < 90) return null;
  const npv = (r) => flows.reduce((s, f) => s + f.amount / (1 + r) ** ((Date.parse(f.date) - t0) / 864e5 / 365), 0);
  let lo = -0.99; let hi = 10;
  let flo = npv(lo); const fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2; const f = npv(mid);
    if (Math.abs(f) < 1e-6) return mid * 100;
    if (f * flo < 0) hi = mid; else { lo = mid; flo = f; }
  }
  return ((lo + hi) / 2) * 100;
}

/**
 * Your portfolio against the same money put into the DSE benchmark on the same days.
 * Every buy also "buys" the index with the same shillings; every sale takes the
 * same shillings back out. Price only on both sides, so it's like for like; the
 * dividend-inclusive figure is reported separately.
 *
 * indexAt: { [tradeDate]: level } for each trade date; indexNow: { date, level }.
 */
export function vsBenchmark(txns, { splits = [], value, today, indexAt, indexNow, dividendsReceived = 0, dividendRows = [] }) {
  if (!txns.length || !indexNow) return null;
  let units = 0; let missing = false;
  const flowsYou = []; const flowsIdx = [];
  for (const t of sortTxns(txns)) {
    const level = indexAt[t.trade_date];
    const cash = t.side === 'buy'
      ? -(Number(t.shares) * Number(t.price) + Number(t.fees || 0))
      : Number(t.shares) * Number(t.price) - Number(t.fees || 0);
    flowsYou.push({ date: t.trade_date, amount: cash });
    flowsIdx.push({ date: t.trade_date, amount: cash });
    if (!level) { missing = true; continue; }
    units += -cash / level; // buy adds units, sale removes them
  }
  if (missing) return null;
  const benchValue = units * indexNow.level;
  const invested = flowsYou.filter((f) => f.amount < 0).reduce((s, f) => s - f.amount, 0);
  const takenOut = flowsYou.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
  const youPriceOnly = xirr([...flowsYou, { date: today, amount: value }]);
  const youWithDivs = xirr([
    ...flowsYou,
    ...dividendRows.filter((r) => r.status === 'received' && r.currency === 'TZS').map((r) => ({ date: r.payDate, amount: r.net })),
    { date: today, amount: value },
  ].sort((a, b) => (a.date < b.date ? -1 : 1)));
  const bench = xirr([...flowsIdx, { date: today, amount: benchValue }]);
  const gainYou = value + takenOut - invested;
  const gainIdx = benchValue + takenOut - invested;
  return {
    value, benchValue, invested, takenOut,
    gainYou, gainIdx, edge: gainYou - gainIdx,
    gainYouPct: invested ? (gainYou / invested) * 100 : null,
    gainIdxPct: invested ? (gainIdx / invested) * 100 : null,
    annualYou: youPriceOnly, annualYouWithDividends: youWithDivs, annualIdx: bench,
    dividendsReceived,
    indexDate: indexNow.date,
  };
}

/**
 * Month-end portfolio value next to the benchmark bought with the same cash.
 * closes: { [symbol]: { [YYYY-MM]: adjustedClose } }; indexMonthly: { [YYYY-MM]: level };
 * indexAt: { [tradeDate]: level }.
 */
export function valueHistory(txns, { splits = [], closes = {}, indexMonthly = {}, indexAt = {}, today }) {
  if (!txns.length) return [];
  const sorted = sortTxns(txns);
  const months = monthsBetween(sorted[0].trade_date, today);
  const lastClose = {};
  const out = [];
  for (const mk of months) {
    const end = mk === monthKey(today) ? today : `${mk}-31`;
    const pos = positions(txns, splits, { asOf: end });
    let value = 0; let complete = true;
    for (const p of Object.values(pos)) {
      if (p.shares <= EPS) continue;
      const c = closes[p.symbol]?.[mk] ?? lastClose[p.symbol];
      if (c == null) { complete = false; continue; }
      lastClose[p.symbol] = c;
      value += p.shares * c;
    }
    let units = 0; let invested = 0;
    for (const t of sorted) {
      if (t.trade_date > end) break;
      const cash = t.side === 'buy' ? Number(t.shares) * Number(t.price) + Number(t.fees || 0) : -(Number(t.shares) * Number(t.price) - Number(t.fees || 0));
      invested += cash;
      const lvl = indexAt[t.trade_date];
      if (lvl) units += cash / lvl;
    }
    const lvlEnd = indexMonthly[mk];
    out.push({ month: mk, portfolio: complete ? Math.round(value) : null, benchmark: lvlEnd ? Math.round(units * lvlEnd) : null, invested: Math.round(invested) });
  }
  return out;
}
