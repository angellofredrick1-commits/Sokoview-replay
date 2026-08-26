/**
 * Runs 16:30 EAT (13:30 UTC) Mon–Fri — after the 16:00 close, for the settled
 * closing price. Volume is omitted so the session run's value survives.
 */
import { schedule } from "@netlify/functions";
import { capture } from "../../lib/capture.mjs";

export const handler = schedule("30 13 * * 1-5", async () => {
  try {
    const result = await capture("close");
    console.log("capture-close", JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error("capture-close failed:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
});
