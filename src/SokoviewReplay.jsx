import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine,
} from "recharts";
import {
  Play, Pause, RotateCcw, Plug, FlaskConical, ChevronDown, AlertTriangle,
  Check, Loader2, Info,
} from "lucide-react";
import { logoUrl, monogramColor, monogramText } from "./logos.js";

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

const A_COLOR = "#22c55e";
const B_COLOR = "#0a0a0a";

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
 * The travelling marker on the chart. Recharts hands us the pixel position of
 * each point; we only draw on the final one, so it rides the end of the line as
 * the replay advances.
 *
 * SVG <image> cannot fail over to a monogram the way <img> can, so unmapped
 * symbols get the monogram drawn directly.
 */
function makeLeadMarker(symbol, color, lastIndex, size = 30) {
  const url = logoUrl(symbol);
  const id = `clip-${symbol.replace(/[^A-Za-z0-9]/g, "")}`;
  return (props) => {
    const { cx, cy, index } = props;
    if (index !== lastIndex || cx == null || cy == null) return null;
    const r = size / 2;
    return (
      <g style={{ pointerEvents: "none" }}>
        <circle cx={cx} cy={cy} r={r + 2.5} fill="#fff" />
        <circle cx={cx} cy={cy} r={r + 2.5} fill="none" stroke={color} strokeWidth={2} />
        {url ? (
          <>
            <clipPath id={id}>
              <circle cx={cx} cy={cy} r={r} />
            </clipPath>
            <image
              href={url} x={cx - r} y={cy - r} width={size} height={size}
              clipPath={`url(#${id})`} preserveAspectRatio="xMidYMid meet"
            />
          </>
        ) : (
          <>
            <circle cx={cx} cy={cy} r={r} fill={monogramColor(symbol)} />
            <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
              fontSize={size * 0.34} fontWeight="800" fill="#fff">
              {monogramText(symbol)}
            </text>
          </>
        )}
      </g>
    );
  };
}

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <div className="w-7 h-7 bg-neutral-950 rounded-md flex items-end gap-[2.5px] px-1.5 pb-[5px] pt-1">
        <div className="w-[3.5px] h-[5px] rounded-sm bg-green-500" />
        <div className="w-[3.5px] h-[8px] rounded-sm bg-green-500" />
        <div className="w-[3.5px] h-[11px] rounded-sm bg-green-500" />
      </div>
      <span className="text-[15px] font-extrabold tracking-tight text-neutral-950">
        sokoview
      </span>
      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-green-600 bg-green-500/10 border border-green-500/25 px-2 py-[3px] rounded-full">
        replay
      </span>
    </div>
  );
}

function Eyebrow({ children }) {
  return (
    <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-gray-400 mb-2">
      {children}
    </div>
  );
}

