import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";
import {
  RefreshCw, AlertTriangle, Check, Database, Loader2, Settings,
  TrendingUp, TrendingDown, Minus, Activity, Calendar, Info,
} from "lucide-react";

/* ============================================================================
   Supabase read layer — publishable key only, read-only under RLS
   ==========================================================================*/

const ENV_URL = import.meta.env.VITE_SUPABASE_URL || "";
const ENV_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";

async function sb(path, { url, key }) {
  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const b = await res.json(); if (b?.message) msg += ` — ${b.message}`; } catch {}
    throw new Error(msg);
  }
  return res.json();
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
const pct = (n, d = 2) =>
  n == null || !isFinite(n) ? "—" : (n >= 0 ? "+" : "") + Number(n).toFixed(d) + "%";
const prettyDate = (d) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB",
      { day: "numeric", month: "short", year: "numeric" }) : "—";
const shortDate = (d) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "—";
const timeEAT = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", timeZone: "Africa/Dar_es_Salaam",
  });
};
const daysBetween = (a, b) =>
  Math.round((Date.parse(b + "T00:00:00") - Date.parse(a + "T00:00:00")) / 864e5);

const GREEN = "#22c55e";
const BLACK = "#0a0a0a";

/* ============================================================================
   UI atoms
   ==========================================================================*/

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
        capture
      </span>
    </div>
  );
}

function Eyebrow({ children }) {
  return (
    <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-gray-400 mb-1.5">
      {children}
    </div>
  );
}

function Health({ label, value, sub, tone = "neutral", icon: Icon }) {
  const ring = {
    good: "border-green-500/30 bg-green-500/[0.04]",
    warn: "border-amber-400/40 bg-amber-400/[0.05]",
    bad: "border-red-400/40 bg-red-400/[0.05]",
    neutral: "border-gray-200",
  }[tone];
  const text = {
    good: "text-green-600", warn: "text-amber-600", bad: "text-red-600", neutral: "text-neutral-950",
  }[tone];
  return (
    <div className={`rounded-xl border p-3.5 ${ring}`}>
      <div className="flex items-center justify-between mb-1">
        <Eyebrow>{label}</Eyebrow>
        {Icon && <Icon className={`w-3.5 h-3.5 ${text} opacity-60`} />}
      </div>
      <div className={`text-[21px] font-extrabold leading-none tabular-nums tracking-tight ${text}`}>
        {value}
      </div>
      {sub && <div className="text-[10.5px] text-gray-500 mt-1.5 leading-snug">{sub}</div>}
    </div>
  );
}

