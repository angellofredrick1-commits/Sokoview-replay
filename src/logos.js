/**
 * Company marks, served from our own origin at /logos/{SYMBOL}.png.
 *
 * Normalised to 256px squares with the mark CONTAIN-fitted rather than cropped,
 * because several are wide lockups (Vodacom, NMB, Swissport, Kenya Airways) and
 * a square crop would cut the wordmark in half.
 *
 * Anything not listed renders as a coloured monogram. That is deliberate — the
 * two ETFs have no published mark, and a monogram reads better than a broken
 * image.
 */

const AVAILABLE = new Set([
  "CRDB", "DCB", "DSE", "EABL", "KA", "KCB", "MBP", "MCB", "MKCB", "NMB",
  "PAL", "SWIS", "TBL", "TCC", "TCCL", "TOL", "TPCC", "TTP", "YETU",
]);

export function logoUrl(symbol) {
  return AVAILABLE.has(symbol) ? `/logos/${symbol}.png` : null;
}

/** Deterministic colour per symbol, so the fallback is stable and distinguishable. */
export function monogramColor(symbol) {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  const hues = [152, 210, 24, 340, 262, 190, 45, 0];
  return `hsl(${hues[h % hues.length]} 55% 42%)`;
}

export function monogramText(symbol) {
  return symbol.replace(/[^A-Z0-9]/g, "").slice(0, 3);
}

/** Symbols still needing a logo — kept visible rather than silently monogrammed. */
/** Unit trusts have no logo; their monograms read cleanly as three letters. */
export const FUND_SYMBOLS = ["UMOJA","WEKEZA","WATOTO","JIKIMU","LIQUID","BOND"];

export const MISSING_LOGOS = [
  "VODA", "NICO", "JATU", "SWALA", "USL", "JHL", "NMG", "MUCOBA",
  "AFRIPRISE", "VERTEX-ETF", "IEACLC-ETF", "ZAN-ETF",
];
