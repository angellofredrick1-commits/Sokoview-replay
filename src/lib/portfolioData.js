// Reads and writes for the Portfolio page. Trades live in public.portfolio_txn, one
// row per buy or sell, private to the signed-in user (row-level security).
import { supabase } from './supabase.js';
import { todayISO } from './dividends.js';

export const configured = Boolean(supabase);

export class SetupError extends Error {}

function check(error) {
  if (!error) return;
  // Table or function missing: migration 0010 hasn't been run yet.
  if (['42P01', 'PGRST205', 'PGRST202', '42883'].includes(error.code) || /portfolio_txn|price_on/.test(error.message || '')) {
    throw new SetupError('Portfolio storage isn\'t set up yet: run supabase/migrations/0010_portfolio.sql.');
  }
  throw new Error(error.message || String(error));
}

// ---------- auth ----------
export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(cb) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}

export async function sendSignInLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${window.location.origin}/portfolio`, shouldCreateUser: true },
  });
  if (error) throw new Error(error.message);
}

export async function signOut() {
  await supabase.auth.signOut();
}

// ---------- trades ----------
const COLS = 'id,symbol,side,trade_date,shares,price,fees,note,created_at';

const clean = (r) => ({ ...r, shares: Number(r.shares), price: Number(r.price), fees: Number(r.fees || 0) });

export async function listTrades() {
  const { data, error } = await supabase.from('portfolio_txn').select(COLS).order('trade_date', { ascending: true }).order('id', { ascending: true });
  check(error);
  return data.map(clean);
}

export async function saveTrade(t) {
  const row = {
    symbol: t.symbol, side: t.side, trade_date: t.trade_date,
    shares: t.shares, price: t.price, fees: t.fees || 0, note: t.note || null,
  };
  const q = t.id
    ? supabase.from('portfolio_txn').update(row).eq('id', t.id).select(COLS).single()
    : supabase.from('portfolio_txn').insert(row).select(COLS).single();
  const { data, error } = await q;
  check(error);
  return clean(data);
}

export async function deleteTrade(id) {
  const { error } = await supabase.from('portfolio_txn').delete().eq('id', id);
  check(error);
}

// ---------- prices ----------
/** Close on the date, or the last close before it (weekends, holidays). null if none in the 30 days before. */
export async function priceOn(symbol, date) {
  const { data, error } = await supabase.rpc('price_on', { p_symbol: symbol, p_date: date });
  check(error);
  const row = Array.isArray(data) ? data[0] : data;
  return row ? { date: row.trade_date, close: Number(row.close) } : null;
}

export async function latestPrices(symbols) {
  const today = todayISO();
  const entries = await Promise.all(symbols.map(async (s) => {
    try { return [s, await priceOn(s, today)]; } catch { return [s, null]; }
  }));
  return Object.fromEntries(entries.filter(([, v]) => v));
}

// ---------- month-end prices (for the value chart) ----------
/** Last split-adjusted close of each month, per symbol: { CRDB: { '2025-01': 640, ... } }. */
export async function monthlyCloses(symbols, from) {
  if (!symbols.length) return {};
  const PAGE = 1000;
  const out = {};
  for (let offset = 0; offset < 50000; offset += PAGE) {
    const { data, error } = await supabase.from('price_adjusted').select('symbol,trade_date,close_adj')
      .in('symbol', symbols).gte('trade_date', from)
      .order('trade_date', { ascending: true }).range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data) (out[r.symbol] ||= {})[String(r.trade_date).slice(0, 7)] = Number(r.close_adj);
    if (data.length < PAGE) break;
  }
  return out;
}

// ---------- AI insight ----------
const INSIGHT_TTL = 24 * 3600 * 1000;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** Two or three AI-written observations; cached per summary for a day in this browser. */
export async function portfolioInsight(summary) {
  const body = JSON.stringify(summary);
  const key = `sv.pfinsight.${hash(body)}`;
  try {
    const hit = JSON.parse(localStorage.getItem(key));
    if (hit && Date.now() - hit.at < INSIGHT_TTL) return hit.insights;
  } catch { /* no cache */ }
  const res = await fetch('/api/portfolio-insight', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Insight unavailable (${res.status})`);
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), insights: data.insights })); } catch { /* full */ }
  return data.insights || [];
}
