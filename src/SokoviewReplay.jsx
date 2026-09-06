import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine, Customized,
} from "recharts";
import {
  Play, Pause, RotateCcw, ChevronDown, AlertTriangle, Loader2, Info,
  Sun, Moon, Sparkles, SlidersHorizontal, RefreshCw,
} from "lucide-react";
import { logoUrl, monogramColor, monogramText, brandColor } from "./logos.js";

/* ============================================================================
   1. DATA ADAPTER  —  the only part you rewrite for the real Sokoview API
   ==========================================================================*/

/**
 * Normalises whatever your API returns into: [{ date:'YYYY-MM-DD', close:Number, div:Number }]
 * It probes the field names most REST price APIs use, so there's a fair chance
 * it just works. If Sokoview uses different keys, edit the ?? chains below.
 */
function normalizeSeries(raw) {
  const rows =
    Array.isArray(raw) ? raw
    : raw?.data ?? raw?.results ?? raw?.prices ?? raw?.candles
      ?? raw?.series ?? raw?.history ?? raw?.items ?? [];

  return rows
    .map((r) => ({
      date: String(
        r.date ?? r.trade_date ?? r.timestamp ?? r.t ?? r.day ?? r.time ?? ""
      ).slice(0, 10),
      close: Number(
        r.close ?? r.closing_price ?? r.close_price ?? r.price ??
        r.c ?? r.last ?? r.last_price
      ),
      div: Number(r.dividend ?? r.div ?? r.dividend_per_share ?? 0) || 0,
    }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && isFinite(r.close) && r.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Reads price_adjusted from Supabase — split/bonus adjusted, so NMB does not
 * show a phantom 89% crash on its 1:10 split. Publishable key only; RLS makes
 * it read-only.
 */
const SB_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SB_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";

async function sbFetch(path, cfg) {
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Accept: "application/json" },
  });
  if (!res.ok) {
    let m = `${res.status} ${res.statusText}`;
    try { const b = await res.json(); if (b?.message) m += ` — ${b.message}`; } catch {}
    throw new Error(m);
  }
  return res.json();
}

/** Which symbols are liquid enough to simulate, and how badly they gap. */
async function fetchUniverse(cfg) {
  const rows = await sbFetch(
    "liquidity_profile?select=symbol,pct_days_traded,days,longest_dry_spell,first_day,last_day" +
    "&order=pct_days_traded.desc", cfg);
  return rows.map((r) => ({
    symbol: r.symbol,
    pctTraded: Number(r.pct_days_traded ?? 0),
    days: Number(r.days ?? 0),
    dry: Number(r.longest_dry_spell ?? 0),
    first: r.first_day, last: r.last_day,
  }));
}

/**
 * PostgREST caps a response at 1000 rows, so ten years of daily bars needs
 * paging through Range headers.
 */
