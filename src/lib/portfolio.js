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
