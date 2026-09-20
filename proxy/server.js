// Local proxy for the TypeSafe API.
//
// The extension never sees TYPESAFE_API_KEY. It posts a request body here and
// this process adds the Authorization header. Bound to 127.0.0.1 only.
//
//   node --env-file=../.env server.js

import { createServer } from "node:http";
import { appendFile } from "node:fs/promises";

const PORT = Number(process.env.JEV_PROXY_PORT ?? 8787);
const API_URL = `${process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai"}/v1/systemone`;
const API_KEY = process.env.TYPESAFE_API_KEY;
const MAX_BODY = 2 * 1024 * 1024;
const TRACE = process.env.JEV_TRACE_FILE ?? "/tmp/jev-trace.jsonl";

if (!API_KEY) {
  console.error("TYPESAFE_API_KEY is not set. Run with: node --env-file=../.env server.js");
  process.exit(1);
}

// Only our own extension may call this. Chrome sends Origin: chrome-extension://<id>
// on fetches from a service worker. The id is stable once the extension is loaded;
// set JEV_ALLOWED_EXTENSION_ID in .env to pin it.
const ALLOWED_ID = process.env.JEV_ALLOWED_EXTENSION_ID ?? null;

function originAllowed(origin) {
  if (!origin) return false;
  if (!origin.startsWith("chrome-extension://")) return false;
  if (!ALLOWED_ID) return true; // dev default: any extension on this machine
  return origin === `chrome-extension://${ALLOWED_ID}`;
}

function send(res, status, payload, origin) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": origin ?? "null",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "vary": "origin",
  });
  res.end(body);
}

// Log what was actually asked and what came back. Without the utterance and the
// answers side by side, a wrong action is undiagnosable after the fact.
async function trace(body, parsed, ms) {
  const state = body?.state ?? {};
  const answers = parsed?.answers ?? {};
  const utterance = state.utterance ?? state.question ?? "(none)";

  const summary = Object.entries(answers).map(([id, a]) => {
    if (a.type === "noul") return `${id}=${a.noul.toFixed(2)}`;
    if (a.type === "choice") return `${id}=${a.choice}@${a.confidence.toFixed(2)}`;
    if (a.type === "score") return `${id}=${a.score.toFixed(2)}@${a.confidence.toFixed(2)}`;
    return id;
  }).join("  ");

  const counts = `${(state.elements ?? []).length}el/${(state.typeables ?? []).length}fld/${(state.sections ?? []).length}sec`;
  console.log(`\n▸ "${utterance}"`);
  console.log(`  ${ms}ms · ${parsed?.usage?.input_tokens ?? "?"} tok · ${counts}`);
  console.log(`  ${summary}`);

  // Full detail, one JSON object per line, for later analysis.
  try {
    await appendFile(TRACE, JSON.stringify({
      kind: "call",
      at: new Date().toISOString(),
      ms,
      utterance,
      page: state.page ?? null,
      tokens: parsed?.usage?.input_tokens ?? null,
      elements: state.elements ?? [],
      typeables: state.typeables ?? [],
      open_tabs: state.open_tabs ?? [],
      sections: (state.sections ?? []).map((s) => ({ id: s.id, text: s.text?.slice(0, 80) })),
      answers,
    }) + "\n");
  } catch { /* tracing must never break a request */ }
}

const MARK = { true: "\u001b[32m✓\u001b[0m", false: "\u001b[33m·\u001b[0m" };

/** The authoritative per-command record: did it run, and if not, which gate stopped it. */
async function recordOutcome(entry) {
  const ran = entry.executed === true;
  const mark = ran ? MARK.true : (entry.outcome === "error" ? "\u001b[31m✗\u001b[0m" : MARK.false);
  const why = entry.why ? ` [${entry.why}]` : "";
  console.log(`${mark} "${entry.utterance}" → ${entry.outcome}${why}`);
  if (!ran && entry.detail) console.log(`     ${entry.detail}`);

  try {
    await appendFile(TRACE, JSON.stringify({ kind: "outcome", ...entry }) + "\n");
  } catch { /* never break on tracing */ }
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;

  if (req.method === "OPTIONS") {
    return send(res, originAllowed(origin) ? 204 : 403, {}, origin);
  }
  if (req.method !== "POST" || (req.url !== "/systemone" && req.url !== "/trace")) {
    return send(res, 404, { error: "not found" }, origin);
  }
  if (!originAllowed(origin)) {
    console.warn(`refused origin: ${origin ?? "(none)"}`);
    return send(res, 403, { error: "origin not allowed" }, origin);
  }

  let raw = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > MAX_BODY) {
      tooBig = true;
      req.destroy();
    }
  });

  req.on("end", async () => {
    if (tooBig) return send(res, 413, { error: "body too large" }, origin);

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "invalid JSON" }, origin);
    }

    // Outcome records from the extension: what happened AFTER the model answered.
    if (req.url === "/trace") {
      await recordOutcome(body);
      return send(res, 204, {}, origin);
    }

    const started = Date.now();
    try {
      const upstream = await fetch(API_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });

      const text = await upstream.text();
      const ms = Date.now() - started;

      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* upstream sent non-JSON */ }

      if (!upstream.ok) {
        console.error(`upstream ${upstream.status} in ${ms}ms: ${text.slice(0, 300)}`);
        return send(res, upstream.status, parsed ?? { error: text.slice(0, 500) }, origin);
      }

      await trace(body, parsed, ms);
      return send(res, 200, parsed ?? {}, origin);
    } catch (error) {
      console.error(`proxy error: ${error.message}`);
      const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
      return send(res, timedOut ? 504 : 502, { error: error.message }, origin);
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`jev proxy on http://127.0.0.1:${PORT}  ->  ${API_URL}`);
  console.log(ALLOWED_ID ? `pinned to extension ${ALLOWED_ID}` : "accepting any chrome-extension:// origin (dev)");
  console.log(`tracing every call to ${TRACE}`);
});
