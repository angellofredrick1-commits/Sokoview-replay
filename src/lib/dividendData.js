// Loads dividends, splits and latest prices for the dividend calendar.
// Live when VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are set (same as the
// replayer); otherwise the bundled seed — the same rows migration 0009 inserts.
import seed from '../data/seed.json';

const SB_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

export const isLive = Boolean(SB_URL && SB_KEY);

export const SAMPLE_SPLITS = [{ symbol: 'NMB', ex_date: '2026-08-26', ratio: 10 }];

// DSE closes on 15 Oct 2026, used only in sample mode.
const SAMPLE_PRICES = {
  AFRIPRISE: 735, CRDB: 2830, DSE: 6230, EABL: 5820, JHL: 8700, MKCB: 3810, NICO: 3530,
  NMB: 1990, SWIS: 2310, TBL: 9800, TCC: 13370, TPCC: 5710, VODA: 1270,
};

const NAMES = {
  AFRIPRISE: 'Afriprise Investment', CRDB: 'CRDB Bank', DSE: 'Dar es Salaam Stock Exchange',
  EABL: 'East African Breweries', JHL: 'Jubilee Holdings', MKCB: 'Mkombozi Commercial Bank',
  NICO: 'National Investment Company', NMB: 'NMB Bank', SWIS: 'Swissport Tanzania',
  TBL: 'Tanzania Breweries', TCC: 'Tanzania Cigarette Company', TPCC: 'Tanzania Portland Cement (Twiga)',
  VODA: 'Vodacom Tanzania',
};

function sample(notice) {
  return {
    mode: 'sample',
    notice,
    splits: SAMPLE_SPLITS,
    dividends: seed.map((d) => ({ ...d, name: NAMES[d.symbol] || d.symbol, price: SAMPLE_PRICES[d.symbol] ?? null })),
  };
}

async function sbFetch(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    let m = `${res.status} ${res.statusText}`;
    try { const b = await res.json(); if (b?.message) m += ` — ${b.message}`; } catch { /* not json */ }
    const err = new Error(m);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function loadCalendarData() {
  if (!isLive) return sample();
  let rows;
  try {
    rows = await sbFetch('dividend_calendar?select=*&order=pay_date.asc');
  } catch (e) {
    // The view only exists once migration 0009 has run.
    if (e.status === 404 || /dividend_calendar/.test(e.message)) {
      return sample('Dividend table not found — run migration 0009. Showing sample data.');
    }
    throw e;
  }
  const splits = await sbFetch('corporate_action?select=symbol,ex_date,value&kind=eq.split').catch(() => []);
  return {
    mode: 'live',
    dividends: rows.map((d) => ({ ...d, amount: Number(d.amount), price: d.price == null ? null : Number(d.price) })),
    splits: splits.map((s) => ({ symbol: s.symbol, ex_date: s.ex_date, ratio: Number(s.value) })),
  };
}

// ---------- watchlist (per browser) ----------
const WATCH_KEY = 'sv.divcal.watchlist';
export function readWatchlist() {
  try { const v = JSON.parse(localStorage.getItem(WATCH_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function writeWatchlist(list) {
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
