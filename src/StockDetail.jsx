import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine,
} from "recharts";
import {
  RefreshCw, Loader2, AlertTriangle, Settings, Info, ChevronDown,
} from "lucide-react";
import { logoUrl, monogramColor, monogramText } from "./logos.js";

/* ============================================================================
   Supabase
   ==========================================================================*/

const ENV_URL = import.meta.env.VITE_SUPABASE_URL || "";
const ENV_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";

async function sb(path, cfg, range) {
  const headers = {
    apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Accept: "application/json",
  };
  if (range) { headers.Range = range; headers["Range-Unit"] = "items"; }
  const res = await fetch(`${cfg.url.replace(/\/$/, "")}/rest/v1/${path}`, { headers });
  if (!res.ok) {
    let m = `${res.status} ${res.statusText}`;
    try { const b = await res.json(); if (b?.message) m += ` — ${b.message}`; } catch {}
    throw new Error(m);
  }
  return res.json();
}

/** PostgREST caps at 1000 rows, so page through. */
async function sbAll(path, cfg) {
  const PAGE = 1000, out = [];
  for (let off = 0; off < 40000; off += PAGE) {
    const page = await sb(path, cfg, `${off}-${off + PAGE - 1}`);
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/* ============================================================================
   Helpers
   ==========================================================================*/

const nf = new Intl.NumberFormat("en-US");
const tzs = (n) => (n == null || !isFinite(n) ? "—" : nf.format(Math.round(n)));
const compact = (n) => {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(Math.round(n));
};
const pct = (n, d = 1) =>
  n == null || !isFinite(n) ? "—" : (n >= 0 ? "+" : "") + Number(n).toFixed(d) + "%";
const prettyDate = (d) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB",
      { day: "numeric", month: "short", year: "numeric" }) : "—";
const shortDate = (d) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB",
      { day: "numeric", month: "short" }) : "—";

const SOURCE_META = {
  dse_report:      { label: "Exchange",    color: "#22c55e", rank: 1 },
  african_markets: { label: "Vendor",      color: "#60a5fa", rank: 2 },
  sokoview_quote:  { label: "Own capture", color: "#d4d4d8", rank: 3 },
};
const srcColor = (s) => SOURCE_META[s]?.color ?? "#e5e7eb";
const srcRank = (s) => SOURCE_META[s]?.rank ?? 9;

const RANGES = [
  { k: "1y", l: "1Y", years: 1 },
  { k: "3y", l: "3Y", years: 3 },
  { k: "5y", l: "5Y", years: 5 },
  { k: "10y", l: "10Y", years: 10 },
  { k: "max", l: "Max", years: null },
];

/* ============================================================================
   UI atoms
   ==========================================================================*/


/** Shared company mark. Falls back to a monogram when there is no logo file. */
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
    <img src={url} alt={symbol} onError={() => setFailed(true)} loading="lazy"
      className="rounded-full object-contain bg-white flex-shrink-0"
      style={{ ...px, boxShadow: ring ? "0 0 0 2px #fff, 0 1px 4px rgba(0,0,0,.2)" : undefined }} />
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <div className="w-7 h-7 bg-neutral-950 rounded-md flex items-end gap-[2.5px] px-1.5 pb-[5px] pt-1">
        <div className="w-[3.5px] h-[5px] rounded-sm bg-green-500" />
        <div className="w-[3.5px] h-[8px] rounded-sm bg-green-500" />
        <div className="w-[3.5px] h-[11px] rounded-sm bg-green-500" />
      </div>
      <span className="text-[15px] font-extrabold tracking-tight text-neutral-950">sokoview</span>
      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-green-600 bg-green-500/10 border border-green-500/25 px-2 py-[3px] rounded-full">
        stock
      </span>
    </div>
  );
}

