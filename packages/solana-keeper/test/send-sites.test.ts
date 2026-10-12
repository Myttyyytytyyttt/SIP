// EVERY PLACE THE KEEPER PUTS A TRANSACTION ON THE WIRE, counted (ADR §4.3 L1d,
// the `send-sites` scan; §4.9 row 12).
//
// WHY A SOURCE SCAN. The explicit-send cut only closes the per-send gap if every
// crank transaction goes through src/explicit-send.ts when the token is on. A
// new `.rpc()` or `sendAndConfirm` added next month would compile, pass every
// test that does not happen to exercise it, and quietly send around the
// question — so the scan pins EVERY send primitive in src/ and bin/, by file
// and by count, and says which branch each one sits on.
//
// WHAT IS ALLOWED, AND WHY EACH.
//   * src/explicit-send.ts — the crank's explicit send: one sendRawTransaction,
//     after the question.
//   * src/invest-tick.ts — today's three Anchor sends (the wrap's `.rpc()` and
//     sendWithBudget's two `sendAndConfirm`), each on the branch that runs only
//     when no sender was handed in: with the token off they are today's path,
//     byte for byte; with it they are unreachable.
//   * src/settle-tick.ts — a LOCAL-keypair settle's sendRawTransaction
//     (localnet), and src/privy-signer.ts — a settle through Privy. Settles are
//     not crank transactions: settle_v2 is idempotent on chain (nonce and
//     frontier), the quiet period lets them through by design, and the
//     dispatcher's fence (P3) is where they meet the gate.
//   * src/privy-policy-cli.ts and src/privy-policy-client.ts — the owner's
//     policy CLI and its client: refused probes against the seat, never run by
//     the keeper process.
//
// WHAT THIS DOES NOT PROVE. The crank Keypair is still handed to runInvestTick,
// because today's branch needs it; moving the key itself behind the sender is
// the fenced sender's (ADR §3.6, P3), and so is a scan that no file but one
// holds it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const KEEPER = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|mts)$/.test(name)) out.push(full);
  }
  return out;
}

