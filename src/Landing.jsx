import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CalendarDays, History, Info, Landmark, LayoutGrid, LockKeyhole, TrendingUp } from 'lucide-react';
import { SvLogo, SvMark, ThemeToggle, stockHref } from './nav/SiteNav.jsx';
import { loadMarket } from './lib/marketData.js';
import { fromISO } from './lib/dividends.js';
import './landing.css';

const nf = new Intl.NumberFormat('en-US');
const pct = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`;

/** A Supabase session in this browser means "Open your portfolio" rather than "Sign in". */
function hasSession() {
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (/^sb-.+-auth-token$/.test(k) && localStorage.getItem(k)) return true;
    }
  } catch { /* storage blocked */ }
  return false;
}

function useHeaderScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return scrolled;
}

// ---------- live board strip (real closes, nothing invented) ----------
function BoardStrip({ market, to }) {
  if (!market?.snapshot?.length) return <div className="ld-board ld-board--loading" aria-hidden="true" />;
  const snap = market.snapshot;
  const date = snap.reduce((d, r) => (r.trade_date > d ? r.trade_date : d), '');
  const rows = [...snap].sort((a, b) => Math.abs(b.pct_change || 0) - Math.abs(a.pct_change || 0) || a.symbol.localeCompare(b.symbol)).slice(0, 8);
  return (
    <figure className="ld-board">
      <figcaption>
        <span className="ld-live" aria-hidden="true" />
        DSE close, {fromISO(date).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })}
        {market.mode === 'sample' && ' (sample)'}
      </figcaption>
      <ul>
        {rows.map((r) => (
          <li key={r.symbol}>
            <a href={to(stockHref(r.symbol))} className="ld-tile">
              <span className="ld-tile__top"><SvMark symbol={r.symbol} size={20} /><b>{r.symbol}</b></span>
              <span className="ld-tile__close">{nf.format(r.close)}</span>
              <span className={`ld-tile__chg ${r.pct_change > 0 ? 'is-up' : r.pct_change < 0 ? 'is-down' : ''}`}>{r.pct_change ? pct(r.pct_change) : 'unchanged'}</span>
            </a>
          </li>
        ))}
      </ul>
      <a className="ld-board__more" href={to('/market')}>All {snap.length} shares <ArrowRight aria-hidden="true" /></a>
    </figure>
  );
}

// ---------- small illustrations (shapes only, no made-up numbers) ----------
function VsArt() {
  return (
    <svg viewBox="0 0 240 120" className="ld-art" aria-hidden="true">
      <path d="M8 104 H232" stroke="var(--sv-line)" />
      <path d="M8 94 L48 90 L88 74 L128 78 L168 52 L208 40 L232 26 V104 H8 Z" fill="var(--sv-accent-soft)" />
      <path d="M8 94 L48 90 L88 74 L128 78 L168 52 L208 40 L232 26" fill="none" stroke="var(--sv-series-1)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 96 H64 V86 H140 V76 H232" fill="none" stroke="var(--sv-chart-axis)" strokeWidth="1.5" strokeDasharray="4 4" />
    </svg>
  );
}

function GridArt({ market }) {
  const cells = (market?.snapshot || []).slice(0, 15);
  const fill = (p) => (!p ? 'var(--sv-surface-2)' : p > 0 ? 'var(--sv-accent-soft)' : 'var(--sv-down-soft)');
  return (
    <svg viewBox="0 0 240 120" className="ld-art" aria-hidden="true">
      {Array.from({ length: 15 }, (_, i) => (
        <rect key={i} x={8 + (i % 5) * 46} y={8 + Math.floor(i / 5) * 36} width="40" height="30" rx="7" fill={fill(cells[i]?.pct_change)} />
      ))}
    </svg>
  );
}

function CalArt() {
  return (
    <svg viewBox="0 0 240 120" className="ld-art" aria-hidden="true">
      {Array.from({ length: 21 }, (_, i) => {
        const mark = { 4: 'var(--sv-warn)', 9: 'var(--sv-accent)', 16: 'var(--sv-series-2)' }[i];
        return <rect key={i} x={12 + (i % 7) * 32} y={10 + Math.floor(i / 7) * 34} width="26" height="28" rx="6" fill={mark || 'var(--sv-surface-2)'} opacity={mark ? 0.9 : 1} />;
      })}
    </svg>
  );
}

function ReplayArt() {
  return (
    <svg viewBox="0 0 240 120" className="ld-art" aria-hidden="true">
      <path d="M8 104 L40 100 L72 102 L104 90 L136 78 L168 70 L200 40 L232 22 V112 H8 Z" fill="var(--sv-accent-soft)" />
      <path d="M8 104 L40 100 L72 102 L104 90 L136 78 L168 70 L200 40 L232 22" fill="none" stroke="var(--sv-accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="232" cy="22" r="5" fill="var(--sv-accent)" stroke="var(--sv-page)" strokeWidth="2" />
    </svg>
  );
}

const FEATURES = [
  {
    key: 'portfolio', href: '/portfolio', Icon: TrendingUp, title: 'What your money has really earned',
    body: 'Enter your buys and sells; the price fills in from the date. See what you put in against what it’s worth now, your dividends, your best and weakest holdings, and a plain-language summary.',
    Art: VsArt,
  },
  {
    key: 'market', href: '/market', Icon: LayoutGrid, title: 'The whole market on one screen',
    body: 'Every listed share at the last close, coloured by the day’s move. Tap any one for its price history and dividends.',
    Art: GridArt,
  },
  {
    key: 'dividends', href: '/dividends', Icon: CalendarDays, title: 'Never miss a dividend date',
    body: 'The last day to buy, the books-closure date and the payment date for every declared dividend, ready to add to your own calendar.',
    Art: CalArt,
  },
  {
    key: 'replay', href: '/replay', Icon: History, title: 'Replay any past investment',
    body: 'Pick a stock, a date and an amount, and watch what it would be worth now, month by month, with dividends counted.',
    Art: ReplayArt,
  },
];

export default function Landing() {
  const [market, setMarket] = useState(null);
  const signedIn = useMemo(hasSession, []);
  const scrolled = useHeaderScrolled();

  useEffect(() => { loadMarket().then(setMarket).catch(() => setMarket(null)); }, []);

  const cta = signedIn ? 'Open your portfolio' : 'Sign in';
  // Everything past this page is for signed-in users: signed out, links go via sign-in and come back.
  const to = (path) => (signedIn || path === '/portfolio' ? path : `/portfolio?next=${encodeURIComponent(path)}`);

  return (
    <div className="ld">
      <header className={`ld-head${scrolled ? ' is-scrolled' : ''}`}>
        <div className="ld-head__inner">
          <a href="/" className="ld-brand" aria-label="Sokoview"><SvLogo /></a>
          <nav className="ld-head__links" aria-label="Explore">
            <a href={to('/market')}>Market</a>
            <a href={to('/dividends')}>Dividends</a>
            <a href={to('/replay')}>Replay</a>
          </nav>
          <div className="ld-head__actions">
            <ThemeToggle />
            <a href="/portfolio" className="ld-btn ld-btn--small">{cta}</a>
          </div>
        </div>
      </header>

      <main>
        <section className="ld-hero">
          <p className="ld-eyebrow">For investors on the Dar es Salaam Stock Exchange</p>
          <h1 className="ld-display">Know how your shares are really doing.</h1>
          <p className="ld-lede">
            Sokoview tracks your DSE portfolio, shows what your money has really earned, and keeps every dividend date in view. Free, in plain language, built in Tanzania.
          </p>
          <div className="ld-ctas">
            <a href="/portfolio" className="ld-btn">{cta} <ArrowRight aria-hidden="true" /></a>
            <a href={to('/market')} className="ld-btn ld-btn--ghost">See today’s market</a>
          </div>
          {!signedIn && <p className="ld-hint">No password. We email you a sign-in link.</p>}
          <BoardStrip market={market} to={to} />
        </section>

        <section className="ld-features" aria-label="What Sokoview does">
          {FEATURES.map(({ key, href, Icon, title, body, Art }) => (
            <a key={key} href={to(href)} className={`ld-feature ld-feature--${key}`}>
              <span className="ld-feature__icon"><Icon aria-hidden="true" /></span>
              <h2>{title}</h2>
              <p>{body}</p>
              <Art market={market} />
              <span className="ld-feature__go">{signedIn || key === 'portfolio' ? 'Open' : 'Sign in to open'} <ArrowRight aria-hidden="true" /></span>
            </a>
          ))}
        </section>

        <section className="ld-steps" aria-labelledby="ld-steps-h">
          <h2 id="ld-steps-h" className="ld-h2">Set up in a few minutes.</h2>
          <ol>
            <li><b>Sign in with your email.</b><span>We send a one-time link. There’s no password to remember.</span></li>
            <li><b>Add your trades.</b><span>The stock, the date, the number of shares. The closing price for that day fills itself in, and splits are handled for you.</span></li>
            <li><b>See where you stand.</b><span>Money in against value now, your return a year, dividends received and coming, and a short AI-written summary of what drove it.</span></li>
          </ol>
        </section>

        <section className="ld-trust" aria-labelledby="ld-trust-h">
          <h2 id="ld-trust-h" className="ld-h2">Straightforward about what it is.</h2>
          <ul>
            <li><LockKeyhole aria-hidden="true" /><span><b>Your trades are yours.</b> Only you can see them once signed in. The AI summary gets amounts and stock symbols, never your email.</span></li>
            <li><Landmark aria-hidden="true" /><span><b>Not a broker.</b> Sokoview doesn’t hold money or connect to your CDS account. You buy and sell through your broker as usual.</span></li>
            <li><Info aria-hidden="true" /><span><b>Not investment advice.</b> Sokoview describes what has happened. It never tells you what to buy or sell.</span></li>
          </ul>
        </section>

        <section className="ld-final">
          <h2 className="ld-h2">Start with what you already own.</h2>
          <a href="/portfolio" className="ld-btn">{cta} <ArrowRight aria-hidden="true" /></a>
        </section>
      </main>

      <footer className="ld-foot">
        <SvLogo />
        <nav aria-label="Footer">
          <a href="/portfolio">Portfolio</a><a href={to('/market')}>Market</a><a href={to('/dividends')}>Dividends</a><a href={to('/replay')}>Replay</a>
        </nav>
        <p>Prices from the Dar es Salaam Stock Exchange. Information only, not investment advice.</p>
      </footer>
    </div>
  );
}