async function fetchSeries({ symbol, from, cfg }) {
  const PAGE = 1000;
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url =
      `${cfg.url.replace(/\/$/, "")}/rest/v1/price_adjusted` +
      `?select=trade_date,close_adj,close_raw,volume` +
      `&symbol=eq.${encodeURIComponent(symbol)}` +
      (from ? `&trade_date=gte.${from}` : "") +
      `&order=trade_date.asc`;
    const res = await fetch(url, {
      headers: {
        apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Accept: "application/json",
        Range: `${offset}-${offset + PAGE - 1}`, "Range-Unit": "items",
      },
    });
    if (!res.ok) throw new Error(`${symbol}: ${res.status} ${res.statusText}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < PAGE) break;
    if (offset > 40000) break; // guard
  }
  return out
    .map((r) => ({
      date: String(r.trade_date).slice(0, 10),
      close: Number(r.close_adj ?? r.close_raw),
      volume: r.volume == null ? null : Number(r.volume),
      div: 0,
    }))
    .filter((b) => b.date && isFinite(b.close) && b.close > 0);
}

/**
 * Ten years of daily bars is too many to animate smoothly, and monthly DCA does
 * not need daily resolution. Keep the last bar of each period.
 */
function resample(bars, freq) {
  if (freq === "daily" || bars.length < 2) return bars;
  const key = (d) => {
    if (freq === "monthly") return d.slice(0, 7);
    // ISO-ish week bucket: days since epoch / 7
    return String(Math.floor(Date.parse(d + "T00:00:00Z") / 864e5 / 7));
  };
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const isLastOfPeriod =
      i === bars.length - 1 || key(bars[i + 1].date) !== key(bars[i].date);
    if (isLastOfPeriod) out.push(bars[i]);
  }
  return out;
}

/* ---- Demo universe: DSE-listed equities, plausible price paths ---------- */

const UNIVERSE = {
  CRDB:   { name: "CRDB Bank",              from: 160,   to: 1150, vol: 0.026, yield: 0.048 },
  NMB:    { name: "NMB Bank",               from: 2300,  to: 7500, vol: 0.024, yield: 0.052 },
  TBL:    { name: "Tanzania Breweries",     from: 11000, to: 10900, vol: 0.015, yield: 0.031 },
  TCC:    { name: "Tanzania Cigarette Co.", from: 17000, to: 16400, vol: 0.014, yield: 0.070 },
  TPCC:   { name: "Twiga Cement",           from: 2500,  to: 4300, vol: 0.020, yield: 0.043 },
  DSE:    { name: "DSE PLC",                from: 1000,  to: 1900, vol: 0.022, yield: 0.050 },
  SWIS:   { name: "Swissport Tanzania",     from: 1300,  to: 3900, vol: 0.028, yield: 0.061 },
  VODA:   { name: "Vodacom Tanzania",       from: 850,   to: 780,  vol: 0.019, yield: 0.047 },
  JATU:   { name: "Jatu PLC",               from: 750,   to: 400,  vol: 0.045, yield: 0 },
  UCHUMI: { name: "Uchumi Commercial Bank", from: 350,   to: 800,  vol: 0.034, yield: 0 },
  DCB:    { name: "DCB Commercial Bank",    from: 200,   to: 240,  vol: 0.030, yield: 0 },
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const DEMO_START = "2018-01-05";
const DEMO_WEEKS = 452;

/** Weekly bars with a seeded walk, a COVID drawdown, and annual June dividends. */
function buildDemoSeries(symbol) {
  const s = UNIVERSE[symbol];
  const seed = [...symbol].reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
  const rng = mulberry32(seed);
  const drift = Math.log(s.to / s.from) / DEMO_WEEKS;

  const t0 = Date.parse(DEMO_START);
  const bars = [];
  let px = s.from;

  for (let i = 0; i < DEMO_WEEKS; i++) {
    const date = new Date(t0 + i * 7 * 864e5).toISOString().slice(0, 10);
    // COVID: weeks 110-117 ≈ Feb–Apr 2020
    const shock = i >= 110 && i <= 117 ? -0.035 : i > 117 && i <= 135 ? 0.012 : 0;
    px *= Math.exp(drift + shock + s.vol * gauss(rng) - (s.vol * s.vol) / 2);
    px = Math.max(px, s.from * 0.12);

    // annual dividend, first bar of June, priced off the yield
    const [, mm] = date.split("-");
    const prevMonth = bars.length ? bars[bars.length - 1].date.split("-")[1] : null;
    const div = s.yield > 0 && mm === "06" && prevMonth !== "06" ? px * s.yield : 0;

    bars.push({ date, close: Math.round(px * 100) / 100, div: Math.round(div * 100) / 100 });
  }
  return bars;
}

const DEMO_CACHE = {};
const demoSeries = (sym) => (DEMO_CACHE[sym] ??= buildDemoSeries(sym));

/* ============================================================================
   2. ENGINE
   ==========================================================================*/

const DAY = 864e5;

function periodKey(d, freq) {
  const [y, m] = d.split("-");
  if (freq === "weekly") return d;
  if (freq === "monthly") return `${y}-${m}`;
  if (freq === "quarterly") return `${y}-Q${Math.floor((+m - 1) / 3)}`;
  return y;
}
function countPeriods(bars, freq) {
  const set = new Set();
  bars.forEach((b) => set.add(periodKey(b.date, freq)));
  return set.size || 1;
}

function xnpv(rate, flows) {
  const t0 = Date.parse(flows[0].date);
  return flows.reduce(
    (s, f) => s + f.amount / Math.pow(1 + rate, (Date.parse(f.date) - t0) / DAY / 365),
    0
  );
}
function xirr(flows) {
  if (flows.length < 2) return null;
  if (!flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null;
  let lo = -0.9999, hi = 10;
  let flo = xnpv(lo, flows);
  if (flo * xnpv(hi, flows) > 0) return null;
  for (let i = 0; i < 128; i++) {
    const mid = (lo + hi) / 2;
    const fm = xnpv(mid, flows);
    if (Math.abs(fm) < 1e-7) return mid;
    if (flo * fm < 0) hi = mid;
    else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/**
 * Walks the bars once and returns the full portfolio path.
 * Portfolio value = shares at market + uninvested cash + dividends taken out.
 * Cash is always counted, so lump and recurring stay comparable.
 */
function simulate(bars, cfg) {
  const { strategy, perPeriod, lumpAmount, freq, whole, reinvest, feePct } = cfg;
  let cash = 0, shares = 0, invested = 0, basis = 0;
  let divPaidOut = 0, divTotal = 0, peak = 0;
  const path = [], flows = [];
  let lastKey = null;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    let contrib = 0;

    if (strategy === "lump") {
      if (i === 0) contrib = lumpAmount;
    } else {
      const k = periodKey(b.date, freq);
      if (k !== lastKey) { contrib = perPeriod; lastKey = k; }
    }
    if (contrib > 0) {
      cash += contrib; invested += contrib;
      flows.push({ date: b.date, amount: -contrib });
    }

    if (b.div > 0 && shares > 0) {
      const d = shares * b.div;
      divTotal += d;
      if (reinvest) cash += d; else divPaidOut += d;
    }

    const unit = b.close * (1 + feePct);
    if (cash >= unit) {
      const qty = whole ? Math.floor(cash / unit) : cash / unit;
      if (qty > 0) { shares += qty; cash -= qty * unit; basis += qty * unit; }
    }

    const value = shares * b.close + cash + divPaidOut;
    peak = Math.max(peak, value);
    path.push({
      date: b.date, price: b.close, shares, invested, cash, value,
      divPaidOut, divTotal, basis,
      dd: peak > 0 ? (value - peak) / peak : 0,
    });
  }
  return { path, flows };
}

function metricsAt(sim, t) {
  const p = sim.path[t];
  if (!p) return null;
  const flows = sim.flows.filter((f) => f.date <= p.date).map((f) => ({ ...f }));
  let irr = null;
  if (flows.length && p.value > 0) {
    irr = xirr([...flows, { date: p.date, amount: p.value }]);
  }
  let mdd = 0;
  for (let i = 0; i <= t; i++) mdd = Math.min(mdd, sim.path[i].dd);
  return {
    ...p,
    gain: p.value - p.invested,
    roi: p.invested > 0 ? (p.value - p.invested) / p.invested : 0,
    irr,
    mdd,
    avgCost: p.shares > 0 ? p.basis / p.shares : 0,
  };
}

/* ============================================================================
   3. FORMATTING
   ==========================================================================*/

const nf = new Intl.NumberFormat("en-US");
const tzs = (n) =>
  n == null || !isFinite(n) ? "—" : "TZS " + nf.format(Math.round(n));
const compact = (n) => {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return Math.round(n).toString();
};
const pct = (n, d = 1) =>
  n == null || !isFinite(n) ? "—" : (n >= 0 ? "+" : "") + (n * 100).toFixed(d) + "%";
const prettyDate = (d) =>
  new Date(d + "T00:00:00").toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });

const monYr = (d) =>
  new Date(d + "T00:00:00").toLocaleDateString("en-GB", { month: "short", year: "numeric" });

/** TZS amount for the headline: full digits under a million, compact above. */
const amt = (n) => "TZS " + (n >= 1e6 ? axisCompact(n) : nf.format(Math.round(n)));

const FREQ_WORD = { weekly: "/week", monthly: "/month", quarterly: "/quarter", yearly: "/year" };

/** Round up to a friendly axis ceiling: 1 / 1.2 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 × 10^k. */
function niceCeil(x) {
  if (!isFinite(x) || x <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((v) => v >= m);
  return step * p;
}

const MONO = "'IBM Plex Mono', ui-monospace, monospace";

/** Terse axis labels: 120M, 1.5B, 82K — no trailing zeros. */
const axisCompact = (n) => {
  if (n == null || !isFinite(n)) return "";
  const a = Math.abs(n);
  const trim = (x) => String(parseFloat(x.toFixed(2)));
  if (a >= 1e9) return trim(n / 1e9) + "B";
  if (a >= 1e6) return trim(n / 1e6) + "M";
  if (a >= 1e3) return trim(n / 1e3) + "K";
  return trim(n);
};
const A_COLOR = "#22c55e";
const B_COLOR = "#0a0a0a";

/* ============================================================================
   3b. THEME
   ==========================================================================*/

const THEME_KEY = "sokoview-replay-theme";

/** Resolved once before first paint by the inline script in index.html. */
function readTheme() {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function useTheme() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);
  return [theme, () => setTheme((v) => (v === "dark" ? "light" : "dark"))];
}

/**
 * Recharts takes concrete colours, not CSS variables, so the chart internals
 * are mirrored here rather than themed in CSS.
 */
const CHART = {
  light: { grid: "#eceff1", axis: "#0a0a0a", axisW: 2, tick: "#374151", dash: "#d4d4d4",
           halo: "#ffffff", pill: "#fde047", pillInk: "#0a0a0a", plan: "#0a0a0a",
           pos: "#16a34a", neg: "#dc2626", zero: "#d1d5db" },
  dark:  { grid: "#262d2f", axis: "#8b9499", axisW: 1.5, tick: "#9aa3aa", dash: "#3a4245",
           halo: "#15191a", pill: "#facc15", pillInk: "#0a0a0a", plan: "#e8eaea",
           pos: "#4ade80", neg: "#f87171", zero: "#3a4245" },
};

/* ============================================================================
   4. UI ATOMS
   ==========================================================================*/

/**
 * Company mark. Falls back to a coloured monogram when there is no mapped logo
 * or the image fails to load — which happens more than you would like, since
 * these are hotlinked from the exchange.
 */
function StockMark({ symbol, size = 20, ring = false }) {
  const [failed, setFailed] = React.useState(false);
  const url = logoUrl(symbol);
  const px = { width: size, height: size };

  if (!url || failed) {
    return (
      <span
        className="inline-flex items-center justify-center rounded-full flex-shrink-0 font-extrabold text-white"
        style={{ ...px, background: monogramColor(symbol),
                 fontSize: Math.max(7, size * 0.34), letterSpacing: "-0.02em",
                 boxShadow: ring ? "0 0 0 2px #fff" : undefined }}
        aria-label={symbol}
      >
        {monogramText(symbol)}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={symbol}
      onError={() => setFailed(true)}
      loading="lazy"
      className="rounded-full object-contain bg-white flex-shrink-0"
      style={{ ...px, boxShadow: ring ? "0 0 0 2px #fff, 0 1px 4px rgba(0,0,0,.2)" : undefined }}
    />
  );
}

/**
 * The bucko-style end-of-line callout layer, drawn as a Recharts <Customized>
 * overlay so it knows where BOTH lines end and can keep the two callouts from
 * colliding. Each callout: circled company logo riding the line end, a rank
 * badge, a crown on the leader, the company name, the value in a highlighter
 * pill, and the return underneath.
 */
function LogoDot({ cx, cy, R, color, symbol, rank, C }) {
  const url = logoUrl(symbol);
  const clip = `co-${symbol.replace(/[^A-Za-z0-9]/g, "")}-${Math.round(cx)}-${Math.round(cy)}`;
  return (
    <g>
      <circle cx={cx} cy={cy} r={R + 2.5} fill={C.halo} />
      <circle cx={cx} cy={cy} r={R + 2.5} fill="none" stroke={color} strokeWidth={2.5} />
      {url ? (
        <>
          <clipPath id={clip}>
            <circle cx={cx} cy={cy} r={R} />
          </clipPath>
          <image
            href={url} x={cx - R} y={cy - R} width={R * 2} height={R * 2}
            clipPath={`url(#${clip})`} preserveAspectRatio="xMidYMid meet"
          />
        </>
      ) : (
        <>
          <circle cx={cx} cy={cy} r={R} fill={monogramColor(symbol)} />
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
                fontSize={R * 0.66} fontWeight="800" fill="#fff">
            {monogramText(symbol)}
          </text>
        </>
      )}
      {rank != null && (
        <>
          <circle cx={cx + R * 0.8} cy={cy + R * 0.8} r={9} fill={color} stroke={C.halo} strokeWidth={2} />
          <text x={cx + R * 0.8} y={cy + R * 0.8 + 0.5} textAnchor="middle" dominantBaseline="central"
                fontSize="10" fontWeight="800" fill="#fff">
            {rank}
          </text>
        </>
      )}
    </g>
  );
}

