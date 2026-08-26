/**
 * Manual trigger for testing, so you don't wait for a cron.
 *   GET /.netlify/functions/capture-now?phase=session&token=YOUR_TOKEN
 *
 * Protected by CAPTURE_TRIGGER_TOKEN — set it to any random string. Without it
 * this endpoint is disabled, since it writes to your database.
 */
import { capture } from "../../lib/capture.mjs";

export const handler = async (event) => {
  const expected = process.env.CAPTURE_TRIGGER_TOKEN;
  const given = event.queryStringParameters?.token;

  if (!expected) {
    return { statusCode: 404, body: JSON.stringify({ error: "Manual trigger disabled" }) };
  }
  if (given !== expected) {
    return { statusCode: 401, body: JSON.stringify({ error: "Bad token" }) };
  }

  const phase = event.queryStringParameters?.phase === "session" ? "session" : "close";
  try {
    const result = await capture(phase);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result, null, 2),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
