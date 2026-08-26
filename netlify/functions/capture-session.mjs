/**
 * Runs 15:55 EAT (12:55 UTC) Mon–Fri — five minutes before the DSE close,
 * while the market is still open, so `volume` is still populated.
 */
import { schedule } from "@netlify/functions";
import { capture } from "../../lib/capture.mjs";

export const handler = schedule("55 12 * * 1-5", async () => {
  try {
    const result = await capture("session");
    console.log("capture-session", JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error("capture-session failed:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
});