/** The file with its comments blanked (line structure kept), so a mention in prose is not a send. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, (_line, lead: string) => lead);
}

/** Every way to put a transaction on the wire that web3.js, Anchor or Privy offer. */
const PRIMITIVES = {
  sendRawTransaction: /\bsendRawTransaction\s*\(/g,
  sendAndConfirm: /\bsendAndConfirm\s*\(/g,
  sendAndConfirmTransaction: /\bsendAndConfirmTransaction\s*\(/g,
  sendAndConfirmRawTransaction: /\bsendAndConfirmRawTransaction\s*\(/g,
  sendTransaction: /\.sendTransaction\s*\(/g,
  rpc: /\.rpc\s*\(\s*\)/g,
  signAndSendTransaction: /\bsignAndSendTransaction\s*\(/g,
} as const;

const files = [...sources(resolve(KEEPER, "src")), ...sources(resolve(KEEPER, "bin"))];
const found = new Map<string, Record<string, number>>();
for (const file of files) {
  const text = code(readFileSync(file, "utf8"));
  for (const [name, pattern] of Object.entries(PRIMITIVES)) {
    const count = text.match(pattern)?.length ?? 0;
    if (count === 0) continue;
    const key = relative(KEEPER, file);
    found.set(key, { ...(found.get(key) ?? {}), [name]: count });
  }
}

describe("send-sites", () => {
  it("finds every send primitive in exactly the files and numbers the header names — nothing new sends around the sender", () => {
    expect(Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)))).toEqual({
      "src/explicit-send.ts": { sendRawTransaction: 1 },
      "src/invest-tick.ts": { sendAndConfirm: 2, rpc: 1 },
      "src/privy-policy-cli.ts": { signAndSendTransaction: 3 },
      "src/privy-policy-client.ts": { signAndSendTransaction: 2 },
      "src/privy-signer.ts": { signAndSendTransaction: 1 },
      "src/settle-tick.ts": { sendRawTransaction: 1 },
    });
  });

  const tick = code(readFileSync(resolve(KEEPER, "src/invest-tick.ts"), "utf8"));
  const sender = code(readFileSync(resolve(KEEPER, "src/explicit-send.ts"), "utf8"));

  it("puts the wrap's `.rpc()` on the branch that runs only when no sender was handed in", () => {
    const rpcAt = tick.indexOf(".rpc()");
    const guardAt = tick.lastIndexOf("if (deps.sender === undefined) {", rpcAt);
    expect(guardAt).toBeGreaterThan(-1);
    // Nothing between the guard and the call closes or flips the branch.
    expect(tick.slice(guardAt, rpcAt)).not.toMatch(/\}\s*else\b/);
    // And the other branch hands the same call's transaction to the sender.
    expect(tick.slice(rpcAt, rpcAt + 800)).toContain("await deps.sender.sendLegacy(transaction, [crank]);");
  });

  it("returns through the sender before either of sendWithBudget's Anchor sends can be reached", () => {
    const body = tick.slice(tick.indexOf("export async function sendWithBudget("), tick.indexOf("/** One token account a turn may need"));
    const legacyAnchor = body.indexOf("return provider.sendAndConfirm(new Transaction().add(...budgeted), [crank]);");
    const legacyGuard = body.indexOf("if (sender !== undefined) return sender.sendLegacy(new Transaction().add(...budgeted), [crank]);");
    expect(legacyGuard).toBeGreaterThan(-1);
    expect(legacyGuard).toBeLessThan(legacyAnchor);
    const v0Anchor = body.indexOf("return provider.sendAndConfirm(transaction, [crank]);");
    const v0Guard = body.indexOf("return sender.sendVersioned(");
    expect(v0Guard).toBeGreaterThan(-1);
    expect(v0Guard).toBeLessThan(v0Anchor);
  });

  it("hands the sender to BOTH of sendWithBudget's callers — the convert and every leg", () => {
    expect(tick.match(/await tables\.tablesFor\(lookupTablesOf\(route\)\), deps\.sender\);/g)).toHaveLength(2);
  });

  it("asks the question before the sender's one send, never after", () => {
    const send = sender.slice(sender.indexOf("async #sendSigned("));
    expect(send.indexOf("this.#ask();")).toBeGreaterThan(-1);
    expect(send.indexOf("this.#ask();")).toBeLessThan(send.indexOf("sendRawTransaction("));
  });
});

// ── a worker's sends: A1, "every send passes the gate" (ADR §4.4, S-8) ────────
//
// The scan above says no file sends around the two seams. These say a worker
// never hands either seam out WITHOUT its fence: every CrankSender a job builds
// carries the job's gate, and every settle turn it runs carries the job's
// settle fence. Production's legacy keeper builds neither (bin/keeper.mts never
// imports the fence; test/dispatch-dark.test.ts).
describe("send-sites: a worker job never sends around its fence", () => {
  const job = code(readFileSync(resolve(KEEPER, "src/worker-job.ts"), "utf8"));
  const worker = code(readFileSync(resolve(KEEPER, "bin/worker.mts"), "utf8"));

  it("builds exactly one CrankSender, and it carries the job's gate", () => {
    const built = [...job.matchAll(/new CrankSender\(\{([\s\S]*?)\}\);/g)].map((match) => match[1]!);
    expect(built).toHaveLength(1);
    expect(built[0]).toContain("gate: fence.crankGate()");
    expect(worker).not.toMatch(/new CrankSender\(/);
  });

  it("runs every settle with the job's fence, and the invest only with the fenced sender or none", () => {
    const settles = [...job.matchAll(/result = await settle\(\{([\s\S]*?)\n {6}\}\);/g)].map((match) => match[1]!);
    expect(settles).toHaveLength(1);
    expect(settles[0]).toContain("fence: fence.settleFence(),");
    const invests = [...job.matchAll(/await invest\(\{([\s\S]*?)\n {6}\}\);/g)].map((match) => match[1]!);
    expect(invests).toHaveLength(1);
    expect(invests[0]).toContain("...(sender === undefined ? {} : { sender }),");
    expect(invests[0]).not.toMatch(/sender: (?!.*sender \})/);
  });
});
