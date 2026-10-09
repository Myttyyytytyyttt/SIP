// Proves a candidate SIP_SOLANA_PUBLIC_WS_URL the way a BROWSER will use it.
//
// WHY THIS EXISTS. On 2026-10-09 the live dashboard's push had never once
// opened in a browser: wss://api.mainnet-beta.solana.com answers the handshake
// with 403 whenever it carries an Origin header, which every page sends, and
// with 101 when it carries none, which is what a Node probe sends. The probe
// said "works" and every user got the poll. So this sends the site's Origin,
// subscribes the way lib/live-socket.ts does, pings the way it pings, and
// passes only if notifications keep arriving.
//
//   PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH" pnpm --filter @sip/web check:public-ws wss://solana-rpc.publicnode.com
//
// Exit 0 only when it opened, subscribed, heard notifications and stayed open
// for CHECK_WS_SECONDS (default 70, past the 60 s idle close seen on one host).
//
// Node 22's global WebSocket (undici) accepts a `headers` init; a browser
// sets Origin itself and refuses to let a page change it.

const url = process.argv[2] ?? "wss://solana-rpc.publicnode.com";
const origin = process.argv[3] ?? "https://sip-website-oficial.vercel.app";
const SECONDS = Number(process.env["CHECK_WS_SECONDS"] ?? 70);
/** A Raydium CLMM SOL/USDC pool (solana-core SOL_USDC_POOL): it changes every few seconds. */
const BUSY = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv";

type Init = { headers: Record<string, string> };
const Socket = WebSocket as unknown as new (url: string, init: Init) => WebSocket;

const started = Date.now();
const elapsed = (): string => ((Date.now() - started) / 1000).toFixed(1);
let opened = false;
let subscribed = false;
let notifications = 0;
let closed: string | null = null;

const socket = new Socket(url, { headers: { Origin: origin } });
socket.onopen = () => {
  opened = true;
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "accountSubscribe", params: [BUSY, { commitment: "confirmed", encoding: "base64" }] }));
  setInterval(() => socket.send(JSON.stringify({ jsonrpc: "2.0", method: "ping" })), 30_000);
};
socket.onmessage = (event) => {
  const body = JSON.parse(String(event.data)) as { id?: unknown; result?: unknown; method?: unknown };
  if (body.id === 1) subscribed = typeof body.result === "number";
  if (body.method === "accountNotification") notifications += 1;
};
socket.onclose = (event) => {
  closed = `code ${event.code} at ${elapsed()} s`;
};

setTimeout(() => {
  const ok = opened && subscribed && notifications > 0 && closed === null;
  console.log(JSON.stringify({ url, origin, seconds: SECONDS, opened, subscribed, notifications, closed, ok }));
  process.exit(ok ? 0 : 1);
}, SECONDS * 1000);
