#!/usr/bin/env node
// Counting JSON-RPC proxy for the dispatcher census (M1).
//
// LOOPBACK ONLY. Forwards Solana JSON-RPC to the PUBLIC endpoint and logs one
// JSONL line per JSON-RPC call (a batch is logged element by element).
//
//   node proxy.mjs --port 28911 --log calls.jsonl [--bodies bodies.jsonl] [--upstream https://api.mainnet-beta.solana.com]
//
// The path is a free-form run tag: http://127.0.0.1:28911/run/profit logs run:"profit".
//
// REFUSED, never forwarded: any method starting with "send" (sendTransaction,
// sendRawTransaction, sendBundle, ...) and requestAirdrop. They get a JSON-RPC
// error answer and a log line with refused:true.
// FORWARDED BUT FLAGGED: simulateTransaction (read-only), logged with simulate:true.
// WEBSOCKETS: every upgrade is refused (socket destroyed after a 403) and logged,
// on this port and on port+1 (the port @solana/web3.js derives for an http URL).
//
// A 429 or 5xx from the public node is retried here, up to 4 more times with
// backoff, so that public-node throttling does not cut a keeper turn short and
// distort the count. Each keeper-level call is still ONE line; upstreamAttempts
// says how many upstream requests it took.
//
// GET /__census on the same port answers {inFlight, lastRequestAt, total} for the runner.

import http from "node:http";
import fs from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith("--") ? [...acc, [cur.slice(2), all[i + 1]]] : acc), []),
);
const PORT = Number(args.port ?? 28911);
const UPSTREAM = args.upstream ?? "https://api.mainnet-beta.solana.com";
const LOG = args.log ?? "calls.jsonl";
const BODIES = args.bodies ?? null;
const HOST = "127.0.0.1";

if (!/^https:\/\/api\.mainnet-beta\.solana\.com\/?$/.test(UPSTREAM)) {
  console.error("refusing: this census proxy only forwards to the public https://api.mainnet-beta.solana.com");
  process.exit(2);
}

const logStream = fs.createWriteStream(LOG, { flags: "a" });
const bodyStream = BODIES === null ? null : fs.createWriteStream(BODIES, { flags: "a" });
const write = (obj) => logStream.write(JSON.stringify(obj) + "\n");

const REFUSED = (method) => typeof method === "string" && (method.startsWith("send") || method === "requestAirdrop");
// Response bodies kept for attribution: small, and they name the links and vaults.
const KEEP_BODY = new Set(["getProgramAccounts", "getMultipleAccounts"]);

let inFlight = 0;
let lastRequestAt = 0;
let total = 0;
let seq = 0;

/** The first positional param, when it is a string (pubkey or signature), else a short shape. */
function firstParamOf(params) {
  if (!Array.isArray(params) || params.length === 0) return null;
  const p = params[0];
  if (typeof p === "string") return p;
  if (Array.isArray(p)) return p.length > 0 && typeof p[0] === "string" ? p[0] : `[array:${p.length}]`;
  if (p !== null && typeof p === "object") return "{object}";
  return String(p);
}

/** What else about the call is worth keeping, without echoing transactions. */
function detailOf(method, params) {
  if (!Array.isArray(params)) return undefined;
  const d = {};
  const cfg = params.find((p, i) => i > 0 && p !== null && typeof p === "object" && !Array.isArray(p));
  if (cfg?.commitment) d.commitment = cfg.commitment;
  if (typeof params[0] === "string" && ["finalized", "confirmed", "processed"].includes(params[0])) d.commitment = params[0];
  if (params[0] !== null && typeof params[0] === "object" && !Array.isArray(params[0]) && params[0].commitment) d.commitment = params[0].commitment;
  switch (method) {
    case "getMultipleAccounts":
      d.keys = Array.isArray(params[0]) ? params[0] : null;
      break;
    case "getSignaturesForAddress":
      if (cfg?.limit !== undefined) d.limit = cfg.limit;
      if (cfg?.before !== undefined) d.before = cfg.before;
      if (cfg?.until !== undefined) d.until = cfg.until;
      break;
    case "getProgramAccounts":
      if (cfg?.filters) d.filters = cfg.filters;
      if (cfg?.encoding) d.encoding = cfg.encoding;
      break;
    case "getTransaction":
      if (cfg?.maxSupportedTransactionVersion !== undefined) d.maxVersion = cfg.maxSupportedTransactionVersion;
      break;
    case "getMinimumBalanceForRentExemption":
      d.size = params[0];
      break;
    case "getFeeForMessage":
      d.messageChars = typeof params[0] === "string" ? params[0].length : null;
      break;
    case "simulateTransaction":
      d.txChars = typeof params[0] === "string" ? params[0].length : null;
      break;
    default:
      break;
  }
  return Object.keys(d).length === 0 ? undefined : d;
}

/** A compact look at the answer: how many items, whether null, the error code. */
function resultShapeOf(method, item) {
  if (item === undefined || item === null) return { missing: true };
  if (item.error) return { rpcError: item.error.code ?? true, rpcMessage: String(item.error.message ?? "").slice(0, 160) };
  const r = item.result;
  if (r === null) return { result: "null" };
  if (Array.isArray(r)) return { items: r.length };
  if (r && typeof r === "object" && "value" in r) {
    const v = r.value;
    if (Array.isArray(v)) return { items: v.length, nonNull: v.filter((x) => x !== null).length };
    return { value: v === null ? "null" : typeof v };
  }
  return { result: typeof r };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function forward(bodyText) {
  const backoff = [1000, 2000, 4000, 8000];
  let attempts = 0;
  let last = null;
  for (let i = 0; i <= backoff.length; i++) {
    attempts += 1;
    try {
      const res = await fetch(UPSTREAM, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
        signal: AbortSignal.timeout(28_000),
      });
      const text = await res.text();
      last = { status: res.status, text, wire: res.headers.get("content-length"), attempts };
      if (res.status === 429 || res.status >= 500) {
        if (i < backoff.length) {
          await sleep(backoff[i]);
          continue;
        }
      }
      return last;
    } catch (error) {
      last = { status: 599, text: JSON.stringify({ error: String(error?.name ?? "error") }), wire: null, attempts, transport: String(error?.name) };
      if (i < backoff.length) {
        await sleep(backoff[i]);
        continue;
      }
      return last;
    }
  }
  return last;
}

