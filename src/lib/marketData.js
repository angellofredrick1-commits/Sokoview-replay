// Shared reads for the investor pages: instrument list (for search), the latest
// market snapshot, and growth since January 2025. Live when the two VITE_
// Supabase variables are set; otherwise small samples so local dev still renders.

const SB_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
export const isLive = Boolean(SB_URL && SB_KEY);

const headers = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: 'application/json' });

async function sbGet(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function sbRpc(fn) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ---------- instruments (search) ----------
// Fallback list mirrors the instrument table as of Oct 2026.
const FALLBACK_INSTRUMENTS = [
  ['AFRIPRISE', 'Afriprise Investment', 'equity'], ['CRDB', 'CRDB Bank', 'equity'],
  ['DCB', 'DCB Commercial Bank', 'equity'], ['DSE', 'Dar es Salaam Stock Exchange', 'equity'],
  ['EABL', 'East African Breweries', 'equity'], ['JATU', 'Jatu PLC', 'equity'],
  ['JHL', 'Jubilee Holdings', 'equity'], ['KA', 'Kenya Airways', 'equity'],
  ['KCB', 'Kenya Commercial Bank', 'equity'], ['MBP', 'Maendeleo Bank', 'equity'],
  ['MCB', 'Mwalimu Commercial Bank', 'equity'], ['MKCB', 'Mkombozi Commercial Bank', 'equity'],
  ['MUCOBA', 'Mucoba Bank', 'equity'], ['NICO', 'National Investment Company', 'equity'],
  ['NMB', 'NMB Bank', 'equity'], ['NMG', 'Nation Media Group', 'equity'],
  ['PAL', 'Precision Air Services', 'equity'], ['SWALA', 'Swala Gas and Oil', 'equity'],
  ['SWIS', 'Swissport Tanzania', 'equity'], ['TBL', 'Tanzania Breweries', 'equity'],
  ['TCC', 'Tanzania Cigarette Company', 'equity'], ['TCCL', 'Tanga Cement', 'equity'],
  ['TOL', 'TOL Gases', 'equity'], ['TPCC', 'Tanzania Portland Cement (Twiga)', 'equity'],
  ['TTP', 'Tatepa Company', 'equity'], ['USL', 'Uchumi Supermarket', 'equity'],
  ['VODA', 'Vodacom Tanzania', 'equity'], ['YETU', 'Yetu Microfinance', 'equity'],
  ['IEACLC-ETF', 'iTrust EAC Large Cap ETF', 'etf'], ['VERTEX-ETF', 'Vertex International Securities ETF', 'etf'],
  ['BOND', 'Bond Fund', 'fund'], ['ICASH', 'iCash', 'fund'], ['IDOLLAR', 'iDollar', 'fund'],
  ['IGROWTH', 'iGrowth', 'fund'], ['IINCOME', 'iIncome', 'fund'], ['IMAAN', 'Imaan', 'fund'],
  ['ISAVE', 'iSave', 'fund'], ['JIKIMU', 'Jikimu Fund', 'fund'], ['LIQUID', 'Liquid Fund', 'fund'],
  ['UMOJA', 'Umoja Fund', 'fund'], ['WATOTO', 'Watoto Fund', 'fund'], ['WEKEZA', 'Wekeza Maisha Fund', 'fund'],
].map(([symbol, name, kind]) => ({ symbol, name, kind }));

const CACHE_KEY = 'sv.instruments.v1';
let instrumentsPromise = null;

export function loadInstruments() {
  if (instrumentsPromise) return instrumentsPromise;
  instrumentsPromise = (async () => {
    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      if (Array.isArray(cached) && cached.length) return cached;
    } catch { /* no storage */ }
    if (!isLive) return FALLBACK_INSTRUMENTS;
    try {
      const rows = await sbGet('instrument?select=symbol,name,kind&is_active=eq.true&order=symbol.asc');
      const list = rows.map((r) => ({ symbol: r.symbol, name: r.name || r.symbol, kind: r.kind || 'equity' }));
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch { /* full or blocked */ }
      return list;
    } catch {
      return FALLBACK_INSTRUMENTS;
    }
  })();
  return instrumentsPromise;
}

// ---------- market snapshot ----------
// DSE closes for 15 Oct 2026 (sample mode only).
const SAMPLE_SNAPSHOT = [
  ['AFRIPRISE', 735, 0.68], ['CRDB', 2830, -0.35], ['DCB', 390, 0], ['DSE', 6230, -0.95], ['EABL', 5820, -1.02],
  ['JATU', 230, 0], ['JHL', 8700, 0], ['KA', 120, -4], ['KCB', 2190, 0], ['MBP', 2010, -1.47], ['MCB', 375, -1.32],
  ['MKCB', 3810, -3.05], ['MUCOBA', 420, 2.44], ['NICO', 3530, -4.34], ['NMB', 1990, -0.5], ['NMG', 310, -4.62],
  ['PAL', 300, 3.45], ['SWALA', 450, 0], ['SWIS', 2310, -6.1], ['TBL', 9800, 1.14], ['TCC', 13370, 0.15],
  ['TCCL', 4170, 1.96], ['TOL', 1680, -5.08], ['TPCC', 5710, 0.35], ['TTP', 420, 0], ['USL', 30, 0],
  ['VODA', 1270, -0.78], ['YETU', 510, 0],
].map(([symbol, close, pct]) => {
  const name = FALLBACK_INSTRUMENTS.find((i) => i.symbol === symbol)?.name || symbol;
  const prev = close / (1 + pct / 100);
  return { symbol, name, close, change: close - prev, pct_change: pct, traded: pct !== 0, trade_date: '2026-10-15' };
});

const SAMPLE_GROWTH = [
  { symbol: 'MKCB', name: 'Mkombozi Commercial Bank', start_date: '2025-01-02', start_close: 540, latest_close: 3810, pct_change: 605.56 },
  { symbol: 'MBP', name: 'Maendeleo Bank', start_date: '2025-01-02', start_close: 310, latest_close: 2010, pct_change: 548.39 },
  { symbol: 'NICO', name: 'National Investment Company', start_date: '2025-01-02', start_close: 640, latest_close: 3530, pct_change: 451.56 },
];

const num = (v) => (v == null ? null : Number(v));

export async function loadMarket() {
  if (!isLive) return { mode: 'sample', snapshot: SAMPLE_SNAPSHOT, growth: SAMPLE_GROWTH };
  const [snap, growth] = await Promise.all([
    sbRpc('market_snapshot'),
    sbRpc('growth_since_jan_2025').catch(() => []),
  ]);
  return {
    mode: 'live',
    snapshot: snap.map((r) => ({ ...r, close: num(r.close), change: num(r.change), pct_change: num(r.pct_change) })),
    growth: growth.map((r) => ({ ...r, start_close: num(r.start_close), latest_close: num(r.latest_close), pct_change: num(r.pct_change) })),
  };
}
