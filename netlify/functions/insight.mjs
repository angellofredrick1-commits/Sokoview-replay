/**
 * Replay insight — Claude writes two or three short observations about a
 * finished simulation.
 *
 * The API key never reaches the browser: the client posts a compact summary
 * here, this function adds the key and calls Anthropic.
 *
 * Cost control, in order of how much each one saves:
 *   1. Haiku 4.5 — $1 / $5 per million input / output tokens, the cheapest
 *      current Claude model, and this task is summarising ~30 numbers.
 *   2. Only summary statistics are sent, never the price series. A request is
 *      roughly 400 input tokens.
 *   3. max_tokens is capped at 320, so a runaway generation cannot happen.
 *   4. The client caches per configuration and debounces, so scrubbing the
 *      replay or dragging a slider does not bill anything.
 *   5. Responses are cached at the edge for a day — identical simulations
 *      (the presets, mostly) are answered without a second call.
 * That lands around US$0.0015 per insight.
 */

const MODEL = "claude-haiku-4-5-20251001";
const ENDPOINT = "https://api.anthropic.com/v1/messages";

const SYSTEM = `You explain the results of a historical investment simulation on the Dar es Salaam Stock Exchange, for an audience of ordinary Tanzanian savers.

Write 2-3 observations about what the numbers show. Rules:
- Describe only what happened in this simulation. Never predict, never recommend buying, selling or holding, and never tell the reader what they should do.
- Prefer the comparison the numbers actually support. If one plan won on total value but the other won on annualised return, say so plainly — that gap is usually the most useful thing on the screen.
- Mention dividends, uninvested cash, the worst drawdown or the brokerage drag only when they materially changed the outcome.
- Amounts are Tanzanian shillings, written as TZS 1,234,567. Round in prose.
- Plain language, no jargon, no hype, no emoji. Each observation is one or two sentences.
- If the data is sample data rather than real prices, treat it as illustrative and say nothing that implies it is a real track record.

Respond with JSON only, no markdown fence, in exactly this shape:
{"insights":[{"title":"Four words max","body":"One or two sentences."}]}`;

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return Response.json(
      { error: "Insights are not configured for this deploy (ANTHROPIC_API_KEY is unset)." },
      { status: 503 }
    );
  }

  let summary;
  try {
    summary = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  // Guard against an oversized payload being forwarded and billed.
  const payload = JSON.stringify(summary);
  if (payload.length > 6000) {
    return Response.json({ error: "Summary too large." }, { status: 413 });
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 320,
        temperature: 0.4,
        system: SYSTEM,
        messages: [{ role: "user", content: payload }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return Response.json(
        { error: `Anthropic API ${res.status}`, detail: detail.slice(0, 300) },
        { status: 502 }
      );
    }

    const data = await res.json();
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    let insights;
    try {
      insights = JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim()).insights;
    } catch {
      // A well-formed sentence is better than an error if the JSON slips.
      insights = text ? [{ title: "What happened", body: text }] : [];
    }

    return Response.json(
      { insights, model: MODEL, usage: data.usage ?? null },
      { headers: { "cache-control": "public, max-age=86400" } }
    );
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};

export const config = { path: "/api/insight" };
