// M4 — the session-engine spike: can a real degen wallet's realised profit be
// measured from chain history alone, defensibly?
//
// THE METHOD, ported from RH's cash-based settlement (SettlementExecutor's
// calculateRealizedProfit): profit = cashEnd − cashStart − deposits +
// withdrawals, in SOL. No per-token cost basis, no price oracle.
//
// THE COMPLETENESS ORACLE — what replaces quiet.ts. pre/postBalances are
// ABSOLUTE consensus metadata on every transaction. Ordered oldest→newest,
// the wallet's postBalance in tx N must equal its preBalance in tx N+1; any
// gap proves a transaction was missed (a wallet's lamports cannot change
// outside a transaction that lists it). getSignaturesForAddress returns every
// transaction listing the address, so for SOL CASH this is complete — the
// documented ATA blind spot afflicts token flows, not lamports, and it shows
// up here only as classification quality, never as a broken chain.
//
// Run:  npx tsx measure.ts --wallet <address> [--limit 60] [--rpc <url>]
//       npx tsx measure.ts --discover            (find an active trader first)
//
// This is a SPIKE: its output is a verdict about feasibility, not a keeper.

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) args.set(a, process.argv[i + 1]?.startsWith("--") === false ? process.argv[++i]! : "1");
}

const RPC = args.get("--rpc") ?? "https://api.mainnet-beta.solana.com";
const LIMIT = Number(args.get("--limit") ?? "60");
const QUIET_GAP_S = 30 * 60; // a 30-minute silence closes a session

const DEX: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "jupiter",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium-amm",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium-clmm",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "raydium-cpmm",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "orca",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "meteora-dlmm",
};
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
]);

let rpcCalls = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  rpcCalls++;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  }
}

const sol = (l: number | bigint): string => `${(Number(l) / 1e9).toFixed(4)}`;

async function discover(): Promise<string> {
  // A recent block, newest trader wins: fee payers of transactions that touch
  // a DEX program and have a real history behind them.
  const slot = await rpc("getSlot", [{ commitment: "finalized" }]);
  const block = await rpc("getBlock", [
    slot - 10,
    { maxSupportedTransactionVersion: 0, transactionDetails: "accounts", rewards: false },
  ]);
  for (const tx of block.transactions ?? []) {
    const keys: string[] = (tx.transaction.accountKeys ?? []).map((k: any) =>
      typeof k === "string" ? k : k.pubkey,
    );
    if (!keys.some((k) => DEX[k])) continue;
    const payer = keys[0]!;
    const sigs = await rpc("getSignaturesForAddress", [payer, { limit: 40 }]);
    if (sigs.length >= 30) return payer;
  }
  throw new Error("no active trader found in that block; rerun");
}

async function main() {
  const wallet = args.get("--wallet") ?? (await discover());
  console.log(`wallet ${wallet}\nrpc    ${RPC}\n`);

  const sigInfos = (await rpc("getSignaturesForAddress", [wallet, { limit: LIMIT }])) as {
    signature: string;
    err: unknown;
    blockTime: number;
  }[];
  sigInfos.reverse(); // oldest first

  interface Row {
    time: number;
    sig: string;
    pre: number;
    post: number;
    fee: number;
    feePayer: boolean;
    kind: string;
    failed: boolean;
  }
  const rows: Row[] = [];

  for (const info of sigInfos) {
    const tx = await rpc("getTransaction", [
      info.signature,
      { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "finalized" },
    ]);
    if (!tx) continue;
    const keys: { pubkey: string }[] = tx.transaction.message.accountKeys;
    const index = keys.findIndex((k) => k.pubkey === wallet);
    if (index < 0) continue;

    const programs = new Set<string>();
    for (const ix of tx.transaction.message.instructions) programs.add(ix.programId);
    for (const inner of tx.meta.innerInstructions ?? [])
      for (const ix of inner.instructions) programs.add(ix.programId);

    // Classification, most specific first. "other" is counted honestly.
    let kind = "other";
    const venue = [...programs].find((p) => DEX[p]);
    if (venue) kind = `trade:${DEX[venue]}`;
    else if ([...programs].every((p) => p === "11111111111111111111111111111111" || p === "ComputeBudget111111111111111111111111111111"))
      kind = "sol-transfer";
    else if ([...programs].some((p) => TOKEN_PROGRAMS.has(p))) kind = "token-ops";

    rows.push({
      time: info.blockTime,
      sig: info.signature,
      pre: tx.meta.preBalances[index],
      post: tx.meta.postBalances[index],
      fee: tx.meta.fee,
      feePayer: index === 0,
      kind,
      failed: info.err !== null,
    });
  }

  // ── the completeness oracle ────────────────────────────────────────────────
  let breaks = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.pre !== rows[i - 1]!.post) breaks++;
  }

  // ── sessions by quiet gaps, RH-style ───────────────────────────────────────
  interface Session {
    rows: Row[];
  }
  const sessions: Session[] = [];
  for (const row of rows) {
    const last = sessions[sessions.length - 1];
    if (!last || row.time - last.rows[last.rows.length - 1]!.time > QUIET_GAP_S) {
      sessions.push({ rows: [row] });
    } else last.rows.push(row);
  }

  console.log(`transactions read      ${rows.length} (of ${sigInfos.length} signatures, ${rpcCalls} RPC calls)`);
  console.log(`failed transactions    ${rows.filter((r) => r.failed).length}`);
  console.log(
    `balance-chain breaks   ${breaks}  ${breaks === 0 ? "← the completeness oracle HOLDS: no missed transaction" : "← MISSED transactions inside the window (or window truncation)"}`,
  );
  const byKind = new Map<string, number>();
  for (const row of rows) byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
  console.log(`classification         ${[...byKind].map(([k, n]) => `${k}=${n}`).join("  ")}\n`);

  console.log("sessions (30-min quiet gap):");
  for (const [i, s] of sessions.entries()) {
    const first = s.rows[0]!;
    const last = s.rows[s.rows.length - 1]!;
    const cashDelta = last.post - first.pre;
    // External flows: plain SOL transfers in this session. In > 0 is a
    // deposit; out is a withdrawal. RH's formula then isolates trading profit.
    let deposits = 0;
    let withdrawals = 0;
    for (const row of s.rows) {
      if (row.kind !== "sol-transfer") continue;
      const delta = row.post - row.pre;
      if (delta > 0) deposits += delta;
      else withdrawals += -delta;
    }
    const fees = s.rows.filter((r) => r.feePayer).reduce((a, r) => a + r.fee, 0);
    const profit = cashDelta - deposits + withdrawals;
    const mins = Math.max(1, Math.round((last.time - first.time) / 60));
    console.log(
      `  #${i + 1}  ${new Date(first.time * 1000).toISOString().slice(0, 16)}  ${String(mins).padStart(4)}min  ` +
        `${String(s.rows.length).padStart(3)}tx  cashΔ ${sol(cashDelta).padStart(9)}  dep ${sol(deposits).padStart(8)}  ` +
        `wd ${sol(withdrawals).padStart(8)}  fees ${sol(fees).padStart(7)}  ⇒ profit ${sol(profit).padStart(9)} SOL`,
    );
  }

  const other = byKind.get("other") ?? 0;
  console.log(
    `\nverdict: oracle ${breaks === 0 ? "HOLDS" : "BROKEN"}; ` +
      `${other}/${rows.length} transactions unclassified (their SOL deltas still count in cashΔ — ` +
      `classification affects only the deposit/withdrawal split).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