function Section({ title, hint, right, children }) {
  return (
    <section className="border border-gray-200 rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[13px] font-extrabold text-neutral-950">{title}</h2>
          {hint && <p className="text-[10.5px] text-gray-500 mt-0.5 leading-snug">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/* ============================================================================
   App
   ==========================================================================*/

export default function CaptureMonitor() {
  const [cfg, setCfg] = useState({ url: ENV_URL, key: ENV_KEY });
  const [draft, setDraft] = useState({ url: ENV_URL, key: ENV_KEY });
  const [showCfg, setShowCfg] = useState(!ENV_URL || !ENV_KEY);

  const [raw, setRaw] = useState([]);
  const [actions, setActions] = useState([]);
  const [instruments, setInstruments] = useState([]);
  const [state, setState] = useState({ loading: false, error: "", at: null });
  const [sortBy, setSortBy] = useState("volume");

  const load = useCallback(async () => {
    if (!cfg.url || !cfg.key) return;
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const [r, a, i] = await Promise.all([
        sb("price_raw?select=*&order=trade_date.desc,symbol.asc&limit=5000", cfg),
        sb("corporate_action?select=*", cfg),
        sb("instrument?select=symbol,name", cfg),
      ]);
      setRaw(r); setActions(a); setInstruments(i);
      setState({ loading: false, error: "", at: new Date().toISOString() });
    } catch (e) {
      setState({ loading: false, error: e.message, at: null });
    }
  }, [cfg]);

  useEffect(() => { load(); }, [load]);

  const nameOf = useMemo(() => {
    const m = {};
    instruments.forEach((i) => { m[i.symbol] = i.name; });
    return m;
  }, [instruments]);

  /* ---- derived ---- */
  const model = useMemo(() => {
    if (!raw.length) return null;

    const dates = [...new Set(raw.map((r) => r.trade_date))].sort();
    const latest = dates[dates.length - 1];
    const prev = dates.length > 1 ? dates[dates.length - 2] : null;
    const symbols = [...new Set(raw.map((r) => r.symbol))].sort();
    const sources = [...new Set(raw.map((r) => r.source))];

    const today = raw.filter((r) => r.trade_date === latest);
    // With several sources a symbol appears more than once, so count instruments
    // by distinct symbol rather than by row.
    const todaySymbols = [...new Set(today.map((r) => r.symbol))];
    // One row per symbol for display, preferring our own capture.
    const todayOne = todaySymbols.map((sym) => {
      const rows = today.filter((r) => r.symbol === sym);
      return rows.find((r) => r.source === "sokoview_quote") ?? rows[0];
    });
    const prevBySym = {};
    if (prev) raw.filter((r) => r.trade_date === prev).forEach((r) => { prevBySym[r.symbol] = r; });

    const withVolume = todayOne.filter((r) => r.volume != null);
    const tradedByVol = todayOne.filter((r) => r.volume != null && r.volume > 0);
    const seenFlag = todayOne.filter((r) => r.traded === true);

    // capture timestamps tell us which cron runs actually fired
    const stamps = today.map((r) => r.captured_at).filter(Boolean).sort();
    const runs = [];
    stamps.forEach((s) => {
      const t = new Date(s);
      const hhmm = t.toISOString().slice(11, 16);
      if (!runs.some((r) => Math.abs(Date.parse(r) - Date.parse(s)) < 20 * 60000)) runs.push(s);
    });

    // coverage matrix
    const covered = new Set(raw.map((r) => `${r.symbol}|${r.trade_date}`));

    // anomalies
    const actionKey = new Set(actions.map((a) => `${a.symbol}|${a.ex_date}`));
    const anomalies = [];
    // Scan a rolling window so a corporate action does not vanish from view the
    // next morning — you need it visible until it is recorded.
    const window = dates.slice(-14);
    const seenBig = new Set();
    raw.filter((r) => window.includes(r.trade_date)).forEach((r) => {
      const p = Math.abs(Number(r.pct_change ?? 0));
      const k = `${r.symbol}|${r.trade_date}`;
      if (p >= 18 && !seenBig.has(k)) {
        seenBig.add(k);
        anomalies.push({
          kind: actionKey.has(k) ? "action-known" : "action-suspect",
          symbol: r.symbol,
          detail: `${pct(r.pct_change, 1)} on ${shortDate(r.trade_date)}`,
        });
      }
    });
    symbols.forEach((s) => {
      if (!todaySymbols.includes(s)) {
        anomalies.push({ kind: "missing", symbol: s, detail: `no row for ${shortDate(latest)}` });
      }
    });
    todayOne.forEach((r) => {
      if (!r.upstream_at) return;
      const staleDays = daysBetween(String(r.upstream_at).slice(0, 10), latest);
      if (staleDays >= 5) {
        anomalies.push({
          kind: "stale", symbol: r.symbol,
          detail: `upstream last moved ${staleDays}d ago`,
        });
      }
    });

    const rank = { "action-suspect": 0, missing: 1, "action-known": 2, stale: 3 };
    anomalies.sort((a, b) => rank[a.kind] - rank[b.kind]);

    // reconciliation: same symbol+date, different sources
    const recon = [];
    if (sources.length > 1) {
      const byKey = {};
      raw.forEach((r) => {
        const k = `${r.symbol}|${r.trade_date}`;
        (byKey[k] ??= []).push(r);
      });
      Object.entries(byKey).forEach(([k, rows]) => {
        if (rows.length < 2) return;
        const [sym, date] = k.split("|");
        const vals = rows.map((r) => ({ source: r.source, close: Number(r.close) }));
        const spread = Math.max(...vals.map((v) => v.close)) - Math.min(...vals.map((v) => v.close));
        if (spread > 0.005) recon.push({ symbol: sym, date, vals, spread });
      });
      recon.sort((a, b) => b.spread - a.spread);
    }

    // liquidity across all captured history
    const liq = symbols.map((s) => {
      const rows = raw.filter((r) => r.symbol === s);
      const withVol = rows.filter((r) => r.volume != null);
      const tradedDays = withVol.filter((r) => r.volume > 0).length;
      const distinctPrices = new Set(rows.map((r) => Number(r.close))).size;
      return {
        symbol: s, days: rows.length, withVol: withVol.length, tradedDays,
        pctTraded: withVol.length ? (100 * tradedDays) / withVol.length : null,
        distinctPrices,
        totalVolume: withVol.reduce((t, r) => t + Number(r.volume || 0), 0),
      };
    });

    return {
      dates, latest, prev, symbols, sources, today: todayOne, todaySymbols, prevBySym,
      withVolume, tradedByVol, seenFlag, runs, covered, anomalies, recon, liq,
      dayNumber: dates.length,
      spanDays: dates.length > 1 ? daysBetween(dates[0], latest) + 1 : 1,
    };
  }, [raw, actions]);

  const todaySorted = useMemo(() => {
    if (!model) return [];
    const rows = [...model.today];
    const val = (r) => {
      if (sortBy === "volume") return r.volume == null ? -1 : Number(r.volume);
      if (sortBy === "move") return Math.abs(Number(r.pct_change ?? 0));
      if (sortBy === "price") return Number(r.close);
      return 0;
    };
    return sortBy === "symbol"
      ? rows.sort((a, b) => a.symbol.localeCompare(b.symbol))
      : rows.sort((a, b) => val(b) - val(a));
  }, [model, sortBy]);

  /* ---- config gate ---- */
  if (showCfg || !cfg.url || !cfg.key) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <div className="mb-6"><Logo /></div>
          <div className="border border-gray-200 rounded-2xl p-5">
            <h1 className="text-[16px] font-extrabold mb-1">Connect to Supabase</h1>
            <p className="text-[11.5px] text-gray-500 mb-4 leading-relaxed">
              Use the <strong className="text-neutral-900">publishable</strong> key
              (<code className="text-[10.5px] bg-gray-100 px-1 rounded">sb_publishable_…</code>),
              never the secret one. It is read-only under your row-level security policies
              and safe in a browser.
            </p>
            <label className="block mb-3">
              <Eyebrow>Project URL</Eyebrow>
              <input
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                placeholder="https://xxxx.supabase.co"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-[12px] font-semibold outline-none focus:border-green-500"
              />
            </label>
            <label className="block mb-4">
              <Eyebrow>Publishable key</Eyebrow>
              <input
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                placeholder="sb_publishable_…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-[12px] font-semibold outline-none focus:border-green-500"
              />
            </label>
            <button
              onClick={() => { setCfg(draft); setShowCfg(false); }}
              disabled={!draft.url || !draft.key}
              className="w-full bg-neutral-950 text-white text-[12px] font-bold py-2.5 rounded-lg hover:bg-neutral-800 disabled:opacity-30"
            >
              Connect
            </button>
            <p className="text-[10px] text-gray-400 mt-3 leading-snug">
              Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> in
              Netlify to skip this screen.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const volCoverage = model && model.today.length
    ? (100 * model.withVolume.length) / model.today.length : 0;

  return (
    <div className="min-h-screen bg-white text-neutral-950 antialiased">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&display=swap');
        * { font-family: 'Sora', ui-sans-serif, system-ui, sans-serif; }
        .tabular-nums { font-variant-numeric: tabular-nums; }
        @media (prefers-reduced-motion: reduce){ *{ transition:none !important; animation:none !important; } }
      `}</style>

      <header className="border-b border-gray-200 px-5 py-3 flex items-center justify-between gap-3 sticky top-0 bg-white/95 backdrop-blur z-20">
        <Logo />
        <div className="flex items-center gap-2">
          {state.at && (
            <span className="text-[10px] text-gray-400 font-semibold hidden sm:block">
              refreshed {timeEAT(state.at)} EAT
            </span>
          )}
          <button
            onClick={load}
            className="flex items-center gap-1.5 border border-gray-300 text-[11px] font-bold px-3 py-2 rounded-lg hover:border-neutral-900"
          >
            {state.loading
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
          <button
            onClick={() => { setDraft(cfg); setShowCfg(true); }}
            className="border border-gray-300 p-2 rounded-lg hover:border-neutral-900"
            aria-label="Connection settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-6 space-y-5">
        {state.error && (
          <div className="border border-red-300 bg-red-50 rounded-xl p-4 flex gap-2.5">
            <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <div className="text-[12px] font-bold text-red-700">Could not read Supabase</div>
              <div className="text-[11px] text-red-600 mt-0.5">{state.error}</div>
              <div className="text-[10.5px] text-gray-600 mt-1.5">
                Check the URL and that you used the publishable key. A 401 usually means the key
                is wrong; an empty result means row-level security is blocking reads.
              </div>
            </div>
          </div>
        )}

        {!model && !state.loading && !state.error && (
          <div className="border border-gray-200 rounded-2xl p-10 text-center">
            <Database className="w-7 h-7 text-gray-300 mx-auto mb-3" />
            <div className="text-[14px] font-extrabold mb-1">No rows captured yet</div>
            <div className="text-[11.5px] text-gray-500">
              Run the capture function, then refresh.
            </div>
          </div>
        )}

        {model && (
          <>
            {/* ---------- health strip ---------- */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Health
                label="Capture day"
                value={`Day ${model.dayNumber}`}
                sub={`${prettyDate(model.dates[0])} → ${prettyDate(model.latest)}`}
                icon={Calendar}
                tone="neutral"
              />
              <Health
                label="Instruments today"
                value={model.today.length}
                sub={`${model.symbols.length} seen across all days`}
                icon={Database}
                tone={model.today.length >= model.symbols.length ? "good" : "warn"}
              />
              <Health
                label="Volume coverage"
                value={`${volCoverage.toFixed(0)}%`}
                sub={
                  volCoverage === 0
                    ? "Session run is not delivering volume — check the 12:55 UTC cron"
                    : `${model.withVolume.length} of ${model.today.length} rows have volume`
                }
                icon={Activity}
                tone={volCoverage === 0 ? "bad" : volCoverage < 90 ? "warn" : "good"}
              />
              <Health
                label="Traded today"
                value={
                  model.withVolume.length
                    ? model.tradedByVol.length
                    : `${model.seenFlag.length}?`
                }
                sub={
                  model.withVolume.length
                    ? "by volume > 0 — reliable"
                    : "from the seen-today flag, not real trade evidence"
                }
                icon={TrendingUp}
                tone={model.withVolume.length ? "good" : "warn"}
              />
            </div>

            {/* ---------- anomalies ---------- */}
            {model.anomalies.length > 0 && (
              <Section
                title="Needs a look"
                hint="Large moves are usually corporate actions, not market moves. Recording them keeps the adjusted series continuous."
              >
                <div className="divide-y divide-gray-100">
                  {model.anomalies.slice(0, 12).map((a, i) => {
                    const tone = {
                      "action-suspect": "text-amber-600 bg-amber-50 border-amber-200",
                      "action-known": "text-green-700 bg-green-50 border-green-200",
                      missing: "text-red-600 bg-red-50 border-red-200",
                      stale: "text-gray-500 bg-gray-50 border-gray-200",
                    }[a.kind];
                    const label = {
                      "action-suspect": "Possible corporate action",
                      "action-known": "Corporate action recorded",
                      missing: "Missing from capture",
                      stale: "Stale upstream",
                    }[a.kind];
                    return (
                      <div key={i} className="px-4 py-2.5 flex items-center gap-3">
                        <span className={`text-[9px] font-bold uppercase tracking-wide px-2 py-1 rounded border ${tone}`}>
                          {label}
                        </span>
                        <span className="text-[12px] font-extrabold">{a.symbol}</span>
                        <span className="text-[11px] text-gray-500">{a.detail}</span>
                      </div>
                    );
                  })}
                </div>
              </Section>
            )}

            {/* ---------- today's market ---------- */}
            <Section
              title={`Market on ${prettyDate(model.latest)}`}
              hint={
                volCoverage === 0
                  ? "Volume is missing, so 'traded' below reflects the seen-today flag rather than actual trades."
                  : "Traded is derived from volume, which is direct evidence."
              }
              right={
                <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
                  {[
                    { v: "volume", l: "Volume" },
                    { v: "move", l: "Move" },
                    { v: "price", l: "Price" },
                    { v: "symbol", l: "A–Z" },
                  ].map((o) => (
                    <button
                      key={o.v}
                      onClick={() => setSortBy(o.v)}
                      className={`text-[10.5px] font-bold py-1 px-2 rounded ${
                        sortBy === o.v ? "bg-white shadow-sm text-neutral-950" : "text-gray-500"
                      }`}
                    >
                      {o.l}
                    </button>
                  ))}
                </div>
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full text-[11.5px]">
                  <thead>
                    <tr className="text-[9px] font-bold uppercase tracking-wide text-gray-400 border-b border-gray-100">
                      <th className="text-left px-4 py-2">Symbol</th>
                      <th className="text-right px-3 py-2">Close</th>
                      <th className="text-right px-3 py-2">Change</th>
                      <th className="text-right px-3 py-2">Volume</th>
                      <th className="text-center px-3 py-2">Traded</th>
                      <th className="text-right px-4 py-2">Upstream</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {todaySorted.map((r) => {
                      const ch = Number(r.pct_change ?? 0);
                      const hasVol = r.volume != null;
                      const traded = hasVol ? Number(r.volume) > 0 : r.traded;
                      return (
                        <tr key={r.symbol} className="hover:bg-gray-50">
                          <td className="px-4 py-2">
                            <div className="font-extrabold text-neutral-950">{r.symbol}</div>
                            <div className="text-[9.5px] text-gray-400 truncate max-w-[160px]">
                              {nameOf[r.symbol] !== r.symbol ? nameOf[r.symbol] : ""}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-bold tabular-nums">{tzs(r.close)}</td>
                          <td className={`px-3 py-2 text-right font-bold tabular-nums ${
                            ch > 0 ? "text-green-600" : ch < 0 ? "text-red-600" : "text-gray-400"
                          }`}>
                            {ch === 0 ? "—" : pct(ch, 2)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                            {hasVol ? nf.format(r.volume) : <span className="text-gray-300">null</span>}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {traded === true
                              ? <Check className="w-3.5 h-3.5 text-green-600 inline" />
                              : traded === false
                              ? <Minus className="w-3.5 h-3.5 text-gray-300 inline" />
                              : <span className="text-gray-300 text-[10px]">?</span>}
                          </td>
                          <td className="px-4 py-2 text-right text-[10px] text-gray-400 tabular-nums">
                            {r.upstream_at ? String(r.upstream_at).slice(0, 10) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>

            {/* ---------- coverage grid ---------- */}
            <Section
              title="Capture coverage"
              hint={`${model.dates.length} trading ${model.dates.length === 1 ? "day" : "days"} stored. Each cell is one symbol on one day — gaps mean a run failed.`}
            >
              <div className="p-4 overflow-x-auto">
                <div className="inline-block min-w-full">
                  <div className="flex gap-[3px] mb-1.5 pl-[92px]">
                    {model.dates.slice(-30).map((d) => (
                      <div key={d} className="w-[13px] text-[7.5px] text-gray-400 font-bold text-center"
                           style={{ writingMode: "vertical-rl" }}>
                        {shortDate(d).split(" ")[0]}
                      </div>
                    ))}
                  </div>
                  {model.symbols.map((s) => (
                    <div key={s} className="flex items-center gap-[3px] mb-[3px]">
                      <div className="w-[88px] text-[9.5px] font-bold text-gray-600 truncate text-right pr-1">
                        {s}
                      </div>
                      {model.dates.slice(-30).map((d) => {
                        const has = model.covered.has(`${s}|${d}`);
                        return (
                          <div
                            key={d}
                            title={`${s} · ${d} · ${has ? "captured" : "missing"}`}
                            className={`w-[13px] h-[13px] rounded-[2px] ${
                              has ? "bg-green-500" : "bg-gray-200"
                            }`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </Section>

            {/* ---------- liquidity ---------- */}
            <Section
              title="Liquidity"
              hint={
                model.liq.some((l) => l.withVol > 0)
                  ? "Share of captured days each stock actually traded. The scarce number — nobody publishes this cleanly for the DSE."
                  : "Needs volume data. Once the session run delivers it, this becomes the most valuable view here."
              }
            >
              {model.liq.some((l) => l.withVol > 0) ? (
                <div className="p-4" style={{ height: 320 }}>
                  <ResponsiveContainer>
                    <BarChart
                      data={[...model.liq].filter((l) => l.withVol > 0)
                        .sort((a, b) => b.pctTraded - a.pctTraded)}
                      margin={{ top: 4, right: 8, bottom: 40, left: 0 }}
                    >
                      <CartesianGrid stroke="#f3f4f6" vertical={false} />
                      <XAxis dataKey="symbol" angle={-55} textAnchor="end" height={60}
                             tick={{ fontSize: 9, fill: "#9ca3af", fontWeight: 700 }}
                             axisLine={{ stroke: "#e5e7eb" }} tickLine={false} />
                      <YAxis tickFormatter={(v) => v + "%"} domain={[0, 100]}
                             tick={{ fontSize: 10, fill: "#9ca3af", fontWeight: 600 }}
                             axisLine={false} tickLine={false} width={38} />
                      <Tooltip
                        contentStyle={{ borderRadius: 12, border: "1px solid #e5e7eb",
                                        fontSize: 11, fontWeight: 700 }}
                        formatter={(v, n, p) => [
                          `${Number(v).toFixed(0)}% of days · ${compact(p.payload.totalVolume)} shares`,
                          "Traded",
                        ]}
                      />
                      <Bar dataKey="pctTraded" radius={[3, 3, 0, 0]}>
                        {model.liq.filter((l) => l.withVol > 0).map((l, i) => (
                          <Cell key={i} fill={l.pctTraded >= 50 ? GREEN : l.pctTraded >= 20 ? "#86efac" : "#d1d5db"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="p-8 text-center">
                  <Activity className="w-6 h-6 text-gray-300 mx-auto mb-2" />
                  <div className="text-[12px] font-bold text-gray-500">No volume captured yet</div>
                  <div className="text-[10.5px] text-gray-400 mt-1 max-w-md mx-auto leading-snug">
                    Your quote endpoint returns volume only while the market is open. If the session
                    run fires outside 10:30–16:00 EAT, volume comes back null.
                  </div>
                </div>
              )}
            </Section>

            {/* ---------- reconciliation ---------- */}
            <Section
              title="Reconciliation"
              hint="Where two sources disagree on the same day. Differences usually mean an unrecorded corporate action."
            >
              {model.sources.length < 2 ? (
                <div className="p-6 text-center">
                  <div className="text-[12px] font-bold text-gray-500">
                    Only one source so far — {model.sources.join(", ")}
                  </div>
                  <div className="text-[10.5px] text-gray-400 mt-1 max-w-lg mx-auto leading-snug">
                    Load African Markets history with <code className="bg-gray-100 px-1 rounded">source = 'african_markets'</code> and
                    overlapping days will be compared here automatically.
                  </div>
                </div>
              ) : model.recon.length === 0 ? (
                <div className="p-6 text-center text-[12px] font-bold text-green-600">
                  <Check className="w-4 h-4 inline mr-1" />
                  All overlapping days agree across {model.sources.length} sources
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {model.recon.slice(0, 20).map((r, i) => (
                    <div key={i} className="px-4 py-2.5 flex items-center gap-4 flex-wrap">
                      <span className="text-[12px] font-extrabold w-20">{r.symbol}</span>
                      <span className="text-[10.5px] text-gray-500 w-24">{shortDate(r.date)}</span>
                      {r.vals.map((v) => (
                        <span key={v.source} className="text-[11px] tabular-nums">
                          <span className="text-gray-400">{v.source}</span>{" "}
                          <strong>{tzs(v.close)}</strong>
                        </span>
                      ))}
                      <span className="text-[11px] font-bold text-amber-600 tabular-nums ml-auto">
                        Δ {tzs(r.spread)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <div className="flex gap-2.5 text-[10.5px] text-gray-500 leading-relaxed border border-gray-200 rounded-xl p-3.5">
              <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-gray-400" />
              <p>
                This reads <code className="bg-gray-100 px-1 rounded">price_raw</code> directly, so it
                shows what was actually captured rather than the cleaned series. Use{" "}
                <code className="bg-gray-100 px-1 rounded">price_daily</code> for the deduplicated view
                and <code className="bg-gray-100 px-1 rounded">price_adjusted</code> once corporate
                actions are recorded.
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