function refuseUpgrade(where) {
  return (req, socket) => {
    write({ ts: Date.now(), kind: "websocket-upgrade-refused", where, path: req.url, refused: true });
    try {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    } catch {}
    socket.destroy();
  };
}

const server = http.createServer(async (req, res) => {
  const runMatch = /^\/run\/([A-Za-z0-9_-]+)/.exec(req.url ?? "");
  const run = runMatch ? runMatch[1] : null;

  if (req.method === "GET" && req.url === "/__census") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ inFlight, lastRequestAt, total }));
    return;
  }
  if (req.method !== "POST") {
    write({ ts: Date.now(), kind: "non-post", method: req.method, path: req.url, run });
    res.writeHead(405);
    res.end();
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const start = Date.now();
  inFlight += 1;
  lastRequestAt = start;
  const reqId = ++seq;

  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    inFlight -= 1;
    write({ ts: start, kind: "unparseable", reqBytes: raw.length, run });
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error (census proxy)" } }));
    return;
  }

  const isBatch = Array.isArray(parsed);
  const items = isBatch ? parsed : [parsed];
  const refusedIdx = new Set();
  items.forEach((item, i) => {
    if (REFUSED(item?.method)) refusedIdx.add(i);
  });
  const forwardItems = items.filter((_, i) => !refusedIdx.has(i));

  let upstream = null;
  let answers = new Map(); // id -> answer item
  if (forwardItems.length > 0) {
    const bodyText = isBatch ? JSON.stringify(forwardItems) : JSON.stringify(forwardItems[0]);
    upstream = await forward(bodyText);
    try {
      const out = JSON.parse(upstream.text);
      for (const a of Array.isArray(out) ? out : [out]) answers.set(JSON.stringify(a?.id ?? null), a);
    } catch {
      answers = null; // non-JSON answer (e.g. an HTML 429 page after retries)
    }
  }
  const end = Date.now();
  inFlight -= 1;
  total += items.length;

  // The reply to the keeper, in request order.
  const replyItems = items.map((item, i) => {
    if (refusedIdx.has(i)) {
      return { jsonrpc: "2.0", id: item?.id ?? null, error: { code: -32601, message: `census proxy refuses ${item?.method}: this measurement never sends` } };
    }
    return answers?.get(JSON.stringify(item?.id ?? null)) ?? null;
  });

  const respPerItem = replyItems.map((a) => (a === null ? 0 : Buffer.byteLength(JSON.stringify(a))));
  items.forEach((item, i) => {
    const method = item?.method ?? null;
    const line = {
      ts: start,
      end,
      reqId,
      run,
      method,
      firstParam: firstParamOf(item?.params),
      detail: detailOf(method, item?.params),
      reqBytes: isBatch ? Buffer.byteLength(JSON.stringify(item)) : raw.length,
      respBytes: respPerItem[i],
      latencyMs: end - start,
      status: refusedIdx.has(i) ? "refused" : (upstream?.status ?? null),
      ...(isBatch ? { batch: { size: items.length, index: i } } : {}),
      ...(refusedIdx.has(i) ? { refused: true } : {}),
      ...(method === "simulateTransaction" ? { simulate: true } : {}),
      ...(upstream && !refusedIdx.has(i) ? { upstreamAttempts: upstream.attempts, wireBytes: upstream.wire === null ? null : Number(upstream.wire) } : {}),
      ...(refusedIdx.has(i) ? {} : resultShapeOf(method, replyItems[i])),
    };
    write(line);
    if (bodyStream !== null && KEEP_BODY.has(method) && replyItems[i] !== null && !refusedIdx.has(i)) {
      bodyStream.write(JSON.stringify({ ts: start, reqId, run, method, params: item?.params, answer: replyItems[i] }) + "\n");
    }
  });

  if (!isBatch && answers === null && upstream !== null) {
    // Pass the upstream failure through untouched, so the keeper's pool sees what it would see.
    res.writeHead(upstream.status, { "content-type": "text/plain" });
    res.end(upstream.text);
    return;
  }
  const body = JSON.stringify(isBatch ? replyItems : replyItems[0]);
  // The upstream HTTP status is passed through (a non-2xx makes the keeper's pool fail over, as it would).
  res.writeHead(upstream === null ? 200 : upstream.status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
});

server.on("upgrade", refuseUpgrade("rpc-port"));
server.listen(PORT, HOST, () => {
  write({ ts: Date.now(), kind: "proxy-start", port: PORT, wsPort: PORT + 1, upstream: UPSTREAM });
  console.log(`census proxy on http://${HOST}:${PORT} -> ${UPSTREAM}; log ${LOG}`);
});

// The port @solana/web3.js derives for an http endpoint's websocket (port + 1).
const wsServer = http.createServer((req, res) => {
  write({ ts: Date.now(), kind: "ws-port-http", path: req.url, refused: true });
  res.writeHead(403);
  res.end();
});
wsServer.on("upgrade", refuseUpgrade("ws-port"));
wsServer.listen(PORT + 1, HOST);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    write({ ts: Date.now(), kind: "proxy-stop", total });
    logStream.end(() => process.exit(0));
  });
}
