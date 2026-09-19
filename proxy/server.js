// Local proxy for the TypeSafe API.
//
// The extension never sees TYPESAFE_API_KEY. It posts a request body here and
// this process adds the Authorization header. Bound to 127.0.0.1 only.
//
//   node --env-file=../.env server.js

import { createServer } from "node:http";

const PORT = Number(process.env.JEV_PROXY_PORT ?? 8787);
const API_URL = `${process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai"}/v1/systemone`;
const API_KEY = process.env.TYPESAFE_API_KEY;
const MAX_BODY = 2 * 1024 * 1024;

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

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;

  if (req.method === "OPTIONS") {
    return send(res, originAllowed(origin) ? 204 : 403, {}, origin);
  }
  if (req.method !== "POST" || req.url !== "/systemone") {
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

      const q = Object.keys(body?.questions ?? {}).length;
      const used = parsed?.usage?.input_tokens ?? "?";
      console.log(`ok ${ms}ms  ${q} questions  ${used} input tokens`);

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
});