function Callout({ leg, R, narrow, svgW, C }) {
  const { cx, ty, color, symbol, name, rank, crown, pill, sub, subUp } = leg;
  const pillFs = narrow ? 11 : 13.5;
  const pillW = Math.round(pill.length * pillFs * 0.66) + 20;
  const pillH = narrow ? 21 : 26;

  if (narrow) {
    const px = Math.min(Math.max(cx - pillW / 2, 4), svgW - pillW - 4);
    return (
      <g>
        {crown && (
          <text x={cx} y={ty - R - 9} textAnchor="middle" fontSize="15">👑</text>
        )}
        <LogoDot cx={cx} cy={ty} R={R} color={color} symbol={symbol} rank={rank} C={C} />
        <rect x={px} y={ty + R + 7} width={pillW} height={pillH} rx={6} fill={C.pill} />
        <text x={px + pillW / 2} y={ty + R + 7 + pillH / 2 + 0.5} textAnchor="middle"
              dominantBaseline="central" fontSize={pillFs} fontWeight="800" fill={C.pillInk}
              style={{ fontVariantNumeric: "tabular-nums" }}>
          {pill}
        </text>
      </g>
    );
  }

  const blockW = Math.max(pillW, (name.length + symbol.length) * 7.6 + 18);
  let tx = cx + R + 13;
  if (tx + blockW > svgW - 6) {
    const leftTx = cx - R - 13 - blockW;
    tx = leftTx >= 8 ? leftTx : Math.max(8, svgW - 6 - blockW);
  }
  return (
    <g>
      <text x={tx} y={ty - 17}>
        <tspan fontSize="13" fontWeight="800" fill={color}>{name}</tspan>
        <tspan dx="7" fontSize="9.5" fontWeight="700" fill={C.tick} letterSpacing="1.5">{symbol}</tspan>
      </text>
      <rect x={tx} y={ty - 10} width={pillW} height={pillH} rx={7} fill={C.pill} />
      <text x={tx + 10} y={ty - 10 + pillH / 2 + 0.5} dominantBaseline="central"
            fontSize={pillFs} fontWeight="800" fill={C.pillInk}
            style={{ fontVariantNumeric: "tabular-nums" }}>
        {pill}
      </text>
      {sub && (
        <text x={tx + 1} y={ty + pillH + 6} fontSize="11" fontWeight="800"
              fill={subUp ? C.pos : C.neg}
              style={{ fontVariantNumeric: "tabular-nums" }}>
          {sub}
        </text>
      )}
      <LogoDot cx={cx} cy={ty} R={R} color={color} symbol={symbol} rank={rank} C={C} />
      {crown && (
        <text x={cx} y={ty - R - 10} textAnchor="middle" fontSize="17">👑</text>
      )}
    </g>
  );
}

function ChartCallouts(props) {
  const { formattedGraphicalItems, offset, width, legs, C } = props;
  if (!legs?.length || !formattedGraphicalItems || !offset) return null;
  const narrow = (offset.width ?? 0) < 480;
  const R = narrow ? 15 : 21;

  const resolved = [];
  for (const leg of legs) {
    const gi = formattedGraphicalItems.find(
      (g) => (g?.item?.props?.dataKey ?? g?.props?.dataKey) === leg.dataKey
    );
    const pts = gi?.props?.points || gi?.item?.props?.points || [];
    let last = null;
    for (let i = pts.length - 1; i >= 0; i--) {
      const pt = pts[i];
      if (pt && pt.y != null && isFinite(pt.y) && pt.payload?.[leg.dataKey] != null) { last = pt; break; }
    }
    if (last) resolved.push({ ...leg, cx: last.x, ty: last.y });
  }
  if (!resolved.length) return null;

  const minY = offset.top + R + (resolved.some((l) => l.crown) ? 24 : 6);
  const maxY = offset.top + offset.height - R - (narrow ? 34 : 6);
  resolved.forEach((l) => { l.ty = Math.max(minY, Math.min(maxY, l.ty)); });
  if (resolved.length === 2) {
    const gap = narrow ? 72 : 82;
    const [a, b] = [...resolved].sort((u, v) => u.ty - v.ty);
    if (b.ty - a.ty < gap) {
      const mid = (a.ty + b.ty) / 2;
      a.ty = Math.max(minY, mid - gap / 2);
      b.ty = Math.min(maxY, a.ty + gap);
      a.ty = Math.min(a.ty, b.ty - gap);
    }
  }

  return (
    <g style={{ pointerEvents: "none" }}>
      {resolved.map((l) => (
        <Callout key={l.dataKey} leg={l} R={R} narrow={narrow} svgW={width} C={C} />
      ))}
    </g>
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <div className="w-7 h-7 bg-ink rounded-md flex items-end gap-[2.5px] px-1.5 pb-[5px] pt-1">
        <div className="w-[3.5px] h-[5px] rounded-sm bg-green-500" />
        <div className="w-[3.5px] h-[8px] rounded-sm bg-green-500" />
        <div className="w-[3.5px] h-[11px] rounded-sm bg-green-500" />
      </div>
      <span className="text-[15px] font-extrabold tracking-tight text-ink">
        sokoview
      </span>
      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-pos bg-green-500/10 border border-green-500/25 px-2 py-[3px] rounded-full">
        replay
      </span>
    </div>
  );
}

/**
 * The only thing the header says about data: connected or not. No provider
 * names, no endpoints, no switch.
 */
function StatusPill({ live, conn }) {
  const loading = conn.state === "loading";
  const ok = live && conn.state !== "err";
  const label = loading ? "Connecting" : ok ? "Live" : "Offline";
  const dot = loading ? "#f59e0b" : ok ? "#22c55e" : "#9ca3af";
  return (
    <span
      className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-soft border border-line rounded-full pl-2 pr-2.5 py-[5px]"
      title={ok ? "Connected to live price history" : "Running on sample data"}
    >
      <span
        className="w-[7px] h-[7px] rounded-full flex-shrink-0"
        style={{ background: dot, boxShadow: `0 0 0 3px ${dot}22` }}
      />
      {label}
    </span>
  );
}

function Eyebrow({ children }) {
  return (
    <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-mute mb-2">
      {children}
    </div>
  );
}

function Seg({ options, value, onChange, accent = "green" }) {
  const on =
    accent === "green"
      ? "bg-green-500 text-white"
      : "bg-ink text-page";
  return (
    <div className="flex gap-1 p-1 bg-raised rounded-lg">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`flex-1 whitespace-nowrap text-[11px] font-bold py-1.5 px-2 rounded-md transition-colors ${
            value === o.v ? on : "text-soft hover:text-ink"
          }`}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

function NumField({ label, value, onChange, prefix, step = 1000, disabled }) {
  return (
    <label className="block">
      <Eyebrow>{label}</Eyebrow>
      <div
        className={`flex items-center border rounded-lg overflow-hidden ${
          disabled ? "bg-raised border-line" : "bg-surface border-line"
        }`}
      >
        {prefix && (
          <span className="pl-3 text-[11px] font-bold text-mute">{prefix}</span>
        )}
        <input
          type="number"
          step={step}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
          className="w-full px-2.5 py-2 text-[13px] font-bold text-ink outline-none tabular-nums bg-transparent disabled:text-mute"
        />
      </div>
    </label>
  );
}

function Toggle({ label, checked, onChange, hint }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="w-full flex items-start gap-2.5 text-left group"
    >
      <div
        className={`mt-[1px] w-8 h-[18px] rounded-full flex-shrink-0 transition-colors relative ${
          checked ? "bg-green-500" : "bg-line"
        }`}
      >
        <div
          className={`absolute top-[2px] w-[14px] h-[14px] bg-surface rounded-full transition-all ${
            checked ? "left-[16px]" : "left-[2px]"
          }`}
        />
      </div>
      <div>
        <div className="text-[12px] font-bold text-ink leading-tight">{label}</div>
        {hint && <div className="text-[10.5px] text-mute leading-snug mt-0.5">{hint}</div>}
      </div>
    </button>
  );
}

