import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarDays, History, Home as HomeIcon, LineChart, Moon, Search, Sun, X } from 'lucide-react';
import { useTheme } from '../theme/theme.js';
import { loadInstruments } from '../lib/marketData.js';
import { logoUrl, monogramColor, monogramText } from '../logos.js';
import './site-nav.css';

// One navigation for every investor page. Admin tools (/capture, /report) are left out on purpose.
export const NAV_ITEMS = [
  { key: 'home', label: 'Home', href: '/', Icon: HomeIcon },
  { key: 'replay', label: 'Replay', href: '/replay', Icon: History },
  { key: 'dividends', label: 'Dividends', href: '/dividends', Icon: CalendarDays },
  { key: 'stocks', label: 'Stocks', href: '/stock', Icon: LineChart },
];

export const stockHref = (symbol) => `/stock?symbol=${encodeURIComponent(symbol)}`;
export const replayHref = (symbol, from) =>
  `/replay?symbol=${encodeURIComponent(symbol)}${from ? `&from=${from}` : ''}`;
export const dividendsHref = (symbol) => (symbol ? `/dividends?symbol=${encodeURIComponent(symbol)}` : '/dividends');

export function SvLogo() {
  return (
    <span className="sv-logo">
      <span className="sv-logo__mark" aria-hidden="true"><i /><i /><i /></span>
      <span className="sv-logo__word">sokoview</span>
    </span>
  );
}

export function SvMark({ symbol, size = 28 }) {
  const url = logoUrl(symbol);
  const [failed, setFailed] = useState(false);
  const mono = !url || failed;
  return (
    <span className={`sv-mark${mono ? ' sv-mark--mono' : ''}`} aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.32, ...(mono ? { background: monogramColor(symbol) } : {}) }}>
      {mono ? monogramText(symbol) : <img src={url} alt="" onError={() => setFailed(true)} />}
    </span>
  );
}

const KIND_LABEL = { equity: 'Stock', etf: 'ETF', fund: 'Unit trust' };

function StockSearch({ autoFocus = false, onDone }) {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrap = useRef(null);
  const input = useRef(null);

  useEffect(() => { loadInstruments().then(setItems); }, []);
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, []);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items.filter((i) => i.kind === 'equity').slice(0, 8);
    const starts = []; const contains = [];
    for (const i of items) {
      const s = i.symbol.toLowerCase(); const n = i.name.toLowerCase();
      if (s.startsWith(t) || n.startsWith(t)) starts.push(i);
      else if (s.includes(t) || n.includes(t)) contains.push(i);
    }
    return [...starts, ...contains].slice(0, 8);
  }, [items, q]);

  useEffect(() => setActive(0), [q]);

  const go = (item) => {
    if (!item) return;
    window.location.href = stockHref(item.symbol);
    onDone?.();
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
    else if (e.key === 'Escape') { setOpen(false); onDone?.(); }
  };

  return (
    <div className="sv-search" ref={wrap}>
      <Search className="sv-search__icon" aria-hidden="true" />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && results[active] ? `${listId}-${results[active].symbol}` : undefined}
        aria-autocomplete="list"
        aria-label="Search stocks"
        placeholder="Search stocks"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {open && results.length > 0 && (
        <ul className="sv-search__list" id={listId} role="listbox">
          {results.map((r, i) => (
            <li key={r.symbol} id={`${listId}-${r.symbol}`} role="option" aria-selected={i === active}
              className={i === active ? 'is-active' : undefined}
              onPointerEnter={() => setActive(i)}
              onPointerDown={(e) => { e.preventDefault(); go(r); }}>
              <SvMark symbol={r.symbol} size={26} />
              <span className="sv-search__text">
                <b>{r.symbol}</b>
                <small>{r.name}</small>
              </span>
              {r.kind !== 'equity' && <span className="sv-search__kind">{KIND_LABEL[r.kind] || r.kind}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="sv-theme" onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </button>
  );
}

/** The one line every page opens with: what the page is, in small type, plus optional actions. */
export function PageIntro({ title, children, actions }) {
  return (
    <div className="sv-intro">
      <div className="sv-intro__lead">
        {title && <h1 className="sv-intro__title">{title}</h1>}
        <p className="sv-intro__text">{children}</p>
      </div>
      {actions && <div className="sv-intro__actions">{actions}</div>}
    </div>
  );
}

export default function SiteNav({ active }) {
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add('sv-has-nav');
    return () => document.documentElement.classList.remove('sv-has-nav');
  }, []);

  return (
    <>
      <header className="sv-nav">
        <div className="sv-nav__inner">
          <a href="/" className="sv-nav__brand" aria-label="Sokoview home"><SvLogo /></a>
          <nav className="sv-nav__tabs" aria-label="Main">
            {NAV_ITEMS.map(({ key, label, href }) => (
              <a key={key} href={href} className="sv-nav__tab" aria-current={active === key ? 'page' : undefined}>{label}</a>
            ))}
          </nav>
          <div className="sv-nav__actions">
            <div className="sv-nav__search"><StockSearch /></div>
            <button type="button" className="sv-nav__searchbtn" aria-label="Search stocks" onClick={() => setSearching(true)}>
              <Search aria-hidden="true" />
            </button>
            <ThemeToggle />
          </div>
        </div>
        {searching && (
          <div className="sv-nav__overlay">
            <StockSearch autoFocus onDone={() => setSearching(false)} />
            <button type="button" className="sv-nav__close" aria-label="Close search" onClick={() => setSearching(false)}>
              <X aria-hidden="true" />
            </button>
          </div>
        )}
      </header>

      {/* Phone: the same four destinations as a bottom tab bar. */}
      <nav className="sv-tabbar" aria-label="Main">
        {NAV_ITEMS.map(({ key, label, href, Icon }) => (
          <a key={key} href={href} className="sv-tabbar__item" aria-current={active === key ? 'page' : undefined}>
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </a>
        ))}
      </nav>
    </>
  );
}