function Seg({ options, value, onChange, accent = "green" }) {
  const on =
    accent === "green"
      ? "bg-green-500 text-white"
      : "bg-neutral-950 text-white";
  return (
    <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`flex-1 text-[11px] font-bold py-1.5 px-2 rounded-md transition-colors ${
            value === o.v ? on : "text-gray-500 hover:text-neutral-900"
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
          disabled ? "bg-gray-50 border-gray-200" : "bg-white border-gray-300"
        }`}
      >
        {prefix && (
          <span className="pl-3 text-[11px] font-bold text-gray-400">{prefix}</span>
        )}
        <input
          type="number"
          step={step}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
          className="w-full px-2.5 py-2 text-[13px] font-bold text-neutral-950 outline-none tabular-nums bg-transparent disabled:text-gray-400"
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
          checked ? "bg-green-500" : "bg-gray-300"
        }`}
      >
        <div
          className={`absolute top-[2px] w-[14px] h-[14px] bg-white rounded-full transition-all ${
            checked ? "left-[16px]" : "left-[2px]"
          }`}
        />
      </div>
      <div>
        <div className="text-[12px] font-bold text-neutral-900 leading-tight">{label}</div>
        {hint && <div className="text-[10.5px] text-gray-400 leading-snug mt-0.5">{hint}</div>}
      </div>
    </button>
  );
}

function Stat({ label, value, sub, tone = "default", big }) {
  const tones = {
    default: "text-neutral-950",
    green: "text-green-600",
    red: "text-red-600",
    muted: "text-gray-400",
  };
  return (
    <div>
      <div className="text-[8.5px] font-bold uppercase tracking-[0.1em] text-gray-400">
        {label}
      </div>
      <div
        className={`font-extrabold tabular-nums tracking-tight ${tones[tone]} ${
          big ? "text-[22px] leading-tight" : "text-[15px] leading-snug"
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[10px] text-gray-400 tabular-nums">{sub}</div>}
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
      bad ? "bg-red-50 border-red-200 text-red-700"
          : "bg-amber-50 border-amber-200 text-amber-700"}`}>
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
        dim ? "opacity-40 border-gray-200" : "border-gray-300"
      }`}
      style={!dim ? { borderColor: color === A_COLOR ? "rgba(34,197,94,.35)" : "#d4d4d4" } : {}}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
          <span className="text-[12px] font-extrabold text-neutral-950">{title}</span>
        </div>
        {canDisable && (
          <button
            onClick={onToggle}
            className="text-[10px] font-bold text-gray-400 hover:text-neutral-900"
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
              className="w-full appearance-none bg-white border border-gray-300 rounded-lg pl-3 pr-8 py-2 text-[13px] font-bold text-neutral-950 outline-none"
            >
              {symbols.map((s) => (
                <option key={s} value={s}>
                  {s}
                  {UNIVERSE[s] ? ` · ${UNIVERSE[s].name}` : ""}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-gray-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
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
                  className="w-full appearance-none bg-white border border-gray-300 rounded-lg pl-3 pr-7 py-2 text-[12.5px] font-bold text-neutral-950 outline-none"
                >
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="yearly">Yearly</option>
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-gray-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
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
              <div className="text-[10px] text-gray-400 mt-1 leading-snug">
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
  /* ---- source ---- */
  const [source, setSource] = useState(SB_URL && SB_KEY ? "live" : "demo");
  const [liveData, setLiveData] = useState({});     // symbol -> bars
  const [universe, setUniverse] = useState([]);      // liquidity_profile rows
  const [resolution, setResolution] = useState("weekly"); // daily | weekly | monthly
  const sbCfg = { url: SB_URL, key: SB_KEY };
  const [conn, setConn] = useState({ state: "idle", msg: "" });
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteSym, setPasteSym] = useState("CRDB");
  const [pasteText, setPasteText] = useState("");

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
    if (source !== "live" || !SB_URL || !SB_KEY) return;
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
  }, [source]);

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

  const simA = useMemo(
    () => (barsA.length ? simulate(barsA, cfg(legA, periodsA, bOn ? legB : null, periodsB)) : null),
    [barsA, legA, legB, bOn, periodsA, periodsB, matchCapital, whole, reinvest, feePct]
  );
  const simB = useMemo(
    () => (bOn && barsB.length ? simulate(barsB, cfg(legB, periodsB, legA, periodsA)) : null),
    [barsB, legA, legB, bOn, periodsA, periodsB, matchCapital, whole, reinvest, feePct]
  );

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

  /* ---- chart data ---- */
  const chartData = useMemo(() => {
    if (!simA) return [];
    const out = [];
    for (let i = 0; i <= t && i < simA.path.length; i++) {
      const a = simA.path[i];
      const b = simB?.path[i];
      const row = { date: a.date };
      if (chartMode === "value") {
        row.aVal = a.value; row.aInv = a.invested;
        if (b) { row.bVal = b.value; row.bInv = b.invested; }
      } else if (chartMode === "roi") {
        row.aVal = a.invested > 0 ? ((a.value - a.invested) / a.invested) * 100 : 0;
        if (b) row.bVal = b.invested > 0 ? ((b.value - b.invested) / b.invested) * 100 : 0;
      } else {
        row.aVal = a.price;
        if (b) row.bVal = b.price;
      }
      out.push(row);
    }
    return out;
  }, [simA, simB, t, chartMode]);

  /* ---- travelling logo markers ---- */
  const lastIdx = chartData.length - 1;
  const leadA = useMemo(
    () => makeLeadMarker(legA.symbol, A_COLOR, lastIdx),
    [legA.symbol, lastIdx]
  );
  const leadB = useMemo(
    () => makeLeadMarker(legB.symbol, B_COLOR, lastIdx),
    [legB.symbol, lastIdx]
  );

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
    if (source !== "live") return;
    loadSymbols(bOn ? [legA.symbol, legB.symbol] : [legA.symbol]);
  }, [source, legA.symbol, legB.symbol, bOn, loadSymbols]);

  const ingestPaste = () => {
    try {
      const bars = normalizeSeries(JSON.parse(pasteText));
      if (!bars.length) throw new Error("No usable rows — check the field names.");
      setLiveData((d) => ({ ...d, [pasteSym]: bars }));
      setConn({ state: "ok", msg: `${bars.length} bars loaded for ${pasteSym}` });
      setPasteText(""); setPasteOpen(false);
    } catch (e) {
      setConn({ state: "err", msg: e.message });
    }
  };

  /* ---- derived headline ---- */
  const leader = mA && mB ? (mA.value >= mB.value ? "A" : "B") : null;
  const gap = mA && mB ? Math.abs(mA.value - mB.value) : 0;
  const total = mA && mB ? mA.value + mB.value : 0;
  const shareA = total > 0 ? (mA.value / total) * 100 : 50;

  const labelFor = (leg, m) =>
    `${leg.symbol} · ${leg.strategy === "lump" ? "one-time" : `${leg.freq} top-up`}`;

  const noData = n === 0;

  return (
    <div className="w-full min-h-screen bg-white text-neutral-950 antialiased">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&display=swap');
        * { font-family: 'Sora', ui-sans-serif, system-ui, sans-serif; }
        .tabular-nums { font-variant-numeric: tabular-nums; }
        .dots { background-image: radial-gradient(circle, rgba(0,0,0,.045) 1px, transparent 1px); background-size: 20px 20px; }
        input[type=range]{ -webkit-appearance:none; appearance:none; background:transparent; }
        input[type=range]::-webkit-slider-runnable-track{ height:4px; background:#e5e7eb; border-radius:99px; }
        input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; width:16px; height:16px; margin-top:-6px; border-radius:50%; background:#0a0a0a; border:3px solid #fff; box-shadow:0 1px 4px rgba(0,0,0,.3); cursor:pointer; }
        input[type=range]::-moz-range-track{ height:4px; background:#e5e7eb; border-radius:99px; }
        input[type=range]::-moz-range-thumb{ width:16px; height:16px; border-radius:50%; background:#0a0a0a; border:3px solid #fff; cursor:pointer; }
        @media (prefers-reduced-motion: reduce){ *{ transition:none !important; animation:none !important; } }
      `}</style>

      {/* ---------- header ---------- */}
      <header className="border-b border-gray-200 px-5 py-3 flex items-center justify-between flex-wrap gap-3 sticky top-0 bg-white/95 backdrop-blur z-20">
        <Logo />
        <div className="flex items-center gap-2">
          <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
            <button
              onClick={() => setSource("demo")}
              className={`flex items-center gap-1.5 text-[11px] font-bold py-1.5 px-3 rounded-md ${
                source === "demo" ? "bg-neutral-950 text-white" : "text-gray-500"
              }`}
            >
              <FlaskConical className="w-3 h-3" /> Sample data
            </button>
            <button
              onClick={() => setSource("live")}
              className={`flex items-center gap-1.5 text-[11px] font-bold py-1.5 px-3 rounded-md ${
                source === "live" ? "bg-green-500 text-white" : "text-gray-500"
              }`}
            >
              <Plug className="w-3 h-3" /> Sokoview API
            </button>
          </div>
        </div>
      </header>

      {/* ---------- live panel ---------- */}
      {source === "live" && (
        <div className="border-b border-gray-200 bg-gray-50 px-5 py-4">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-end justify-between gap-3 flex-wrap">
              <div>
                <Eyebrow>Data source</Eyebrow>
                <div className="text-[12px] font-bold text-neutral-900">
                  Sokoview price history · split &amp; bonus adjusted
                </div>
                <div className="text-[10.5px] text-gray-500 mt-0.5">
                  {universe.length
                    ? `${universe.length} instruments · ${universe[0]?.first ?? ""} to ${universe[0]?.last ?? ""}`
                    : "Loading universe…"}
                </div>
              </div>
              <div className="flex items-end gap-2">
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
                <button
                  onClick={() => setPasteOpen((v) => !v)}
                  className="border border-gray-300 bg-white text-[11px] font-bold px-3 py-2.5 rounded-lg hover:border-neutral-900"
                >
                  Paste JSON
                </button>
              </div>
            </div>

            {conn.state === "loading" && (
              <div className="mt-2.5 flex items-center gap-1.5 text-[11px] font-bold text-gray-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading price history…
              </div>
            )}
            {conn.state === "ok" && (
              <div className="mt-2.5 flex items-center gap-1.5 text-[11px] font-bold text-green-700">
                <Check className="w-3.5 h-3.5" /> {conn.msg}
              </div>
            )}
            {conn.state === "err" && (
              <div className="mt-2.5 flex items-start gap-1.5 text-[11px] font-semibold text-red-600">
                <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
                <span>
                  {conn.msg}
                  <span className="block text-gray-500 font-normal mt-0.5">
                    Check VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, then redeploy.
                  </span>
                </span>
              </div>
            )}

            {pasteOpen && (
              <div className="mt-3 border-t border-gray-200 pt-3">
                <div className="flex gap-2 mb-2">
                  <input
                    value={pasteSym}
                    onChange={(e) => setPasteSym(e.target.value.toUpperCase())}
                    className="w-28 bg-white border border-gray-300 rounded-lg px-3 py-2 text-[12px] font-bold outline-none"
                    placeholder="SYMBOL"
                  />
                  <button
                    onClick={ingestPaste}
                    className="bg-green-500 text-white text-[11px] font-bold px-4 py-2 rounded-lg hover:bg-green-600"
                  >
                    Load into replay
                  </button>
                </div>
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  rows={4}
                  placeholder='Paste the raw response, e.g. {"data":[{"date":"2024-01-02","close":540}, …]}'
                  className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-[11px] font-mono outline-none focus:border-green-500"
                />
              </div>
            )}
          </div>
        </div>
      )}

      <main className="max-w-6xl mx-auto px-5 py-6">
        {/* ---------- hero: the race ---------- */}
        <section className="dots border border-gray-200 rounded-2xl p-5 mb-5 relative overflow-hidden">
          <div
            className="absolute -top-16 -right-16 w-80 h-80 rounded-full pointer-events-none"
            style={{ background: "radial-gradient(circle, rgba(34,197,94,.14) 0%, transparent 68%)" }}
          />
          <div className="relative">
            {noData ? (
              <div className="py-10 text-center">
                <div className="text-[15px] font-extrabold mb-1">No price history loaded</div>
                <div className="text-[12px] text-gray-500">
                  Load a symbol from the Sokoview API, or switch to sample data to explore the tool.
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
                  <div>
                    <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-green-600 mb-1.5">
                      Replaying from {prettyDate(barsA[0].date)}
                    </div>
                    <div className="text-[34px] sm:text-[42px] font-extrabold leading-[0.95] tracking-[-0.03em] tabular-nums">
                      {prettyDate(barsA[t]?.date ?? barsA[0].date)}
                    </div>
                    <div className="text-[11px] text-gray-500 font-semibold mt-1 tabular-nums">
                      {legA.symbol} at {tzs(mA?.price)}
                      {mB && legB.symbol !== legA.symbol && (
                        <> · {legB.symbol} at {tzs(mB.price)}</>
                      )}
                    </div>
                  </div>

                  {mA && mB && (
                    <div className="text-right">
                      <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-gray-400 mb-1">
                        Ahead by
                      </div>
                      <div
                        className="text-[26px] sm:text-[32px] font-extrabold leading-none tabular-nums tracking-tight"
                        style={{ color: leader === "A" ? A_COLOR : B_COLOR }}
                      >
                        {compact(gap)}
                      </div>
                      <div className="text-[11px] font-bold text-gray-500 mt-1">
                        {leader === "A" ? labelFor(legA) : labelFor(legB)}
                      </div>
                    </div>
                  )}
                </div>

                {/* the race bar — signature element */}
                {mA && mB && (
                  <div className="mb-5">
                    <div className="flex h-9 rounded-lg overflow-hidden border border-gray-200">
                      <div
                        className="flex items-center px-3 transition-all duration-100"
                        style={{ width: `${Math.max(shareA, 8)}%`, background: A_COLOR }}
                      >
                        <span className="text-[11px] font-extrabold text-white tabular-nums whitespace-nowrap">
                          {compact(mA.value)}
                        </span>
                      </div>
                      <div
                        className="flex items-center justify-end px-3 flex-1 transition-all duration-100"
                        style={{ background: B_COLOR }}
                      >
                        <span className="text-[11px] font-extrabold text-white tabular-nums whitespace-nowrap">
                          {compact(mB.value)}
                        </span>
                      </div>
                    </div>
                    <div className="flex justify-between mt-1.5 text-[10.5px] font-bold">
                      <span className="text-green-600 flex items-center gap-1.5">
                        <StockMark symbol={legA.symbol} size={16} /> {labelFor(legA)}
                      </span>
                      <span className="text-neutral-900 flex items-center gap-1.5">
                        {labelFor(legB)} <StockMark symbol={legB.symbol} size={16} />
                      </span>
                    </div>
                  </div>
                )}

                {/* transport */}
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={() => (playing ? setPlaying(false) : play())}
                    className="w-11 h-11 rounded-full bg-neutral-950 text-white flex items-center justify-center hover:bg-neutral-800 flex-shrink-0"
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
                    className="w-9 h-9 rounded-full border border-gray-300 flex items-center justify-center hover:border-neutral-900 flex-shrink-0"
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

                  <div className="flex gap-1 p-1 bg-gray-100 rounded-lg flex-shrink-0">
                    {[0.5, 1, 2, 4].map((s) => (
                      <button
                        key={s}
                        onClick={() => setSpeed(s)}
                        className={`text-[10.5px] font-bold py-1 px-2 rounded ${
                          speed === s ? "bg-white shadow-sm text-neutral-950" : "text-gray-500"
                        }`}
                      >
                        {s}×
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </section>

        {!noData && (
          <div className="grid lg:grid-cols-[300px_1fr] gap-5">
            {/* ---------- left rail ---------- */}
            <aside className="space-y-4">
              <div>
                <Eyebrow>Start from</Eyebrow>
                <div className="flex flex-wrap gap-1.5">
                  {[2016, 2018, 2020, 2022, 2024].map((y) => (
                    <button
                      key={y}
                      onClick={() => setStartYear(y)}
                      className={`text-[11px] font-bold px-2.5 py-1.5 rounded-lg border ${
                        startYear === y
                          ? "bg-neutral-950 text-white border-neutral-950"
                          : "border-gray-300 text-gray-500 hover:border-neutral-900"
                      }`}
                    >
                      {y}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Eyebrow>Quick comparisons</Eyebrow>
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    { k: "lumpVsDca", l: "One-time vs recurring" },
                    { k: "stockVsStockLump", l: "Stock vs stock, one-time" },
                    { k: "stockVsStockDca", l: "Stock vs stock, recurring" },
                    { k: "single", l: "Single stock only" },
                  ].map((p) => (
                    <button
                      key={p.k}
                      onClick={() => applyPreset(p.k)}
                      className="text-[10.5px] font-bold text-left px-2.5 py-2 rounded-lg border border-gray-300 hover:border-green-500 hover:bg-green-500/5 leading-tight"
                    >
                      {p.l}
                    </button>
                  ))}
                </div>
              </div>

              <LegPanel
                leg={legA}
                set={(p) => setLegA((s) => ({ ...s, ...p }))}
                color={A_COLOR}
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
                set={(p) => setLegB((s) => ({ ...s, ...p }))}
                color={B_COLOR}
                title="Plan B"
                enabled={bOn}
                onToggle={() => setBOn((v) => !v)}
                canDisable
                symbols={symbols}
                lockLump={bOn && matchCapital && legB.strategy === "lump" && legA.strategy === "dca"}
                lockedValue={legA.perPeriod * periodsA}
                liq={liqOf[legB.symbol]}
              />

              <div className="rounded-xl border border-gray-300 p-3.5 space-y-3">
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

            {/* ---------- right: chart + results ---------- */}
            <section className="space-y-4">
              <div className="border border-gray-200 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <Seg
                    value={chartMode}
                    onChange={setChartMode}
                    options={[
                      { v: "value", l: "Portfolio value" },
                      { v: "roi", l: "Return %" },
                      { v: "price", l: "Share price" },
                    ]}
                  />
                  <div className="flex items-center gap-3 text-[10px] font-bold">
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-[2px]" style={{ background: A_COLOR }} /> Plan A
                    </span>
                    {bOn && (
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-[2px]" style={{ background: B_COLOR }} /> Plan B
                      </span>
                    )}
                    {chartMode === "value" && (
                      <span className="flex items-center gap-1.5 text-gray-400">
                        <span className="w-3 border-t-2 border-dashed border-gray-400" /> Money in
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ width: "100%", height: 300 }}>
                  <ResponsiveContainer>
                    <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                      <CartesianGrid stroke="#f3f4f6" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: "#9ca3af", fontWeight: 600 }}
                        tickFormatter={(d) => d.slice(0, 7)}
                        minTickGap={50}
                        axisLine={{ stroke: "#e5e7eb" }}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: "#9ca3af", fontWeight: 600 }}
                        tickFormatter={(v) => (chartMode === "roi" ? v.toFixed(0) + "%" : compact(v))}
                        axisLine={false}
                        tickLine={false}
                        width={52}
                      />
                      <Tooltip
                        contentStyle={{
                          borderRadius: 12, border: "1px solid #e5e7eb",
                          fontSize: 11, fontWeight: 700, boxShadow: "0 4px 16px rgba(0,0,0,.08)",
                        }}
                        labelFormatter={prettyDate}
                        formatter={(v, name) => [
                          chartMode === "roi" ? v.toFixed(1) + "%" : tzs(v),
                          { aVal: "Plan A", bVal: "Plan B", aInv: "A money in", bInv: "B money in" }[name] ?? name,
                        ]}
                      />
                      {chartMode === "roi" && <ReferenceLine y={0} stroke="#d1d5db" />}
                      {chartMode === "value" && (
                        <Line type="stepAfter" dataKey="aInv" stroke="#86efac" strokeWidth={1.5}
                              strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                      )}
                      {chartMode === "value" && bOn && (
                        <Line type="stepAfter" dataKey="bInv" stroke="#9ca3af" strokeWidth={1.5}
                              strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                      )}
                      <Line type="monotone" dataKey="aVal" stroke={A_COLOR} strokeWidth={2.4}
                            dot={leadA} activeDot={false} isAnimationActive={false} />
                      {bOn && (
                        <Line type="monotone" dataKey="bVal" stroke={B_COLOR} strokeWidth={2.4}
                              dot={leadB} activeDot={false} isAnimationActive={false} />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* result cards */}
              <div className={`grid gap-4 ${bOn ? "md:grid-cols-2" : ""}`}>
                {[
                  { m: mA, leg: legA, color: A_COLOR, title: "Plan A", show: true },
                  { m: mB, leg: legB, color: B_COLOR, title: "Plan B", show: bOn },
                ]
                  .filter((x) => x.show && x.m)
                  .map(({ m, leg, color, title }) => (
                    <div key={title} className="border border-gray-200 rounded-2xl overflow-hidden">
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
                          <div className="mt-3 pt-3 border-t border-gray-100 text-[10.5px] text-gray-400 font-semibold tabular-nums">
                            {tzs(m.cash)} still uninvested
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
              </div>

              {/* method note */}
              <div className="flex gap-2.5 text-[11px] text-gray-500 leading-relaxed border border-gray-200 rounded-xl p-3.5">
                <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-gray-400" />
                <p>
                  Comparing a one-time investment against a recurring one on total return alone is
                  misleading — the recurring plan has less money in the market for less time.
                  The <strong className="text-neutral-900">annualised money-weighted return</strong> above
                  accounts for when each contribution actually landed, so it's the fairer number
                  to judge them by. Past results don't predict future ones.
                </p>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