function Stat({ label, value, sub, tone = "default", big }) {
  const tones = {
    default: "text-ink",
    green: "text-pos",
    red: "text-neg",
    muted: "text-mute",
  };
  return (
    <div>
      <div className="text-[8.5px] font-bold uppercase tracking-[0.1em] text-mute">
        {label}
      </div>
      <div
        className={`font-extrabold tabular-nums tracking-tight ${tones[tone]} ${
          big ? "text-[22px] leading-tight" : "text-[15px] leading-snug"
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[10px] text-mute tabular-nums">{sub}</div>}
    </div>
  );
}

/* ============================================================================
   5. LEG PANEL
   ==========================================================================*/

function LiquidityNote({ liq }) {
  if (!liq) return null;
  const bad = liq.pctTraded < 25 || liq.dry > 60;
  const warn = liq.pctTraded < 55 || liq.dry > 21;
  if (!bad && !warn) return null;
  return (
    <div className={`mt-2 text-[10px] leading-snug rounded-md px-2 py-1.5 border ${
      bad ? "bg-alertbg border-alertln text-alerttx"
          : "bg-warnbg border-warnln text-warntx"}`}>
      Traded on {liq.pctTraded.toFixed(0)}% of days, longest gap {liq.dry} days.
      {bad
        ? " Too thin to simulate regular buying — treat any result as indicative only."
        : " Regular purchases would sometimes have waited weeks to fill."}
    </div>
  );
}

function LegPanel({ leg, set, color, title, enabled, onToggle, canDisable, symbols, lockLump, lockedValue, liq }) {
  const dim = !enabled;
  return (
    <div
      className={`rounded-xl border p-3.5 transition-opacity ${
        dim ? "opacity-40 border-line" : "border-line"
      }`}
      style={!dim ? { borderColor: color === A_COLOR ? "rgba(34,197,94,.35)" : color + "55" } : {}}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
          <span className="text-[12px] font-extrabold text-ink">{title}</span>
        </div>
        {canDisable && (
          <button
            onClick={onToggle}
            className="text-[10px] font-bold text-mute hover:text-ink"
          >
            {enabled ? "Remove" : "Add"}
          </button>
        )}
      </div>

      <div className={dim ? "pointer-events-none" : ""}>
        <div className="mb-3">
          <Eyebrow>Stock</Eyebrow>
          <div className="relative flex items-center gap-2">
            <StockMark symbol={leg.symbol} size={26} />
            <select
              value={leg.symbol}
              onChange={(e) => set({ symbol: e.target.value })}
              className="w-full appearance-none bg-surface border border-line rounded-lg pl-3 pr-8 py-2 text-[13px] font-bold text-ink outline-none"
            >
              {symbols.map((s) => (
                <option key={s} value={s}>
                  {s}
                  {UNIVERSE[s] ? ` · ${UNIVERSE[s].name}` : ""}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-mute absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
          <LiquidityNote liq={liq} />
        </div>

        <div className="mb-3">
          <Eyebrow>Strategy</Eyebrow>
          <Seg
            accent={color === A_COLOR ? "green" : "black"}
            value={leg.strategy}
            onChange={(v) => set({ strategy: v })}
            options={[
              { v: "lump", l: "One-time" },
              { v: "dca", l: "Recurring" },
            ]}
          />
        </div>

        {leg.strategy === "dca" ? (
          <div className="grid grid-cols-2 gap-2.5">
            <NumField
              label="Each time"
              prefix="TZS"
              step={10000}
              value={leg.perPeriod}
              onChange={(v) => set({ perPeriod: v })}
            />
            <div>
              <Eyebrow>How often</Eyebrow>
              <div className="relative">
                <select
                  value={leg.freq}
                  onChange={(e) => set({ freq: e.target.value })}
                  className="w-full appearance-none bg-surface border border-line rounded-lg pl-3 pr-7 py-2 text-[12.5px] font-bold text-ink outline-none"
                >
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-mute absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
            </div>
          </div>
        ) : (
          <div>
            <NumField
              label={lockLump ? "Amount invested (matched)" : "Amount invested"}
              prefix="TZS"
              step={100000}
              value={lockLump ? Math.round(lockedValue) : leg.lumpAmount}
              onChange={(v) => set({ lumpAmount: v })}
              disabled={lockLump}
            />
            {lockLump && (
              <div className="text-[10px] text-mute mt-1 leading-snug">
                Matched to the other plan's total. Turn off capital matching to set it yourself.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
   6. APP
   ==========================================================================*/

export default function SokoviewReplay() {
  /* ---- source ----
     There is no data-source switch in the UI any more: the deploy either has
     Supabase credentials and runs on real prices, or it doesn't and falls back
     to sample paths. The header states which, and nothing else. */
  const LIVE = Boolean(SB_URL && SB_KEY);
  const source = LIVE ? "live" : "demo";
  const [liveData, setLiveData] = useState({});     // symbol -> bars
  const [universe, setUniverse] = useState([]);      // liquidity_profile rows
  const [resolution, setResolution] = useState("weekly"); // daily | weekly | monthly
  const sbCfg = { url: SB_URL, key: SB_KEY };
  const [conn, setConn] = useState({ state: "idle", msg: "" });
  const [theme, toggleTheme] = useTheme();
  const C = CHART[theme];
  const [panelOpen, setPanelOpen] = useState(false);  // settings drawer, mobile only
  const [narrow, setNarrow] = useState(
    typeof window !== "undefined" ? window.innerWidth < 640 : false
  );
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* ---- config ---- */
  const [legA, setLegA] = useState({
    symbol: "CRDB", strategy: "lump", lumpAmount: 5000000,
    perPeriod: 100000, freq: "monthly", autoLump: false,
  });
  const [legB, setLegB] = useState({
    symbol: "CRDB", strategy: "dca", lumpAmount: 5000000,
    perPeriod: 100000, freq: "monthly", autoLump: false,
  });
  const [bOn, setBOn] = useState(true);
  const [startYear, setStartYear] = useState(2016);
  const [matchCapital, setMatchCapital] = useState(true);
  const [whole, setWhole] = useState(true);
  const [reinvest, setReinvest] = useState(true);
  const [feePct, setFeePct] = useState(1.7);
  const [chartMode, setChartMode] = useState("value");

  /* ---- replay ---- */
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const raf = useRef(null);

  const symbols = source === "live" && universe.length
    ? universe.map((u) => u.symbol)
    : Object.keys(UNIVERSE);

  const liqOf = useMemo(() => {
    const m = {};
    universe.forEach((u) => { m[u.symbol] = u; });
    return m;
  }, [universe]);

  const getBars = useCallback(
    (sym) => {
      const raw = source === "live" ? liveData[sym] ?? [] : demoSeries(sym);
      return source === "live" ? resample(raw, resolution) : raw;
    },
    [source, liveData, resolution]
  );

  // Pull the tradeable universe once, then auto-load whatever the legs need.
  useEffect(() => {
    if (!LIVE) return;
    let cancelled = false;
    (async () => {
      try {
        const u = await fetchUniverse(sbCfg);
        if (!cancelled) setUniverse(u);
      } catch (e) {
        if (!cancelled) setConn({ state: "err", msg: e.message });
      }
    })();
    return () => { cancelled = true; };
  }, [LIVE]);

  /* ---- windowed bars, aligned across both legs ---- */
  const { barsA, barsB, n } = useMemo(() => {
    const cut = `${startYear}-01-01`;
    const a = getBars(legA.symbol).filter((b) => b.date >= cut);
    const b = bOn ? getBars(legB.symbol).filter((x) => x.date >= cut) : [];
    const n = bOn && b.length ? Math.min(a.length, b.length) : a.length;
    return { barsA: a.slice(0, n), barsB: b.slice(0, n), n };
  }, [getBars, legA.symbol, legB.symbol, startYear, bOn]);

  /* ---- capital matching ---- */
  const periodsA = useMemo(() => countPeriods(barsA, legA.freq), [barsA, legA.freq]);
  const periodsB = useMemo(() => countPeriods(barsB.length ? barsB : barsA, legB.freq), [barsB, barsA, legB.freq]);

  const cfg = (leg, periods, other, otherPeriods) => {
    let lumpAmount = leg.lumpAmount;
    if (matchCapital && leg.strategy === "lump" && other?.strategy === "dca") {
      lumpAmount = other.perPeriod * otherPeriods;
    }
    return {
      strategy: leg.strategy,
      perPeriod: leg.perPeriod,
      lumpAmount,
      freq: leg.freq,
      whole,
      reinvest,
      feePct: feePct / 100,
    };
  };

  const cfgA = useMemo(
    () => cfg(legA, periodsA, bOn ? legB : null, periodsB),
    [legA, legB, bOn, periodsA, periodsB, matchCapital, whole, reinvest, feePct]
  );
  const cfgB = useMemo(
    () => cfg(legB, periodsB, legA, periodsA),
    [legA, legB, periodsA, periodsB, matchCapital, whole, reinvest, feePct]
  );
  const simA = useMemo(() => (barsA.length ? simulate(barsA, cfgA) : null), [barsA, cfgA]);
  const simB = useMemo(() => (bOn && barsB.length ? simulate(barsB, cfgB) : null), [bOn, barsB, cfgB]);

  /* ---- keep t in range ---- */
  useEffect(() => {
    setT(Math.max(0, n - 1));
    setPlaying(false);
  }, [n, legA.symbol, legB.symbol, startYear, bOn]);

  /* ---- playback loop ---- */
  useEffect(() => {
    if (!playing || n === 0) return;
    let last = performance.now();
    const stepMs = 45 / speed;
    const tick = (now) => {
      if (now - last >= stepMs) {
        last = now;
        setT((prev) => Math.min(prev + 1, n - 1));
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, n]);

  // stop cleanly at the end, outside the state updater
  useEffect(() => {
    if (playing && n > 0 && t >= n - 1) setPlaying(false);
  }, [playing, t, n]);

  const play = () => {
    if (t >= n - 1) setT(0);
    setPlaying(true);
  };
  const restart = () => { setT(0); setPlaying(false); };

  /* ---- current metrics ---- */
  const mA = useMemo(() => (simA ? metricsAt(simA, t) : null), [simA, t]);
  const mB = useMemo(() => (simB ? metricsAt(simB, t) : null), [simB, t]);

  /* ---- line colours: company brand colours when two stocks race ---- */
  const { colorA, colorB } = useMemo(() => {
    if (!bOn || legA.symbol === legB.symbol) return { colorA: A_COLOR, colorB: C.plan };
    const ca = brandColor(legA.symbol);
    let cb = brandColor(legB.symbol);
    if (cb === ca) cb = C.plan;
    return { colorA: ca, colorB: cb };
  }, [bOn, legA.symbol, legB.symbol, C.plan]);

  const nameOf = (sym) => UNIVERSE[sym]?.name ?? sym;

  /* ---- chart data ----
     The axes stay FIXED across the whole replay (bucko-style): every row of the
     window is always present, values are simply null beyond t so the lines grow
     across a still frame instead of the frame rescaling. Phantom future rows
     extend the x-axis ~24% past the end, which both reads as "the story
     continues" and reserves room for the end-of-line callouts. */
  const { chartData, xTicks, yDomain, yTicks } = useMemo(() => {
    if (!simA) return { chartData: [], xTicks: [], yDomain: [0, 1], yTicks: undefined };
    const nA = simA.path.length;
    const rows = [];
    for (let i = 0; i < nA; i++) {
      const a = simA.path[i];
      const b = simB?.path[i];
      const on = i <= t;
      const row = { date: a.date };
      if (chartMode === "value") {
        row.aVal = on ? a.value : null;
        row.aInv = on ? a.invested : null;
        if (b) { row.bVal = on ? b.value : null; row.bInv = on ? b.invested : null; }
      } else if (chartMode === "roi") {
        row.aVal = on ? (a.invested > 0 ? ((a.value - a.invested) / a.invested) * 100 : 0) : null;
        if (b) row.bVal = on ? (b.invested > 0 ? ((b.value - b.invested) / b.invested) * 100 : 0) : null;
      } else {
        row.aVal = on ? a.price : null;
        if (b) row.bVal = on ? b.price : null;
      }
      rows.push(row);
    }
    const step = nA > 1
      ? (Date.parse(simA.path[nA - 1].date) - Date.parse(simA.path[0].date)) / (nA - 1)
      : 7 * DAY;
    const pad = Math.max(4, Math.round(nA * 0.27));
    const lastMs = Date.parse(simA.path[nA - 1].date);
    for (let k = 1; k <= pad; k++) {
      rows.push({ date: new Date(lastMs + step * k).toISOString().slice(0, 10) });
    }
    const xTicks = [rows[0].date, rows[Math.floor(rows.length / 2)].date, rows[rows.length - 1].date];

    let hi = 0, lo = 0;
    const scan = (path) => {
      for (const q of path) {
        if (chartMode === "value") hi = Math.max(hi, q.value, q.invested);
        else if (chartMode === "price") hi = Math.max(hi, q.price);
        else {
          const r = q.invested > 0 ? ((q.value - q.invested) / q.invested) * 100 : 0;
          hi = Math.max(hi, r); lo = Math.min(lo, r);
        }
      }
    };
    scan(simA.path);
    if (simB) scan(simB.path);
    const yMaxN = niceCeil((hi || 1) * 1.06);
    let yDomain, yTicks;
    if (chartMode === "roi") {
      yDomain = [Math.min(0, Math.floor(lo * 1.06)), yMaxN];
      yTicks = undefined;
    } else {
      yDomain = [0, yMaxN];
      yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * yMaxN));
    }
    return { chartData: rows, xTicks, yDomain, yTicks };
  }, [simA, simB, t, chartMode]);

  /* ---- end-of-line callouts ---- */
  const calloutLegs = useMemo(() => {
    if (!mA) return [];
    const same = bOn && mB && legA.symbol === legB.symbol;
    const planWord = (leg) =>
      leg.strategy === "lump" ? "One-time" :
      { weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" }[leg.freq] + " top-up";
    const mk = (dataKey, leg, m, color) => ({
      dataKey,
      symbol: leg.symbol,
      name: same ? planWord(leg) : nameOf(leg.symbol),
      color,
      value: m.value,
      pill: chartMode === "roi" ? pct(m.roi) : chartMode === "price" ? tzs(m.price) : tzs(m.value),
      sub: chartMode === "value" ? pct(m.roi) : null,
      subUp: m.roi >= 0,
    });
    const legs = [mk("aVal", legA, mA, colorA)];
    if (bOn && mB) legs.push(mk("bVal", legB, mB, colorB));
    if (legs.length === 2) {
      const aLead = mA.value >= mB.value;
      legs[0].rank = aLead ? 1 : 2;
      legs[1].rank = aLead ? 2 : 1;
      legs[aLead ? 0 : 1].crown = true;
    }
    return legs;
  }, [mA, mB, legA.symbol, legB.symbol, bOn, chartMode, colorA, colorB]);

  /* ---- presets ---- */
  const applyPreset = (p) => {
    setPlaying(false);
    if (p === "lumpVsDca") {
      setLegA((s) => ({ ...s, strategy: "lump" }));
      setLegB((s) => ({ ...s, symbol: legA.symbol, strategy: "dca" }));
      setBOn(true); setMatchCapital(true);
    } else if (p === "stockVsStockLump" || p === "stockVsStockDca") {
      const strat = p === "stockVsStockLump" ? "lump" : "dca";
      const other = symbols.find((s) => s !== legA.symbol) ?? legA.symbol;
      setLegA((s) => ({ ...s, strategy: strat }));
      setLegB((s) => ({
        ...s, strategy: strat,
        symbol: s.symbol === legA.symbol ? other : s.symbol,
      }));
      setBOn(true); setMatchCapital(false);
    } else {
      setBOn(false);
    }
  };

  /* ---- load price history from Supabase ---- */
  const loadSymbols = useCallback(async (syms) => {
    if (!SB_URL || !SB_KEY) {
      setConn({ state: "err", msg: "Supabase is not configured for this deploy." });
      return;
    }
    const need = [...new Set(syms)].filter((s) => s && !liveData[s]);
    if (!need.length) return;
    setConn({ state: "loading", msg: "" });
    try {
      const results = await Promise.all(
        need.map(async (sym) => [sym, await fetchSeries({ symbol: sym, cfg: sbCfg })])
      );
      setLiveData((d) => {
        const next = { ...d };
        results.forEach(([sym, bars]) => { if (bars.length) next[sym] = bars; });
        return next;
      });
      const empty = results.filter(([, b]) => !b.length).map(([s]) => s);
      setConn({
        state: "ok",
        msg: results.filter(([, b]) => b.length)
          .map(([s, b]) => `${s}: ${b.length} bars`).join(" · ") +
          (empty.length ? ` · no history for ${empty.join(", ")}` : ""),
      });
    } catch (e) {
      setConn({ state: "err", msg: e.message });
    }
  }, [liveData]);

  // Auto-load whenever a leg's symbol changes.
  useEffect(() => {
    if (!LIVE) return;
    loadSymbols(bOn ? [legA.symbol, legB.symbol] : [legA.symbol]);
  }, [LIVE, legA.symbol, legB.symbol, bOn, loadSymbols]);

  /* ---- the editorial headline, built from the current settings ---- */
  const phraseOf = (leg, c) =>
    leg.strategy === "lump" ? `${amt(c.lumpAmount)} once` : `${amt(c.perPeriod)}${FREQ_WORD[leg.freq]}`;
  const phraseA = phraseOf(legA, cfgA);
  const phraseB = phraseOf(legB, cfgB);
  const startMon = barsA.length ? monYr(barsA[0].date) : "";
  const sameSymbol = bOn && legA.symbol === legB.symbol;
  const samePlan = bOn && !sameSymbol && phraseA === phraseB;

  const Amount = ({ children }) => <span className="text-green-500">{children}</span>;
  const Name = ({ children }) => <span className="headline-serif">{children}</span>;
  const When = ({ children }) => <span className="text-mute">{children}</span>;

  const headline = !bOn ? (
    <>You put <Amount>{phraseA}</Amount> into <Name>{nameOf(legA.symbol)}</Name> starting <When>{startMon}</When></>
  ) : sameSymbol ? (
    <>You put <Amount>{phraseA}</Amount> vs <Amount>{phraseB}</Amount> into <Name>{nameOf(legA.symbol)}</Name> starting <When>{startMon}</When></>
  ) : samePlan ? (
    <>You put <Amount>{phraseA}</Amount> into each of <Name>{nameOf(legA.symbol)}</Name> and <Name>{nameOf(legB.symbol)}</Name> starting <When>{startMon}</When></>
  ) : (
    <>You put <Amount>{phraseA}</Amount> into <Name>{nameOf(legA.symbol)}</Name> and <Amount>{phraseB}</Amount> into <Name>{nameOf(legB.symbol)}</Name> starting <When>{startMon}</When></>
  );

  const chipLegs = sameSymbol || !bOn
    ? [{ symbol: legA.symbol, color: colorA }]
    : [{ symbol: legA.symbol, color: colorA }, { symbol: legB.symbol, color: colorB }];

  /* ---- leaderboard ---- */
  const labelFor = (leg) =>
    `${leg.symbol} · ${leg.strategy === "lump" ? "one-time" : `${leg.freq} top-up`}`;
  const board = useMemo(() => {
    const rows = [];
    if (mA) rows.push({ key: "A", symbol: legA.symbol, name: nameOf(legA.symbol), plan: labelFor(legA), value: mA.value, roi: mA.roi, color: colorA });
    if (bOn && mB) rows.push({ key: "B", symbol: legB.symbol, name: nameOf(legB.symbol), plan: labelFor(legB), value: mB.value, roi: mB.roi, color: colorB });
    return rows.sort((u, v) => v.value - u.value);
  }, [mA, mB, bOn, legA, legB, colorA, colorB]);

  /* ---- Claude insights ----
     Keyed on the configuration, not the scrub position, so playing the replay
     or dragging the timeline never triggers a call. One request per distinct
     simulation, cached for the session. */
  const insightKey = useMemo(() => {
    if (!mA) return null;
    const legKey = (leg, c) =>
      `${leg.symbol}|${leg.strategy}|${c.lumpAmount}|${c.perPeriod}|${leg.freq}`;
    return [
      source, resolution, startYear, whole, reinvest, feePct,
      legKey(legA, cfgA), bOn ? legKey(legB, cfgB) : "-",
    ].join("~");
  }, [mA, source, resolution, startYear, whole, reinvest, feePct, legA, legB, cfgA, cfgB, bOn]);

  const insightCache = useRef(new Map());
  const [insight, setInsight] = useState({ state: "idle", items: [], msg: "" });

  const buildSummary = useCallback(() => {
    if (!simA || !mA) return null;
    const endIdx = simA.path.length - 1;
    const fin = (sim) => metricsAt(sim, sim.path.length - 1);
    const leg = (l, sim, c) => {
      const m = fin(sim);
      // Six evenly spaced checkpoints: enough shape for Claude to comment on,
      // a fraction of the tokens a full series would cost.
      const marks = [];
      for (let k = 1; k <= 6; k++) {
        const i = Math.round((endIdx * k) / 6);
        marks.push({ on: sim.path[i].date.slice(0, 7), worth: Math.round(sim.path[i].value) });
      }
      return {
        stock: `${nameOf(l.symbol)} (${l.symbol})`,
        plan: l.strategy === "lump"
          ? `one-time ${amt(c.lumpAmount)}`
          : `${amt(c.perPeriod)} every ${l.freq.replace("ly", "")}`,
        invested: Math.round(m.invested),
        worthNow: Math.round(m.value),
        totalReturnPct: +(m.roi * 100).toFixed(1),
        annualisedPct: m.irr == null ? null : +(m.irr * 100).toFixed(1),
        dividends: Math.round(m.divTotal),
        sharesHeld: Math.round(m.shares),
        cashNeverInvested: Math.round(m.cash),
        worstDropPct: +(m.mdd * 100).toFixed(1),
        checkpoints: marks,
      };
    };
    return {
      currency: "TZS",
      dataIsSample: source === "demo",
      period: { from: barsA[0].date, to: barsA[endIdx].date },
      brokerageFeePct: feePct,
      dividendsReinvested: reinvest,
      wholeSharesOnly: whole,
      planA: leg(legA, simA, cfgA),
      planB: bOn && simB ? leg(legB, simB, cfgB) : null,
    };
  }, [simA, simB, mA, bOn, legA, legB, cfgA, cfgB, barsA, feePct, reinvest, whole, source]);

  const fetchInsight = useCallback(async (key, { force = false } = {}) => {
    if (!key) return;
    if (!force && insightCache.current.has(key)) {
      setInsight({ state: "ok", items: insightCache.current.get(key), msg: "" });
      return;
    }
    const summary = buildSummary();
    if (!summary) return;
    setInsight({ state: "loading", items: [], msg: "" });
    try {
      const res = await fetch("/api/insight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(summary),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      const items = body.insights ?? [];
      insightCache.current.set(key, items);
      setInsight({ state: "ok", items, msg: "" });
    } catch (e) {
      setInsight({ state: "err", items: [], msg: e.message });
    }
  }, [buildSummary]);

  // Debounced so dragging the fee slider is one call, not thirty.
  useEffect(() => {
    if (!insightKey) return;
    if (insightCache.current.has(insightKey)) {
      setInsight({ state: "ok", items: insightCache.current.get(insightKey), msg: "" });
      return;
    }
    const id = setTimeout(() => fetchInsight(insightKey), 1100);
    return () => clearTimeout(id);
  }, [insightKey, fetchInsight]);

  const caption = source === "demo"
    ? "SAMPLE DATA · ILLUSTRATIVE ONLY"
    : chartMode === "value" ? "HISTORICAL PORTFOLIO VALUE · ADJUSTED PRICES"
    : chartMode === "roi" ? "RETURN ON MONEY INVESTED · ADJUSTED PRICES"
    : "HISTORICAL SHARE PRICE · ADJUSTED";

  const noData = n === 0;

  return (
    <div className="w-full min-h-screen bg-page text-ink antialiased">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&family=Instrument+Serif:ital@1&family=IBM+Plex+Mono:wght@500;600&display=swap');
        * { font-family: 'Sora', ui-sans-serif, system-ui, sans-serif; }
        .headline-serif { font-family: 'Instrument Serif', Georgia, serif; font-style: italic; font-weight: 400; font-size: 1.06em; letter-spacing: 0; }
        .tabular-nums { font-variant-numeric: tabular-nums; }
        .frame-shadow { box-shadow: var(--sv-shadow); }
        input[type=range]{ -webkit-appearance:none; appearance:none; background:transparent; }
        input[type=range]::-webkit-slider-runnable-track{ height:4px; background:var(--sv-line); border-radius:99px; }
        input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; width:18px; height:18px; margin-top:-7px; border-radius:50%; background:var(--sv-ink); border:3px solid var(--sv-surface); box-shadow:0 1px 4px rgba(0,0,0,.3); cursor:pointer; }
        input[type=range]::-moz-range-track{ height:4px; background:var(--sv-line); border-radius:99px; }
        input[type=range]::-moz-range-thumb{ width:18px; height:18px; border-radius:50%; background:var(--sv-ink); border:3px solid var(--sv-surface); cursor:pointer; }
        select option { background: var(--sv-surface); color: var(--sv-ink); }
        :focus-visible { outline: 2px solid #22c55e; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce){ *{ transition:none !important; animation:none !important; } }
      `}</style>

      {/* ---------- header: brand, connection status, theme ---------- */}
      <header className="border-b border-line px-4 sm:px-5 py-2.5 flex items-center justify-between gap-3 sticky top-0 bg-surface/95 backdrop-blur z-20">
        <Logo />
        <div className="flex items-center gap-2">
          <StatusPill live={LIVE} conn={conn} />
          <button
            onClick={toggleTheme}
            className="w-9 h-9 rounded-lg border border-line flex items-center justify-center text-soft hover:text-ink hover:border-ink"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Light theme" : "Dark theme"}
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {conn.state === "err" && (
        <div className="px-4 sm:px-5 py-2 bg-alertbg border-b border-alertln text-alerttx text-[11px] font-semibold flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
          <span>Couldn't reach price history — {conn.msg}</span>
        </div>
      )}

      <main className="max-w-6xl mx-auto px-5 pb-10">
        {noData ? (
          <section className="py-20 text-center">
            <div className="text-[15px] font-extrabold mb-1">No price history loaded</div>
            <div className="text-[12px] text-soft">
              Load a symbol from the Sokoview API, or switch to sample data to explore the tool.
            </div>
          </section>
        ) : (
          <>
            {/* ---------- editorial headline ---------- */}
            <section className="relative text-center pt-9 pb-7">
              <div
                className="absolute -top-10 left-1/2 -translate-x-1/2 w-[520px] h-[320px] rounded-full pointer-events-none"
                style={{ background: "radial-gradient(circle, rgba(34,197,94,.10) 0%, transparent 68%)" }}
              />
              <h1 className="relative max-w-3xl mx-auto text-[27px] sm:text-[40px] font-extrabold leading-[1.08] tracking-[-0.03em] text-ink">
                {headline}
              </h1>
              <div className="relative flex items-center justify-center gap-8 mt-6 flex-wrap">
                {chipLegs.map((c) => (
                  <div key={c.symbol} className="flex items-center gap-2.5">
                    <span className="rounded-full bg-white p-[3px]" style={{ boxShadow: `0 0 0 2.5px ${c.color}` }}>
                      <StockMark symbol={c.symbol} size={40} />
                    </span>
                    <div className="text-left">
                      <div className="text-[13px] font-extrabold leading-tight">{nameOf(c.symbol)}</div>
                      <div className="text-[9px] font-bold tracking-[0.2em] text-mute" style={{ fontFamily: MONO }}>
                        {c.symbol}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* On phones the chart comes first and settings collapse into a
                drawer, so the thing people came to see isn't below a wall of
                inputs. On lg the rail returns to the left column. */}
            <button
              onClick={() => setPanelOpen((v) => !v)}
              className="lg:hidden w-full mb-3 flex items-center justify-between gap-2 border border-line bg-surface rounded-xl px-4 py-3"
              aria-expanded={panelOpen}
            >
              <span className="flex items-center gap-2 text-[12.5px] font-extrabold">
                <SlidersHorizontal className="w-4 h-4 text-soft" /> Settings
              </span>
              <span className="text-[10.5px] font-bold text-soft truncate max-w-[55%] text-right">
                {legA.symbol}{bOn && legB.symbol !== legA.symbol ? ` vs ${legB.symbol}` : ""} · from {startYear}
              </span>
            </button>

            <div className="flex flex-col lg:grid lg:grid-cols-[300px_1fr] gap-5">
              {/* ---------- left rail ---------- */}
              <aside className={`space-y-4 order-2 lg:order-1 ${panelOpen ? "" : "hidden lg:block"}`}>
                <div>
                  <Eyebrow>Start from</Eyebrow>
                  <div className="flex flex-wrap gap-1.5">
                    {[2016, 2018, 2020, 2022, 2024, 2025, 2026].map((y) => (
                      <button
                        key={y}
                        onClick={() => setStartYear(y)}
                        className={`text-[11px] font-bold px-2.5 py-1.5 rounded-lg border ${
                          startYear === y
                            ? "bg-ink text-page border-neutral-950"
                            : "border-line text-soft hover:border-ink bg-surface"
                        }`}
                      >
                        {y}
                      </button>
                    ))}
                  </div>
                </div>

                {LIVE && (
                  <div>
                    <Eyebrow>Resolution</Eyebrow>
                    <Seg
                      value={resolution}
                      onChange={setResolution}
                      options={[
                        { v: "monthly", l: "Monthly" },
                        { v: "weekly", l: "Weekly" },
                        { v: "daily", l: "Daily" },
                      ]}
                    />
                  </div>
                )}

                <div>
                  <Eyebrow>Quick comparisons</Eyebrow>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { k: "lumpVsDca", l: "One-time vs recurring" },
                      { k: "stockVsStockLump", l: "Stock vs stock, one-time" },
                      { k: "stockVsStockDca", l: "Stock vs stock, recurring" },
                      { k: "single", l: "Single stock only" },
                    ].map((pr) => (
                      <button
                        key={pr.k}
                        onClick={() => applyPreset(pr.k)}
                        className="text-[10.5px] font-bold text-left px-2.5 py-2 rounded-lg border border-line bg-surface hover:border-green-500 hover:bg-green-500/5 leading-tight"
                      >
                        {pr.l}
                      </button>
                    ))}
                  </div>
                </div>

                <LegPanel
                  leg={legA}
                  set={(pr) => setLegA((st) => ({ ...st, ...pr }))}
                  color={colorA}
                  title="Plan A"
                  enabled
                  canDisable={false}
                  symbols={symbols}
                  lockLump={bOn && matchCapital && legA.strategy === "lump" && legB.strategy === "dca"}
                  lockedValue={legB.perPeriod * periodsB}
                  liq={liqOf[legA.symbol]}
                />
                <LegPanel
                  leg={legB}
                  set={(pr) => setLegB((st) => ({ ...st, ...pr }))}
                  color={bOn ? colorB : C.plan}
                  title="Plan B"
                  enabled={bOn}
                  onToggle={() => setBOn((v) => !v)}
                  canDisable
                  symbols={symbols}
                  lockLump={bOn && matchCapital && legB.strategy === "lump" && legA.strategy === "dca"}
                  lockedValue={legA.perPeriod * periodsA}
                  liq={liqOf[legB.symbol]}
                />

                <div className="rounded-xl border border-line bg-surface p-3.5 space-y-3">
                  <Eyebrow>Assumptions</Eyebrow>
                  {bOn &&
                    ((legA.strategy === "lump" && legB.strategy === "dca") ||
                      (legB.strategy === "lump" && legA.strategy === "dca")) && (
                      <Toggle
                        label="Match total capital"
                        checked={matchCapital}
                        onChange={setMatchCapital}
                        hint="Sets the one-time amount equal to everything the recurring plan contributes, so the comparison is like-for-like."
                      />
                    )}
                  <Toggle
                    label="Whole shares only"
                    checked={whole}
                    onChange={setWhole}
                    hint="The DSE doesn't trade fractions. Leftover cash waits for the next buy."
                  />
                  <Toggle
                    label="Reinvest dividends"
                    checked={reinvest}
                    onChange={setReinvest}
                    hint="Off means dividends are held as cash and still counted in your total."
                  />
                  <div>
                    <Eyebrow>Brokerage fee</Eyebrow>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0} max={3} step={0.1}
                        value={feePct}
                        onChange={(e) => setFeePct(Number(e.target.value))}
                        className="flex-1 h-4"
                      />
                      <span className="text-[12px] font-extrabold tabular-nums w-11 text-right">
                        {feePct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>
              </aside>

              {/* ---------- right: the frame, transport, leaderboard, details ---------- */}
              <section className="space-y-4 order-1 lg:order-2 min-w-0">
                {/* the shareable frame */}
                <div className="bg-surface border border-line rounded-3xl px-3 sm:px-6 pt-4 sm:pt-5 pb-2 frame-shadow">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div>
                      <div className="text-[30px] sm:text-[52px] font-extrabold tracking-[-0.035em] leading-none tabular-nums text-ink">
                        {barsA[t] ? monYr(barsA[t].date) : ""}
                      </div>
                      <div className="text-[10.5px] text-mute font-semibold mt-1.5 tabular-nums">
                        {legA.symbol} at {tzs(mA?.price)}
                        {mB && legB.symbol !== legA.symbol && <> · {legB.symbol} at {tzs(mB.price)}</>}
                      </div>
                    </div>
                    <Seg
                      value={chartMode}
                      onChange={setChartMode}
                      options={[
                        { v: "value", l: "Value" },
                        { v: "roi", l: "Return %" },
                        { v: "price", l: "Price" },
                      ]}
                    />
                  </div>

                  <div style={{ width: "100%", height: narrow ? 300 : 380 }}>
                    <ResponsiveContainer>
                      <ComposedChart data={chartData} margin={{ top: 30, right: narrow ? 22 : 34, bottom: 4, left: 0 }}>
                        <CartesianGrid stroke={C.grid} vertical={false} />
                        <XAxis
                          dataKey="date"
                          ticks={xTicks}
                          interval={0}
                          tick={{ fontSize: narrow ? 10 : 12, fill: C.tick, fontWeight: 600, fontFamily: MONO }}
                          tickFormatter={narrow ? (d) => monYr(d).replace(" 20", " '") : monYr}
                          tickMargin={10}
                          axisLine={{ stroke: C.axis, strokeWidth: C.axisW }}
                          tickLine={false}
                        />
                        <YAxis
                          domain={yDomain}
                          ticks={yTicks}
                          tick={{ fontSize: narrow ? 10 : 12, fill: C.tick, fontWeight: 600, fontFamily: MONO }}
                          tickFormatter={(v) => (chartMode === "roi" ? v.toFixed(0) + "%" : axisCompact(v))}
                          axisLine={{ stroke: C.axis, strokeWidth: C.axisW }}
                          tickLine={false}
                          width={narrow ? 42 : 50}
                        />
                        <Tooltip
                          contentStyle={{
                            borderRadius: 12, border: "1px solid var(--sv-line)",
                            background: "var(--sv-surface)", color: "var(--sv-ink)",
                            fontSize: 11, fontWeight: 700, boxShadow: "0 4px 16px rgba(0,0,0,.16)",
                          }}
                          itemStyle={{ color: "var(--sv-ink)" }}
                          labelStyle={{ color: "var(--sv-soft)" }}
                          labelFormatter={prettyDate}
                          formatter={(v, name) => [
                            chartMode === "roi" ? v.toFixed(1) + "%" : tzs(v),
                            {
                              aVal: nameOf(legA.symbol) + (sameSymbol ? " · A" : ""),
                              bVal: nameOf(legB.symbol) + (sameSymbol ? " · B" : ""),
                              aInv: "Money in (A)", bInv: "Money in (B)",
                            }[name] ?? name,
                          ]}
                        />
                        {chartMode === "roi" && <ReferenceLine y={0} stroke={C.zero} />}
                        {chartMode === "value" && (
                          <Line type="stepAfter" dataKey="aInv" stroke={C.dash} strokeWidth={1.5}
                                strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                        )}
                        {chartMode === "value" && bOn && (
                          <Line type="stepAfter" dataKey="bInv" stroke={C.dash} strokeWidth={1.5}
                                strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                        )}
                        <Line type="monotone" dataKey="aVal" stroke={colorA} strokeWidth={2.6}
                              dot={false} activeDot={false} isAnimationActive={false} />
                        {bOn && (
                          <Line type="monotone" dataKey="bVal" stroke={colorB} strokeWidth={2.6}
                                dot={false} activeDot={false} isAnimationActive={false} />
                        )}
                        <Customized component={(cp) => <ChartCallouts {...cp} legs={calloutLegs} C={C} />} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="relative flex items-center justify-center py-2.5 mt-1 border-t border-hair">
                    <span
                      className="text-[9px] text-mute font-semibold"
                      style={{ fontFamily: MONO, letterSpacing: "0.14em" }}
                    >
                      {caption}
                    </span>
                    <span className="absolute right-0 hidden min-[480px]:flex items-center gap-1.5 opacity-70">
                      <span className="w-4 h-4 bg-neutral-950 dark:bg-raised rounded-[4px] flex items-end gap-[1.5px] px-[3px] pb-[3px]">
                        <span className="w-[2px] h-[3px] rounded-[1px] bg-green-500" />
                        <span className="w-[2px] h-[5px] rounded-[1px] bg-green-500" />
                        <span className="w-[2px] h-[7px] rounded-[1px] bg-green-500" />
                      </span>
                      <span className="text-[10.5px] font-extrabold tracking-tight text-ink">sokoview</span>
                    </span>
                  </div>
                </div>

                {/* transport */}
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={() => (playing ? setPlaying(false) : play())}
                    className="w-11 h-11 rounded-full bg-ink text-page flex items-center justify-center hover:opacity-80 flex-shrink-0"
                    aria-label={playing ? "Pause replay" : "Play replay"}
                  >
                    {playing ? (
                      <Pause className="w-4 h-4" fill="currentColor" />
                    ) : (
                      <Play className="w-4 h-4 ml-0.5" fill="currentColor" />
                    )}
                  </button>
                  <button
                    onClick={restart}
                    className="w-9 h-9 rounded-full border border-line bg-surface flex items-center justify-center hover:border-ink flex-shrink-0"
                    aria-label="Restart replay"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>

                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, n - 1)}
                    value={t}
                    onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }}
                    className="flex-1 min-w-[180px] h-4 cursor-pointer"
                    aria-label="Scrub through history"
                  />

                  <div className="flex gap-1 p-1 bg-raised rounded-lg flex-shrink-0">
                    {[0.5, 1, 2, 4].map((sp) => (
                      <button
                        key={sp}
                        onClick={() => setSpeed(sp)}
                        className={`text-[10.5px] font-bold py-1 px-2 rounded ${
                          speed === sp ? "bg-surface shadow-sm text-ink" : "text-soft"
                        }`}
                      >
                        {sp}×
                      </button>
                    ))}
                  </div>
                </div>

                {/* leaderboard */}
                <div className={`grid gap-3 ${board.length > 1 ? "sm:grid-cols-2" : ""}`}>
                  {board.map((r, i) => (
                    <div
                      key={r.key}
                      className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${
                        i === 0 && board.length > 1
                          ? "bg-win border-winline"
                          : "bg-surface border-line"
                      }`}
                    >
                      <span className="text-[12px] font-bold text-mute w-4 flex-shrink-0" style={{ fontFamily: MONO }}>
                        {i + 1}
                      </span>
                      <span className="rounded-full bg-white p-[2px] flex-shrink-0" style={{ boxShadow: `0 0 0 2px ${r.color}` }}>
                        <StockMark symbol={r.symbol} size={30} />
                      </span>
                      <div className="min-w-0">
                        <div className="text-[13px] font-extrabold truncate leading-tight">{r.name}</div>
                        <div className="text-[9px] font-bold tracking-[0.1em] text-mute uppercase whitespace-nowrap" style={{ fontFamily: MONO }}>
                          {r.plan}
                        </div>
                      </div>
                      <div className="ml-auto text-right flex-shrink-0">
                        <div className="text-[15px] font-extrabold tabular-nums leading-tight">{tzs(r.value)}</div>
                        <div className={`text-[10.5px] font-bold tabular-nums ${r.roi >= 0 ? "text-pos" : "text-neg"}`}>
                          {pct(r.roi)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* what Claude noticed */}
                <div className="border border-line bg-surface rounded-2xl p-4">
                  <div className="flex items-center justify-between gap-2 mb-2.5">
                    <span className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.12em] text-soft">
                      <Sparkles className="w-3.5 h-3.5 text-pos" /> What stands out
                    </span>
                    <button
                      onClick={() => fetchInsight(insightKey, { force: true })}
                      disabled={insight.state === "loading"}
                      className="flex items-center gap-1.5 text-[10.5px] font-bold text-soft hover:text-ink disabled:opacity-40"
                    >
                      <RefreshCw className={`w-3 h-3 ${insight.state === "loading" ? "animate-spin" : ""}`} />
                      Refresh
                    </button>
                  </div>

                  {insight.state === "loading" && (
                    <div className="space-y-2" aria-live="polite">
                      {[0, 1].map((i) => (
                        <div key={i} className="h-3 rounded bg-raised animate-pulse" style={{ width: i ? "72%" : "92%" }} />
                      ))}
                    </div>
                  )}

                  {insight.state === "ok" && insight.items.length > 0 && (
                    <div className="space-y-3">
                      {insight.items.map((it, i) => (
                        <div key={i}>
                          <div className="text-[12px] font-extrabold text-ink leading-tight">{it.title}</div>
                          <div className="text-[11.5px] text-soft leading-relaxed mt-0.5">{it.body}</div>
                        </div>
                      ))}
                      <div className="text-[9.5px] text-mute pt-1">
                        Written by Claude from the figures above. Not investment advice.
                      </div>
                    </div>
                  )}

                  {insight.state === "err" && (
                    <div className="text-[11px] text-soft leading-snug">
                      Insights are unavailable right now. {insight.msg}
                    </div>
                  )}

                  {insight.state === "idle" && (
                    <div className="text-[11px] text-soft">Reading the results…</div>
                  )}
                </div>

                {/* result cards */}
                <div className={`grid gap-4 ${bOn ? "md:grid-cols-2" : ""}`}>
                  {[
                    { m: mA, leg: legA, color: colorA, title: "Plan A", show: true },
                    { m: mB, leg: legB, color: colorB, title: "Plan B", show: bOn },
                  ]
                    .filter((x) => x.show && x.m)
                    .map(({ m, leg, color, title }) => (
                      <div key={title} className="border border-line bg-surface rounded-2xl overflow-hidden">
                        <div
                          className="px-4 py-2.5 flex items-center justify-between"
                          style={{ background: color }}
                        >
                          <span className="text-[11px] font-extrabold text-white flex items-center gap-2">
                            <StockMark symbol={leg.symbol} size={18} ring />
                            {title} · {leg.symbol}
                          </span>
                          <span className="text-[10px] font-bold text-white/70">
                            {leg.strategy === "lump" ? "One-time" : `${leg.freq} top-up`}
                          </span>
                        </div>
                        <div className="p-4">
                          <div className="mb-4">
                            <Stat
                              label="Worth today"
                              value={tzs(m.value)}
                              big
                              tone={m.gain >= 0 ? "green" : "red"}
                              sub={`${pct(m.roi)} on ${tzs(m.invested)} invested`}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-y-3.5 gap-x-3">
                            <Stat
                              label="Profit"
                              value={tzs(m.gain)}
                              tone={m.gain >= 0 ? "green" : "red"}
                            />
                            <Stat
                              label="Annualised (money-weighted)"
                              value={pct(m.irr)}
                              tone={m.irr == null ? "muted" : m.irr >= 0 ? "green" : "red"}
                            />
                            <Stat label="Shares held" value={nf.format(Math.round(m.shares))} />
                            <Stat label="Average cost" value={tzs(m.avgCost)} />
                            <Stat label="Dividends" value={tzs(m.divTotal)} sub={reinvest ? "reinvested" : "held as cash"} />
                            <Stat label="Worst drop" value={pct(m.mdd)} tone="muted" />
                          </div>
                          {m.cash > 1 && (
                            <div className="mt-3 pt-3 border-t border-hair text-[10.5px] text-mute font-semibold tabular-nums">
                              {tzs(m.cash)} still uninvested
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                </div>

                {/* method note */}
                <div className="flex gap-2.5 text-[11px] text-soft leading-relaxed border border-line bg-surface rounded-xl p-3.5">
                  <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-mute" />
                  <p>
                    Comparing a one-time investment against a recurring one on total return alone is
                    misleading — the recurring plan has less money in the market for less time.
                    The <strong className="text-ink">annualised money-weighted return</strong> above
                    accounts for when each contribution actually landed, so it's the fairer number
                    to judge them by. Past results don't predict future ones.
                  </p>
                </div>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
