/**
 * Portfolio insight: Claude writes two or three short observations about how a
 * user's DSE portfolio has done: the return over the period and what drove it.
 *
 * Same safeguards as insight.mjs (Replay):
 * - the API key stays on the server (ANTHROPIC_API_KEY on Netlify);
 * - only a compact numeric summary is sent: symbols, weights, returns. No name,
 *   email or account id ever leaves the browser;
 * - Haiku, max_tokens capped, payload size capped; the browser caches each answer
 *   for a day, so reloading the page doesn't bill again.
 */

const MODEL = "claude-haiku-4-5-20251001";
const ENDPOINT = "https://api.anthropic.com/v1/messages";

const SYSTEM = `You explain how one person's Dar es Salaam Stock Exchange portfolio has done, for an ordinary Tanzanian saver reading it on their phone.

You get a JSON summary. "period" is the return over the whole time they have invested: money put in, money taken out on sales, what their holdings are worth now, the gain, the return in percent, and an annual rate that weights each shilling by how long it was invested. There are also holdings with weights and gains, dividends, and buying activity.

Write 2-3 observations. Rules:
- Lead with the return over the period: how much they put in, what it is worth now, and the gain or loss in TZS and percent. Mention the annual rate when present; when it is missing the history is too short to annualise.
- Then explain what drove it: usually one or two holdings, or how concentrated the portfolio is in one stock.
- If dividends materially add to the return, say so.
- Describe only what has happened. Never compare with an index or other investments, never predict prices, never recommend buying, selling or holding any stock, and never tell the reader what they should do.
- If the history is short (under about six months) or there are very few trades, say it is early and the numbers could change a lot.
- Amounts are Tanzanian shillings, written like TZS 1.2M or TZS 450,000. Round in prose. Plain language, no jargon, no hype, no emoji. Each observation is one or two sentences.

Respond with JSON only, no markdown fence, in exactly this shape:
{"insights":[{"title":"Four words max","body":"One or two sentences."}]}`;

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return Response.json({ error: "Insights are not configured for this deploy (ANTHROPIC_API_KEY is unset)." }, { status: 503 });
  }

  let summary;
  try { summary = await req.json(); } catch { return Response.json({ error: "Body must be JSON." }, { status: 400 }); }

  const payload = JSON.stringify(summary);
  if (payload.length > 8000) return Response.json({ error: "Summary too large." }, { status: 413 });

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 380,
        temperature: 0.3,
        system: SYSTEM,
        messages: [{ role: "user", content: payload }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return Response.json({ error: `Anthropic API ${res.status}`, detail: detail.slice(0, 300) }, { status: 502 });
    }
    const data = await res.json();
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    let insights;
    try {
      insights = JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim()).insights;
    } catch {
      insights = text ? [{ title: "How it's going", body: text }] : [];
    }
    // Private data: never cache this at a shared edge.
    return Response.json({ insights, model: MODEL }, { headers: { "cache-control": "private, no-store" } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};

export const config = { path: "/api/portfolio-insight" };
