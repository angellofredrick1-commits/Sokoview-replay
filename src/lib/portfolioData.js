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
