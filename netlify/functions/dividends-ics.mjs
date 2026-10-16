// Subscribable iCalendar feed of DSE dividend dates.
//   /dividends.ics                          all stocks, last day to buy + payment
//   /dividends.ics?symbols=CRDB,NMB         only these stocks
//   /dividends.ics?types=lastbuy,ex,record,pay,announce,agm
//   /dividends.ics?expected=1               add expected (not yet announced) dividends as tentative
// Reads the same dividend_calendar view as the page; falls back to the bundled seed.
import seed from '../../src/data/seed.json';
import { EVENT_TYPES, DEFAULT_FEED_TYPES, buildICS, calendarDividends, toEvents, todayISO, addDays } from '../../src/lib/dividends.js';

const SB_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_SERVICE_KEY;

async function sb(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function load() {
  if (SB_URL && SB_KEY) {
    try {
      const [dividends, splits] = await Promise.all([
        sb('dividend_calendar?select=*'),
        sb('corporate_action?select=symbol,ex_date,value&kind=eq.split'),
      ]);
      return {
        dividends: dividends.map((d) => ({ ...d, amount: Number(d.amount) })),
        splits: splits.map((s) => ({ symbol: s.symbol, ex_date: s.ex_date, ratio: Number(s.value) })),
      };
    } catch (e) {
      console.error('dividends-ics: falling back to seed:', e.message);
    }
  }
  return { dividends: seed, splits: [{ symbol: 'NMB', ex_date: '2026-08-26', ratio: 10 }] };
}

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const symbols = (q.get('symbols') || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
  const types = (q.get('types') || DEFAULT_FEED_TYPES.join(',')).split(',').filter((t) => t in EVENT_TYPES);
  const includeExpected = q.get('expected') === '1';
  const today = todayISO();

  const { dividends, splits } = await load();
  const scoped = symbols.length ? dividends.filter((d) => symbols.includes(d.symbol)) : dividends;
  const all = calendarDividends(scoped, { today, includeExpected, splits });
  // Keep a year of history so freshly subscribed calendars aren't empty.
  const from = addDays(today, -365);
  const events = toEvents(all, { splits, types, today }).filter((e) => e.date >= from);

  const name = symbols.length ? `Sokoview dividends: ${symbols.join(', ')}` : 'Sokoview · DSE dividends';
  return new Response(buildICS(events, { calName: name, splits }), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="sokoview-dividends.ics"',
      'Cache-Control': 'public, max-age=1800',
      'Access-Control-Allow-Origin': '*',
    },
  });
};