function Stat({ label, value, sub, tone = "default" }) {
  const c = { default: "text-neutral-950", warn: "text-amber-600",
              good: "text-green-600", bad: "text-red-600" }[tone];
  return (
    <div className="bg-gray-50 rounded-xl px-3.5 py-3">
      <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-gray-400 mb-1">
        {label}
      </div>
      <div className={`text-[19px] font-extrabold leading-none tabular-nums ${c}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 mt-1 leading-snug">{sub}</div>}
    </div>
  );
}

function Panel({ title, hint, right, children }) {
  return (
    <section className="border border-gray-200 rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[12.5px] font-extrabold text-neutral-950">{title}</h2>
          {hint && <p className="text-[10.5px] text-gray-500 mt-0.5 leading-snug">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/* ---- provenance strip: one cell per trading day, coloured by source ------ */
function ProvenanceStrip({ days }) {
  if (!days.length) return null;
  // Collapse into runs so a decade renders as a handful of rects.
  const runs = [];
  days.forEach((d, i) => {
    const last = runs[runs.length - 1];
    if (last && last.source === d.source) last.n += 1;
    else runs.push({ source: d.source, n: 1, from: d.date, i });
  });
  const total = days.length;
  return (
    <div className="px-4 py-3">
      <div className="flex h-4 rounded-md overflow-hidden gap-[1px]">
        {runs.map((r, i) => (
          <div
            key={i}
            title={`${SOURCE_META[r.source]?.label ?? r.source} · ${r.n} day${r.n > 1 ? "s" : ""} from ${prettyDate(r.from)}`}
            style={{ width: `${(100 * r.n) / total}%`, background: srcColor(r.source) }}
          />
        ))}
      </div>
      <div className="flex gap-3.5 flex-wrap mt-2.5 text-[10px] text-gray-500 font-semibold">
        {Object.entries(SOURCE_META).map(([k, m]) => {
          const n = days.filter((d) => d.source === k).length;
          if (!n) return null;
          return (
            <span key={k} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: m.color }} />
              {m.label} · {nf.format(n)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ---- dry spell strip: when it didn't trade, not how often ---------------- */
function DrySpellStrip({ days }) {
  const spells = useMemo(() => {
    const out = [];
    let run = null;
    days.forEach((d, i) => {
      const untraded = d.volume != null && Number(d.volume) === 0;
      if (untraded) {
        if (run) run.n += 1;
        else run = { start: i, n: 1, from: d.date };
      } else if (run) { out.push(run); run = null; }
    });
    if (run) out.push(run);
    return out;
  }, [days]);

  const withVol = days.filter((d) => d.volume != null).length;
  if (!withVol) {
    return (
      <div className="px-4 py-6 text-center">
        <div className="text-[11.5px] font-bold text-gray-500">No volume in this range</div>
        <div className="text-[10.5px] text-gray-400 mt-1">
          Volume comes from the vendor feed and the exchange reports.
        </div>
      </div>
    );
  }
  const longest = spells.reduce((m, s) => Math.max(m, s.n), 0);
  const total = days.length;

  return (
    <div className="px-4 py-3">
      <div className="relative h-8">
        <div className="absolute left-0 right-0 top-1/2 h-[1px] bg-gray-200" />
        {spells.map((s, i) => {
          const intensity = s.n >= 20 ? "#d85a30" : s.n >= 5 ? "#f0997b" : "#f5c4b3";
          return (
            <div
              key={i}
              title={`${s.n} day${s.n > 1 ? "s" : ""} without a trade from ${prettyDate(s.from)}`}
              className="absolute top-1.5 rounded-sm"
              style={{
                left: `${(100 * s.start) / total}%`,
                width: `${Math.max((100 * s.n) / total, 0.35)}%`,
                height: 20, background: intensity,
              }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-gray-500 font-semibold mt-1.5">
        <span>{spells.length} dry spell{spells.length === 1 ? "" : "s"}</span>
        <span>longest {longest} day{longest === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}

/* ============================================================================
   App
   ==========================================================================*/

export default function StockDetail() {
  const [cfg, setCfg] = useState({ url: ENV_URL, key: ENV_KEY });
  const [draft, setDraft] = useState({ url: ENV_URL, key: ENV_KEY });
  const [showCfg, setShowCfg] = useState(!ENV_URL || !ENV_KEY);

  const [universe, setUniverse] = useState([]);
  const [symbol, setSymbol] = useState("CRDB");
  const [rows, setRows] = useState([]);
  const [actions, setActions] = useState([]);
  const [range, setRange] = useState("10y");
  const [priceMode, setPriceMode] = useState("adj");
  const [state, setState] = useState({ loading: false, error: "" });

  /* ---- universe ---- */
  useEffect(() => {
    if (!cfg.url || !cfg.key) return;
    (async () => {
      try {
        const u = await sb(
          "liquidity_profile?select=symbol,pct_days_traded,days,longest_dry_spell&order=pct_days_traded.desc",
          cfg);
        setUniverse(u);
        if (u.length && !u.some((x) => x.symbol === symbol)) setSymbol(u[0].symbol);
      } catch (e) { setState((s) => ({ ...s, error: e.message })); }
    })();
  }, [cfg]);

  /* ---- rows for the selected symbol ---- */
  const load = useCallback(async () => {
    if (!cfg.url || !cfg.key || !symbol) return;
    setState({ loading: true, error: "" });
    try {
      const [r, a] = await Promise.all([
        sbAll(`price_raw?select=trade_date,source,close,low,high,volume,traded` +
              `&symbol=eq.${encodeURIComponent(symbol)}&order=trade_date.asc`, cfg),
        sb(`corporate_action?select=*&symbol=eq.${encodeURIComponent(symbol)}&order=ex_date.asc`, cfg),
      ]);
      setRows(r); setActions(a);
      setState({ loading: false, error: "" });
    } catch (e) { setState({ loading: false, error: e.message }); }
  }, [cfg, symbol]);

  useEffect(() => { load(); }, [load]);

  /* ---- merge to one row per day, then window ---- */
  const model = useMemo(() => {
    if (!rows.length) return null;

    const byDate = {};
    rows.forEach((r) => { (byDate[r.trade_date] ??= []).push(r); });

    let days = Object.keys(byDate).sort().map((date) => {
      const rs = byDate[date];
      const wc = rs.filter((r) => r.close != null).sort((a, b) => srcRank(a.source) - srcRank(b.source));
      const wv = rs.filter((r) => r.volume != null).sort((a, b) => srcRank(a.source) - srcRank(b.source));
      const base = wc[0] ?? rs[0];
      return {
        date,
        close: base.close == null ? null : Number(base.close),
        source: wc[0]?.source ?? rs[0].source,
        volume: wv[0] ? Number(wv[0].volume) : null,
        volumeSource: wv[0]?.source ?? null,
        sources: rs,
      };
    }).filter((d) => d.close != null);

    // window
    if (range !== "max") {
      const yrs = RANGES.find((r) => r.k === range)?.years;
      if (yrs) {
        const last = days[days.length - 1].date;
        const cut = new Date(Date.parse(last + "T00:00:00") - yrs * 365.25 * 864e5)
          .toISOString().slice(0, 10);
        days = days.filter((d) => d.date >= cut);
      }
    }

    // split/bonus adjustment: divide by the cumulative ratio of actions AFTER the day
    const ratios = actions.filter((a) => ["split", "bonus"].includes(a.kind));
    const adjust = (date, close) => {
      let f = 1;
      ratios.forEach((a) => {
        if (a.ex_date > date) f *= a.kind === "split" ? Number(a.value) : 1 + Number(a.value);
      });
      return f === 1 ? close : Math.round((close / f) * 100) / 100;
    };
    days = days.map((d) => ({ ...d, closeAdj: adjust(d.date, d.close) }));

    // reconciliation within the window
    const recon = [];
    days.forEach((d) => {
      const priced = d.sources.filter((r) => r.close != null);
      if (priced.length > 1) {
        const vals = priced.map((r) => ({ source: r.source, close: Number(r.close) }));
        const spread = Math.max(...vals.map((v) => v.close)) - Math.min(...vals.map((v) => v.close));
        if (spread > 0.005) recon.push({ date: d.date, vals, spread, kind: "close" });
      }
      const rep = d.sources.find((r) => r.source === "dse_report" && r.low != null && r.volume > 0);
      if (rep) {
        d.sources.filter((r) => r.source !== "dse_report" && r.close != null).forEach((o) => {
          const c = Number(o.close);
          if (c < Number(rep.low) || c > Number(rep.high)) {
            recon.push({
              date: d.date, kind: "range", spread: Math.min(Math.abs(c - rep.low), Math.abs(c - rep.high)),
              vals: [{ source: "dse_report", close: `${tzs(rep.low)}–${tzs(rep.high)}` },
                     { source: o.source, close: tzs(c) }],
            });
          }
        });
      }
    });
    recon.sort((a, b) => (a.date < b.date ? 1 : -1));

    const withVol = days.filter((d) => d.volume != null);
    const traded = withVol.filter((d) => d.volume > 0);
    const exchangeDays = days.filter((d) =>
      d.sources.some((r) => r.source === "dse_report")).length;

    let longest = 0, run = 0;
    withVol.forEach((d) => { run = d.volume > 0 ? 0 : run + 1; longest = Math.max(longest, run); });

    const first = days[0], last = days[days.length - 1];
    const ret = first && last && first.closeAdj
      ? (100 * (last.closeAdj - first.closeAdj)) / first.closeAdj : null;

    return {
      days, recon, exchangeDays, longest,
      pctTraded: withVol.length ? (100 * traded.length) / withVol.length : null,
      totalVolume: withVol.reduce((t, d) => t + d.volume, 0),
      first, last, ret,
      actionsInRange: actions.filter((a) =>
        days.length && a.ex_date >= days[0].date && a.ex_date <= last.date),
    };
  }, [rows, actions, range]);

  const chartData = useMemo(() => {
    if (!model) return [];
    const d = model.days;
    // thin for readability without losing shape
    const stride = Math.max(1, Math.floor(d.length / 600));
    return d.filter((_, i) => i % stride === 0 || i === d.length - 1)
      .map((x) => ({ date: x.date, v: priceMode === "adj" ? x.closeAdj : x.close }));
  }, [model, priceMode]);

  /* ---- config gate ---- */
  if (showCfg || !cfg.url || !cfg.key) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="mb-6"><Logo /></div>
          <div className="border border-gray-200 rounded-2xl p-5">
            <h1 className="text-[16px] font-extrabold mb-1">Connect to Supabase</h1>
            <p className="text-[11.5px] text-gray-500 mb-4 leading-relaxed">
              Use the publishable key. It is read-only under your row-level security policies.
            </p>
            <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              placeholder="https://xxxx.supabase.co"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-[12px] font-semibold outline-none focus:border-green-500 mb-3" />
            <input value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })}
              placeholder="sb_publishable_…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-[12px] font-semibold outline-none focus:border-green-500 mb-4" />
            <button onClick={() => { setCfg(draft); setShowCfg(false); }}
              disabled={!draft.url || !draft.key}
              className="w-full bg-neutral-950 text-white text-[12px] font-bold py-2.5 rounded-lg hover:bg-neutral-800 disabled:opacity-30">
              Connect
            </button>
          </div>
        </div>
      </div>
    );
  }

  const liq = universe.find((u) => u.symbol === symbol);

  return (
    <div className="min-h-screen bg-white text-neutral-950 antialiased">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&display=swap');
        * { font-family: 'Sora', ui-sans-serif, system-ui, sans-serif; }
        .tabular-nums { font-variant-numeric: tabular-nums; }
        @media (prefers-reduced-motion: reduce){ *{ transition:none !important; } }
      `}</style>

      <header className="border-b border-gray-200 px-5 py-3 flex items-center justify-between gap-3 sticky top-0 bg-white/95 backdrop-blur z-20">
        <Logo />
        <div className="flex items-center gap-2">
          <button onClick={load}
            className="flex items-center gap-1.5 border border-gray-300 text-[11px] font-bold px-3 py-2 rounded-lg hover:border-neutral-900">
            {state.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
          <button onClick={() => { setDraft(cfg); setShowCfg(true); }}
            className="border border-gray-300 p-2 rounded-lg hover:border-neutral-900" aria-label="Settings">
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-5 py-6 space-y-4">
        {state.error && (
          <div className="border border-red-300 bg-red-50 rounded-xl p-4 flex gap-2.5">
            <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="text-[11.5px] text-red-700">{state.error}</div>
          </div>
        )}

        {/* ---------- selector + range ---------- */}
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div className="flex items-end gap-3">
            <StockMark symbol={symbol} size={40} />
            <div className="relative">
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)}
                className="appearance-none bg-white border border-gray-300 rounded-lg pl-3 pr-9 py-2.5 text-[14px] font-extrabold outline-none">
                {universe.map((u) => (
                  <option key={u.symbol} value={u.symbol}>
                    {u.symbol} · {Number(u.pct_days_traded).toFixed(0)}% traded
                  </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 text-gray-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
            {model?.last && (
              <div className="pb-1">
                <span className="text-[20px] font-extrabold tabular-nums">{tzs(model.last.close)}</span>
                <span className="text-[11px] text-gray-500 ml-2">
                  {prettyDate(model.last.date)}
                </span>
              </div>
            )}
          </div>
          <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
            {RANGES.map((r) => (
              <button key={r.k} onClick={() => setRange(r.k)}
                className={`text-[11px] font-bold py-1.5 px-2.5 rounded-md ${
                  range === r.k ? "bg-white shadow-sm text-neutral-950" : "text-gray-500"}`}>
                {r.l}
              </button>
            ))}
          </div>
        </div>

        {model && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Stat label="Return in range" value={pct(model.ret)}
                tone={model.ret >= 0 ? "good" : "bad"}
                sub={`${prettyDate(model.first.date)} → ${prettyDate(model.last.date)}`} />
              <Stat label="Days traded"
                value={model.pctTraded == null ? "—" : `${model.pctTraded.toFixed(0)}%`}
                tone={model.pctTraded >= 55 ? "good" : model.pctTraded >= 25 ? "warn" : "bad"}
                sub={`${nf.format(model.days.length)} trading days in range`} />
              <Stat label="Longest gap" value={`${model.longest}d`}
                tone={model.longest > 60 ? "bad" : model.longest > 21 ? "warn" : "default"}
                sub="consecutive days without a trade" />
              <Stat label="Exchange-backed" value={model.exchangeDays}
                sub="days with a DSE market report" />
            </div>

            <Panel
              title="Price"
              hint={model.actionsInRange.length
                ? `${model.actionsInRange.length} corporate action${model.actionsInRange.length > 1 ? "s" : ""} in range — toggle to see the unadjusted series`
                : "No corporate actions recorded in this range"}
              right={
                <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
                  {[{ v: "adj", l: "Adjusted" }, { v: "raw", l: "Raw" }].map((o) => (
                    <button key={o.v} onClick={() => setPriceMode(o.v)}
                      className={`text-[10.5px] font-bold py-1 px-2.5 rounded ${
                        priceMode === o.v ? "bg-white shadow-sm" : "text-gray-500"}`}>
                      {o.l}
                    </button>
                  ))}
                </div>
              }
            >
              <div className="p-4" style={{ height: 260 }}>
                <ResponsiveContainer>
                  <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                    <CartesianGrid stroke="#f3f4f6" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={(d) => d.slice(0, 7)} minTickGap={60}
                      tick={{ fontSize: 10, fill: "#9ca3af", fontWeight: 600 }}
                      axisLine={{ stroke: "#e5e7eb" }} tickLine={false} />
                    <YAxis tickFormatter={compact} width={52}
                      tick={{ fontSize: 10, fill: "#9ca3af", fontWeight: 600 }}
                      axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{ borderRadius: 12, border: "1px solid #e5e7eb",
                                      fontSize: 11, fontWeight: 700 }}
                      labelFormatter={prettyDate}
                      formatter={(v) => [tzs(v), priceMode === "adj" ? "Adjusted" : "Raw"]} />
                    {model.actionsInRange.map((a) => (
                      <ReferenceLine key={a.ex_date + a.kind} x={a.ex_date}
                        stroke="#ba7517" strokeDasharray="3 3"
                        label={{ value: a.kind, position: "top", fontSize: 9, fill: "#854f0b" }} />
                    ))}
                    <Line type="monotone" dataKey="v" stroke="#22c55e" strokeWidth={2}
                      dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Panel>

            <Panel title="Where each day came from"
              hint="One block per run of trading days. Exchange days are the authoritative ones.">
              <ProvenanceStrip days={model.days} />
            </Panel>

            <Panel title="When it didn't trade"
              hint="Gaps, not averages — this is what an exit actually faces.">
              <DrySpellStrip days={model.days} />
            </Panel>

            <Panel title="Sources disagreed"
              hint="A close outside the exchange's range for that day is a mis-dated row or an unrecorded action.">
              {model.recon.length === 0 ? (
                <div className="px-4 py-6 text-center text-[11.5px] font-bold text-green-600">
                  All overlapping days agree
                </div>
              ) : (
                <div className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
                  {model.recon.slice(0, 40).map((r, i) => (
                    <div key={i} className="px-4 py-2.5 flex items-center gap-3 flex-wrap text-[11.5px]">
                      <span className="text-gray-500 w-20 tabular-nums">{shortDate(r.date)}</span>
                      {r.vals.map((v) => (
                        <span key={v.source} className="tabular-nums">
                          <span className="text-gray-400">{SOURCE_META[v.source]?.label ?? v.source}</span>{" "}
                          <strong>{typeof v.close === "number" ? tzs(v.close) : v.close}</strong>
                        </span>
                      ))}
                      <span className={`ml-auto text-[10px] font-bold uppercase tracking-wide ${
                        r.kind === "range" ? "text-amber-600" : "text-gray-400"}`}>
                        {r.kind === "range" ? "out of range" : "close differs"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <div className="flex gap-2.5 text-[10.5px] text-gray-500 leading-relaxed border border-gray-200 rounded-xl p-3.5">
              <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-gray-400" />
              <p>
                Each day takes its close from the best available source and its volume from the
                best source that reports it, so a DSE report can supply volume for a day whose
                close comes from elsewhere. Adjusted prices are computed from the recorded
                corporate actions — an unrecorded split will show as a cliff on both series.
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
