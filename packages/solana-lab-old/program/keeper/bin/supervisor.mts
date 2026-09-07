#!/usr/bin/env node
// The Solana supervisor: one process, every linked wallet, in a loop.
//
// This is what turns the drill into a product. The drill was one wallet, one
// session, one command, run by hand. This discovers every TradingLink on the
// program, measures each wallet's unsettled span, attests, settles, and invests
// what accumulated — forever, without anyone typing anything.
//
// WHO — from the chain. Every link is a PDA, so getProgramAccounts returns the
// complete current set. No user table, nothing to migrate, and no log watermark
// that can silently step over a user (the EVM supervisor's documented hazard).
//
// SAFETY, ported unchanged in spirit from keeper-supervisor.mts:
//   * DRY RUN BY DEFAULT. --broadcast plus the exact sentinel, byte for byte.
//   * ONE CYCLE AT A TIME. An overrunning cycle is skipped, never stacked.
//   * A FAILURE IS CONTAINED PER WALLET; one bad link never ends the sweep.
//   * NOTHING UNPROVEN MOVES MONEY. A broken balance chain refuses to attest.
//
// WHAT IT STILL IS NOT: settle() is pushed BY the trading wallet, so the keeper
// needs that wallet's signature. In production that is a Privy session signer;
// here it is a local keypair per wallet under .local/signers/. Until the Privy
// path is wired, a wallet with no local signer is reported and skipped rather
// than silently ignored.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { discoverLinks, type ManagedLink } from "../src/discovery";
import { isExternalFlowTx } from "../src/measure-window";
import { runSettleTick } from "../src/settle-tick";
import { runInvestTick } from "../src/invest-tick";
import { createAlerter } from "../src/alerts";
import { SupervisorClaim } from "../src/singleton";
import { buildPrivySolanaIndex, createPrivySolanaSigner, type PrivyWalletEntry, type SolanaWalletSubmitter } from "../src/privy-signer";
import { SolanaReadModel } from "../src/read-model";
import { keeperRpcUrls, poolFetch } from "../src/rpc-pool";

// The key quorum id the web registers on each trading wallet (addSigners).
// Optional: with it, "wallet never granted our signer" is reported as its own
// fact instead of surfacing later as a refused Privy submit.
const expectedSignerId = process.env.NUVEM_SOLANA_SIGNER_ID?.trim() || undefined;

const LOCAL = join(import.meta.dirname, "../../scripts/.local");
const SIGNERS = join(LOCAL, "signers");
const SENTINEL = "i-understand-this-moves-real-funds";

// The flag or NUVEM_SOLANA_BROADCAST=1 — on Railway the start command lives in
// the image, so going live must be a VARIABLE flip, not an image rebuild. The
// sentinel below is still required either way; the env var alone refuses too.
const broadcast = process.argv.includes("--broadcast") || process.env.NUVEM_SOLANA_BROADCAST === "1";
if (broadcast && process.env.NUVEM_SOLANA_ALLOW_BROADCAST !== SENTINEL) {
  const got = process.env.NUVEM_SOLANA_ALLOW_BROADCAST;
  const why =
    got === undefined ? "It is not set at all."
    : got.trim() === SENTINEL ? `It matches except for surrounding whitespace (${got.length} chars).`
    : got.trim().toLowerCase() === SENTINEL ? "It matches except for capitalisation; the check is case sensitive."
    : `It holds ${got.length} characters that are not the sentinel.`;
  console.error(`--broadcast requires NUVEM_SOLANA_ALLOW_BROADCAST="${SENTINEL}". ${why} Refusing to start.`);
  process.exit(2);
}

// The IDL is read EXPLICITLY, not via anchor.workspace: the workspace needs
// Anchor.toml at cwd plus env conventions, none of which exist in a container.
// target/idl/nuvem_vault.json is COMMITTED because it describes the one fixed
// program this keeper talks to on mainnet — pinned metadata, not a build
// artifact that varies (see .gitignore).
const IDL_PATH = join(import.meta.dirname, "../../target/idl/nuvem_vault.json");
if (!existsSync(IDL_PATH)) {
  console.error(`No IDL at ${IDL_PATH}. It is committed; a checkout without it is broken.`);
  process.exit(2);
}
const idl = JSON.parse(readFileSync(IDL_PATH, "utf8")) as anchor.Idl;

// --preflight: prove the module graph and the IDL load in THIS image, with no
// network, no keys, no env. The Docker build runs it so a broken image fails
// at build time, not at 3am on Railway.
if (process.argv.includes("--preflight")) {
  // The anti-laundering invariant, checked at BUILD time: a transaction that
  // carries any trading program is trading, even bundled with a settle. If
  // this regresses, the image does not build.
  const NUVEM = (idl as { address?: string }).address ?? "";
  const ED = "Ed25519SigVerify111111111111111111111111111";
  const SYS = "11111111111111111111111111111111";
  const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
  const invariants: [string, boolean, boolean][] = [
    ["real settle is flow", isExternalFlowTx([ED, NUVEM, SYS], NUVEM), true],
    ["pure deposit is flow", isExternalFlowTx([SYS], NUVEM), true],
    ["clean trade is trading", isExternalFlowTx([JUP, SYS], NUVEM), false],
    ["settle+trade bundle is trading", isExternalFlowTx([NUVEM, JUP, SYS], NUVEM), false],
  ];
  for (const [name, got, want] of invariants) {
    if (got !== want) {
      console.error(`PREFLIGHT FAILED: classification invariant "${name}" is ${got}, expected ${want}.`);
      process.exit(1);
    }
  }
  console.log(JSON.stringify({ preflight: "ok", program: NUVEM, invariants: invariants.length }));
  process.exit(0);
}

// AT LEAST ONE OPERATOR ENDPOINT IS STILL REQUIRED. keeperRpcUrls always appends
// the public endpoint, so without this check a keeper with no configuration at
// all would come up quietly running on a throttled public node — degraded, and
// looking healthy. A missing endpoint must stay loud.
if (!process.env.NUVEM_SOLANA_MAINNET_RPC?.trim() && !process.env.NUVEM_SOLANA_RPC_URL?.trim() && !process.env.ANCHOR_PROVIDER_URL?.trim()) {
  console.error("No Solana endpoint: set NUVEM_SOLANA_MAINNET_RPC (or NUVEM_SOLANA_RPC_URL).");
  process.exit(2);
}
const rpcUrls = keeperRpcUrls(process.env);
const sweepMs = Number(process.env.NUVEM_SOLANA_SWEEP_MS ?? "60000");

/** A Solana secret key from an env var holding the id.json-style JSON array. */
function keypairFromEnv(name: string): Keypair | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
  } catch {
    console.error(`${name} is set but is not a JSON array secret key (the contents of an id.json).`);
    process.exit(2);
  }
}

/**
 * A secret key from a FILE, with the same discipline: on a malformed file the
 * error names the PATH and nothing else. A bare JSON.parse here would let V8's
 * SyntaxError embed the file's own bytes in the message — key material, headed
 * for a log line.
 */
function keypairFromFile(path: string): Keypair {
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
  } catch {
    console.error(`${path} exists but is not a JSON array secret key (an id.json). Not echoing its contents.`);
    process.exit(2);
  }
}

// Privy credentials — when present, the keeper signs settle AS THE WALLET
// server-side and needs NO local per-wallet keys. Absent, it falls back to
// local keypairs under .local/signers/ (the drill path).
const privyConfig =
  process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET &&
  (process.env.PRIVY_AUTHORIZATION_KEY ?? process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY)
    ? {
        appId: process.env.PRIVY_APP_ID,
        appSecret: process.env.PRIVY_APP_SECRET,
        authorizationKey: (process.env.PRIVY_AUTHORIZATION_KEY ?? process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY)!,
      }
    : null;

// The crank pays invest-tick fees. On Railway it arrives as an env var; on a
// dev machine the solana CLI's id.json keeps working as before. Neither path
// ever holds a USER's key — trading wallets are Privy's, the vault is a PDA.
const crankFromEnv = keypairFromEnv("NUVEM_SOLANA_CRANK_KEY");
let crank: Keypair;
if (crankFromEnv !== null) {
  crank = crankFromEnv;
} else {
  const walletPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  if (!existsSync(walletPath)) {
    console.error(
      `No crank key: NUVEM_SOLANA_CRANK_KEY is not set and ${walletPath} does not exist. ` +
        "Set the env var (the JSON array from an id.json) — that is the Railway path.",
    );
    process.exit(2);
  }
  crank = keypairFromFile(walletPath);
}

// PRINTED, BECAUSE THE CHAIN NOW HAS TO BE TOLD WHO THIS IS. Since the crank
// authorization landed, wrap_sol/convert/invest refuse every signer except the
// vault's owner and the pubkey named in ProtocolConfig.keeper — so this exact
// value is what an operator must pass to `mainnet.sh set-keeper`. It lived only
// inside NUVEM_SOLANA_CRANK_KEY, a secret, which made the one thing needed to
// authorize the keeper the one thing nobody could safely look up. A PUBLIC key
// in a log is not a leak; not having it is an outage.
console.log(`crank (pass this to \`mainnet.sh set-keeper\`): ${crank.publicKey.toBase58()}`);

// FAILOVER UNDER THE TRANSPORT, not around each call. Connection threads one
// endpoint through everything it does; replacing its `fetch` gives Anchor, the
// settle path and the invest path the same failover without a line of their own.
console.log(`solana endpoints: ${rpcUrls.length} (falling back in order, public last)`);
const connection = new Connection(rpcUrls[0] as string, {
  commitment: "confirmed",
  fetch: poolFetch(rpcUrls, (message, fields) => console.warn(`! ${message} ${JSON.stringify(fields)}`)),
});
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(crank), {
  commitment: "confirmed",
});
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

// The attester: the keeper's trust anchor, and it MUST be the one the on-chain
// config names or every attestation is refused by WrongAttester.
const attesterFromEnv = keypairFromEnv("NUVEM_SOLANA_ATTESTER_KEY");
const attesterPath = join(LOCAL, "attester.json");
let attester: Keypair;
if (attesterFromEnv !== null) {
  attester = attesterFromEnv;
} else if (existsSync(attesterPath)) {
  attester = keypairFromFile(attesterPath);
} else {
  console.error(
    `No attester key: NUVEM_SOLANA_ATTESTER_KEY is not set and ${attesterPath} does not exist. ` +
      "It must be the key init_config was run with, or every attestation is refused on chain.",
  );
  process.exit(2);
}

/** Per-wallet signers, keyed by the wallet's own address. */
function loadSigners(): Map<string, Keypair> {
  const map = new Map<string, Keypair>();
  mkdirSync(SIGNERS, { recursive: true });
  for (const file of readdirSync(SIGNERS)) {
    if (!file.endsWith(".json")) continue;
    try {
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(SIGNERS, file), "utf8"))));
      map.set(kp.publicKey.toBase58(), kp);
    } catch {
      // Skip and NAME THE FILE only — a parse error's message can carry the
      // file's own bytes, and these files are secret keys.
      console.error(`signer file ${file} is not a JSON array secret key; skipped.`);
    }
  }
  return map;
}

/**
 * The pool registry: MINT=POOL pairs, comma separated.
 *
 * MALFORMED ENTRIES ARE REFUSED AT STARTUP, not skipped. Silently dropping one
 * meant an operator who fat-fingered a mint saw a keeper that started cleanly
 * and then refused that leg forever with "no pool configured" — a message that
 * points at the policy rather than at the typo that caused it. A registry that
 * cannot be parsed is a configuration error, and the process says which entry
 * and stops.
 *
 * The pool ADDRESS itself is not validated beyond being a pubkey, and cannot
 * usefully be: what protects the vault is not this list but invest(), which
 * pins the venue PROGRAM from the owner-signed policy and then measures the
 * spend and the fill against the vault's own accounts. A wrong pool here
 * produces a failed or underfilled swap, never a drained vault.
 */
function loadPools(): Map<string, PublicKey> {
  const raw = process.env.NUVEM_SOLANA_POOLS ?? "";
  const map = new Map<string, PublicKey>();
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [mint, pool] = entry.split("=");
    if (!mint || !pool) {
      console.error(`NUVEM_SOLANA_POOLS entry "${entry.slice(0, 40)}" is not MINT=POOL. Refusing to start.`);
      process.exit(2);
    }
    let key: PublicKey;
    let value: PublicKey;
    try {
      key = new PublicKey(mint.trim());
      value = new PublicKey(pool.trim());
    } catch {
      console.error(`NUVEM_SOLANA_POOLS entry "${entry.slice(0, 40)}" has a non-base58 address. Refusing to start.`);
      process.exit(2);
    }
    if (map.has(key.toBase58())) {
      console.error(`NUVEM_SOLANA_POOLS lists ${key.toBase58()} twice. Refusing to start rather than pick one.`);
      process.exit(2);
    }
    map.set(key.toBase58(), value);
  }
  return map;
}

const TRADING_LINK_DISC = createHash("sha256").update("account:TradingLink").digest().subarray(0, 8);
const pools = loadPools();
const log = (msg: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: "nuvem-solana-supervisor", msg, ...fields }));

// History for the website. Absent DATABASE_URL it is a no-op; a write failure
// is a warning and never touches the settlement path. See src/read-model.ts.
const readModel = SolanaReadModel.create(
  process.env.DATABASE_URL ?? process.env.NUVEM_KEEPER_DATABASE_URL,
  (msg, fields) => log(msg, fields ?? {}),
);

/**
 * WAKING SOMEONE WHEN SAVINGS STOP.
 *
 * Every failure this keeper has actually had looked healthy from outside: a
 * wallet that never granted its signer, an RPC quietly throttling, a mirror
 * hanging with /health green. The symptom was always an ABSENCE — money that
 * did not arrive — and nothing reported absences to anyone.
 *
 * Conditions fire ONCE and stay quiet until they clear, because an alert that
 * repeats every 60 seconds is an alert that gets muted. Without a webhook they
 * still reach the log, so an unconfigured deployment is quieter but not blind.
 */
const alerter = createAlerter({
  webhookUrl: process.env.NUVEM_SOLANA_ALERT_WEBHOOK ?? process.env.NUVEM_ALERT_WEBHOOK,
  log: (severity, line) => log(`alert ${severity}`, { detail: line }),
});

let cycleRunning = false;

/**
 * Per-key dedupe for the sweep's per-wallet lines. A supervisor that repeats
 * "no signer for 4T52…" every 60 seconds forever teaches the operator to stop
 * reading its logs — the one habit an operator of a keeper cannot afford. A
 * line is emitted when its CONTENT changes for its key (including changing
 * BACK), so state transitions always surface and steady state is silent.
 * Restarts clear it: after a deploy the first sweep narrates everything once.
 */
const lastLine = new Map<string, string>();
function logChange(key: string, msg: string, fields: Record<string, unknown> = {}): void {
  const line = `${msg}|${JSON.stringify(fields)}`;
  if (lastLine.get(key) === line) return;
  lastLine.set(key, line);
  log(msg, fields);
}

/**
 * What /status serves. The point, inherited from the EVM keeper's heartbeat:
 * an operator must be able to tell a HALTED keeper from a WEDGED one without
 * ssh. `lastSweepAt` moving = alive; an old timestamp with the process up =
 * wedged; the numbers say what the last sweep actually saw.
 */
const health = {
  service: "nuvem-solana-supervisor",
  startedAt: new Date().toISOString(),
  // Set once the singleton claim is resolved below — a supervisor that does
  // not hold it runs dry regardless of how it was armed, and /status must say
  // which of the two it is.
  mode: "starting",
  sweeps: 0,
  lastSweepAt: null as string | null,
  lastSweepLinks: null as number | null,
  lastSweepError: null as string | null,
  /** The crank's balance, so an operator sees it emptying before it stops. */
  crankLamports: null as string | null,
  /**
   * The latest per-wallet outcome, keyed by wallet. This is where a deduped
   * resting state stays VISIBLE: a wallet stuck INCOMPLETE or NO_SIGNER logs
   * once and then goes quiet, but /status always shows its current condition,
   * so "one log line an hour ago" never means "silently halted".
   */
  wallets: {} as Record<
    string,
    { settle: string; invest: string; signing: string; detail: string; at: string }
  >,
};

async function sweep(): Promise<void> {
  if (cycleRunning) {
    log("cycle skipped: the previous one is still running");
    return;
  }
  cycleRunning = true;
  try {
    // The handover: the instance meant to be acting takes over as soon as the
    // outgoing one lets go, instead of waiting for a human to notice.
    await claim.ensure();
    if (broadcast && !claim.held) {
      alerter.fire({
        key: "not-acting",
        severity: "warn",
        title: "Armed, but another supervisor holds the claim",
        detail: "This instance is sweeping in dry run. If no other instance is running, its lock is stale.",
      });
    }
    const links = await discoverLinks(connection, program.programId, TRADING_LINK_DISC);
    const signers = loadSigners();

    // ONE Privy scan for the whole sweep. Resolving per wallet made N full
    // paginated scans for N linked wallets — fine for one tester, rate-limiting
    // for anyone trading a bundle. A failure here is not fatal: each wallet
    // falls back to its own lookup, and a local keypair still works.
    let privyIndex: ReadonlyMap<string, PrivyWalletEntry> | undefined;
    if (privyConfig !== null) {
      try {
        privyIndex = await buildPrivySolanaIndex(privyConfig);
      } catch (error) {
        log("privy wallet index failed; falling back to per-wallet lookups", {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // THE CRANK PAYS FOR EVERY MOVE and nothing was watching it. It funds each
    // wrap, convert and invest, plus the rent for three token accounts per
    // vault. Empty, every invest turn fails for every vault at once, in a loop,
    // with /health still green — the exact silent stop this whole file exists
    // to prevent. Checked once per sweep, reported in /status, and warned about
    // BEFORE it bites rather than after.
    try {
      const crankLamports = await connection.getBalance(crank.publicKey, "confirmed");
      health.crankLamports = String(crankLamports);
      if (crankLamports < 20_000_000) {
        logChange(
          "crank-balance",
          "crank is running low — investing stops when it empties",
          { crank: crank.publicKey.toBase58(), lamports: crankLamports },
        );
        alerter.fire({
          key: "crank-low",
          severity: crankLamports < 5_000_000 ? "critical" : "warn",
          title: "The keeper's crank is running out of SOL",
          detail: `${crankLamports} lamports left; investing stops for every vault when it empties`,
          context: { crank: crank.publicKey.toBase58() },
        });
      } else {
        lastLine.delete("crank-balance");
        alerter.clear("crank-low");
      }
    } catch {
      health.crankLamports = null;
    }

    health.sweeps += 1;
    health.lastSweepAt = new Date().toISOString();
    health.lastSweepLinks = links.length;
    health.lastSweepError = null;
    alerter.clear("sweep-failed");
    const signingRoutes = new Map<string, string>();
    log("sweep", { links: links.length, localKeypairs: signers.size, mode: isLive() ? "live" : "dry-run" });

    for (const link of links) {
      const wallet = link.wallet.toBase58();
      try {
        // Prefer Privy (no local key); fall back to a local keypair if present.
        // A resolution FAILURE is logged with its real reason and falls back —
        // the first version caught everything to null, which dressed a missing
        // SDK method up as "the user granted no signer".
        let walletSigner: SolanaWalletSubmitter | Keypair | null = signers.get(wallet) ?? null;
        // WHICH ROUTE CAN SIGN FOR THIS WALLET, reported per wallet rather than
        // inferred from a total. "signers: 1" used to count only local
        // keypairs, so a supervisor perfectly able to settle a Privy wallet
        // looked like it could settle nothing — the operator's first question
        // ("can this thing settle on its own yet?") had no answer in the log.
        let signingRoute = walletSigner !== null ? "local-keypair" : "none";
        if (privyConfig !== null) {
          try {
            const resolution = await createPrivySolanaSigner(
              privyConfig,
              link.wallet,
              expectedSignerId,
              privyIndex,
            );
            if (resolution.outcome === "SIGNER") {
              walletSigner = resolution.signer;
              signingRoute = "privy";
            } else if (walletSigner === null) {
              signingRoute = resolution.outcome === "NOT_A_PRIVY_WALLET" ? "none (not a Privy wallet)" : "none (signer not granted)";
              logChange(
                `signer:${wallet}`,
                resolution.outcome === "NOT_A_PRIVY_WALLET"
                  ? "wallet is not a Privy wallet in this app"
                  : "wallet has not granted the keeper's signer — re-run the onboarding registration (step 3)",
                { wallet, ...(resolution.outcome === "SIGNER_NOT_GRANTED" ? { granted: resolution.granted } : {}) },
              );
            }
          } catch (error) {
            if (walletSigner === null) signingRoute = "none (privy lookup failed)";
            log("privy signer resolution failed", {
              wallet,
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const settle = await runSettleTick({
          connection, program, link, attester,
          walletSigner,
          live: isLive(),
        });
        // MONEY EVENTS always log and clear the dedupe key — a SETTLED or a
        // real FAILED (a broadcast that broke) is news every time. The resting
        // states each log ONCE on change: NO_SIGNER and INCOMPLETE are
        // persistent conditions a human must fix, so repeating them every
        // minute trains the operator to ignore the log; they stay visible in
        // /status instead (health.wallets), which never dedupes.
        if (settle.outcome === "SETTLED" || settle.outcome === "FAILED") {
          log(`settle ${settle.outcome.toLowerCase()}`, { wallet, vault: link.vault.toBase58(), detail: settle.detail, signature: settle.signature });
          lastLine.delete(`settle:${wallet}`);
          // A settle that broke is money that should have moved and did not.
          if (settle.outcome === "FAILED") {
            alerter.fire({
              key: `settle-failed:${wallet}`,
              severity: "critical",
              title: "A settlement failed",
              detail: settle.detail,
              context: { wallet, vault: link.vault.toBase58() },
            });
          } else {
            alerter.clear(`settle-failed:${wallet}`);
          }
          // Recorded from what the tick MEASURED, and only when every field is
          // present: a settle whose receipt was not read in time has no
          // contribution to record, and a guessed row is worse than no row.
          if (
            settle.outcome === "SETTLED" &&
            settle.signature !== undefined &&
            settle.profitLamports !== undefined &&
            settle.settledLamports !== undefined &&
            settle.nonce !== undefined &&
            settle.endSlot !== undefined
          ) {
            // The owner and skim are READ FROM THE VAULT, never assumed: the
            // read model is a mirror of the chain, and a mirror that invents a
            // field is worse than one that is missing it.
            if (readModel.enabled) {
              // THE WHOLE MIRROR IS OFF THE SETTLEMENT PATH — the extra RPC
              // read as much as the write. Awaiting either here stopped that
              // wallet's turn while `cycleRunning` stayed true, so every later
              // sweep logged "cycle skipped" and nobody was settled, with
              // /health green throughout. The EVM supervisor has always fired
              // these with `void`; this one awaited them, and the asymmetry
              // contradicted read-model.ts's own rule that a write failure must
              // never block a settlement.
              void (async () => {
                try {
                  // Same shape as invest-tick: the generic Program<Idl> has no
                  // typed account namespace, so the runtime one is reached
                  // through a narrow cast rather than by widening the program.
                  const accounts = program.account as unknown as Record<
                    string,
                    { fetch(a: PublicKey): Promise<{ owner: PublicKey; skimBps: number }> }
                  >;
                  const vaultState = await accounts.vault!.fetch(link.vault);
                  await readModel.recordLink(
                    link.vault.toBase58(),
                    vaultState.owner.toBase58(),
                    Number(vaultState.skimBps),
                    wallet,
                  );
                } catch (error) {
                  log("read-model link mirror skipped (settlement unaffected)", {
                    wallet,
                    detail: error instanceof Error ? error.message : String(error),
                  });
                }
              })();
            }
            void readModel.recordSettlement({
              walletAddr: wallet,
              nonce: settle.nonce,
              vaultAddr: link.vault.toBase58(),
              profitRaw: settle.profitLamports,
              contributionRaw: settle.settledLamports,
              txRef: settle.signature,
              height: settle.endSlot,
            });
          }
        } else {
          logChange(`settle:${wallet}`, `settle ${settle.outcome.toLowerCase()}`, { wallet, vault: link.vault.toBase58(), detail: settle.detail });
          // INCOMPLETE is the one resting state that never resolves itself: the
          // frontier cannot advance while it holds, so a wallet sitting in it
          // is a wallet that has silently stopped saving.
          if (settle.outcome === "INCOMPLETE") {
            alerter.fire({
              key: `incomplete:${wallet}`,
              severity: "warn",
              title: "A wallet cannot be measured, so it is not saving",
              detail: settle.detail,
              context: { wallet },
            });
          } else {
            alerter.clear(`incomplete:${wallet}`);
          }
          if (settle.outcome === "NO_SIGNER") {
            alerter.fire({
              key: `no-signer:${wallet}`,
              severity: "warn",
              title: "A linked wallet never granted the keeper's signer",
              detail: settle.detail,
              context: { wallet },
            });
          } else {
            alerter.clear(`no-signer:${wallet}`);
          }
        }

        const invest = await runInvestTick({
          connection, program, vault: link.vault, crank, pools, live: isLive(),
        });
        // INVESTED/FAILED/REFUSED always log; NO_POLICY and IDLE log on change
        // (both are "waiting" answers to the operator's commonest question —
        // why has nothing been bought — and NO_POLICY specifically means the
        // owner has not chosen a basket yet).
        if (invest.outcome === "INVESTED" || invest.outcome === "FAILED" || invest.outcome === "REFUSED") {
          log(`invest ${invest.outcome.toLowerCase()}`, { vault: link.vault.toBase58(), detail: invest.detail });
          lastLine.delete(`invest:${link.vault.toBase58()}`);
          // `purchases` is absent on a DRY RUN, which is the point: a dry run
          // must never leave a purchase in the history. EVERY confirmed leg is
          // recorded — including the ones that confirmed before a later leg
          // broke the basket, because those moved real money.
          for (const purchase of invest.purchases ?? []) {
            void readModel.recordInvestment({
              vaultAddr: link.vault.toBase58(),
              target: purchase.target,
              spentRaw: purchase.spentRaw,
              receivedRaw: purchase.receivedRaw,
              txRef: purchase.signature,
              height: purchase.slot,
            });
          }
          // A basket the registry cannot route is money that should be buying
          // and is not — the same absence-shaped failure the alerter exists
          // for, and before this it lived only in logs and /status.
          if (invest.outcome === "REFUSED") {
            alerter.fire({
              key: `invest-refused:${link.vault.toBase58()}`,
              severity: "warn",
              title: "A basket cannot be bought",
              detail: invest.detail,
              context: { vault: link.vault.toBase58() },
            });
          } else {
            alerter.clear(`invest-refused:${link.vault.toBase58()}`);
          }
        } else {
          logChange(`invest:${link.vault.toBase58()}`, `invest ${invest.outcome.toLowerCase()}`, { vault: link.vault.toBase58(), detail: invest.detail });
        }

        // /status always reflects the latest condition, deduped or not.
        signingRoutes.set(wallet, signingRoute);
        health.wallets[wallet] = {
          settle: settle.outcome,
          invest: invest.outcome,
          signing: signingRoute,
          detail: settle.outcome === "SETTLED" || settle.outcome === "NO_PROFIT" ? invest.detail : settle.detail,
          at: new Date().toISOString(),
        };
      } catch (error) {
        // Contained per wallet: one bad link must not end the sweep.
        log("wallet turn threw", { wallet, detail: error instanceof Error ? error.message : String(error) });
      }
    }

    // THE OPERATOR'S FIRST QUESTION, answered once per sweep: how many of these
    // wallets can this process settle WITHOUT a human? Logged on change only —
    // in steady state it is the same number forever, and a line repeated every
    // minute is a line nobody reads on the day it changes.
    const routes = [...signingRoutes.values()];
    const signable = routes.filter((r) => r === "privy" || r === "local-keypair").length;
    logChange(
      "signing-summary",
      "signing routes",
      {
        signable,
        of: routes.length,
        privy: routes.filter((r) => r === "privy").length,
        localKeypair: routes.filter((r) => r === "local-keypair").length,
        unsignable: routes.filter((r) => r.startsWith("none")).length,
        mode: isLive() ? "live" : "dry-run — nothing is sent",
      },
    );
  } catch (error) {
    health.lastSweepError = error instanceof Error ? error.message : String(error);
    log("sweep cycle failed", { detail: health.lastSweepError });
    alerter.fire({
      key: "sweep-failed",
      severity: "critical",
      title: "The keeper's sweep is failing",
      detail: health.lastSweepError,
    });
  } finally {
    cycleRunning = false;
  }
}

// The heartbeat, only when a port is provided (Railway injects PORT; a dev
// machine running the loop by hand gets no server unless asked). /health is
// alive-or-not for probes; /status is the JSON above for humans. Neither makes
// an RPC call — a probe must never fail because the upstream is down, since
// restarting a keeper has never once fixed an RPC.
if (process.env.PORT) {
  createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.end(
      JSON.stringify({
        ...health,
        program: program.programId.toBase58(),
        attester: attester.publicKey.toBase58(),
        crank: crank.publicKey.toBase58(),
        sweepMs,
        signing: privyConfig !== null ? "privy" : "local-keypairs",
      }),
    );
  }).listen(Number(process.env.PORT), () => log("heartbeat listening", { port: Number(process.env.PORT) }));
}

if (!broadcast && process.env.NUVEM_SOLANA_ALLOW_BROADCAST !== undefined) {
  // The sentinel alone arms nothing — only the broadcast flag consults it. An
  // operator who set one of the pair believes the keeper is live; say plainly
  // that it is not, because a silently-disarmed keeper is indistinguishable
  // from an armed one until the first profitable session settles nothing.
  log("NUVEM_SOLANA_ALLOW_BROADCAST is set but broadcast is OFF — still a dry run. Set NUVEM_SOLANA_BROADCAST=1 (or pass --broadcast) to arm.");
}

/**
 * ONE SUPERVISOR ACTS AT A TIME.
 *
 * Railway overlaps the old and new container on every deploy, so two of these
 * run concurrently as a matter of course. The on-chain frontier already stops a
 * double SETTLE, but nothing stopped two instances wrapping, converting and
 * investing the same vault — two purchases where the owner asked for one, plus
 * crank fees burned on whichever transaction loses the race.
 *
 * A supervisor that does not hold the claim DOWNGRADES TO DRY RUN rather than
 * exiting: it keeps sweeping, keeps answering /status, and keeps reporting what
 * it would have done — so a deploy that is meant to take over can, and a
 * misconfiguration is visible instead of silent.
 *
 * Without a database there is no lock to take. That is stated plainly rather
 * than assumed away: an operator running two armed instances with no DATABASE_URL
 * should know it is on them.
 */
const SINGLETON_KEY = 0x5_01a_11an; // "solana" in the EVM keeper's spirit

/**
 * Who acts. The lifecycle lives in src/singleton.ts so the overlapping-deploy
 * case has a test — inline, it read correctly and was wrong in exactly the
 * scenario it existed for.
 */
const claim = new SupervisorClaim({
  armed: broadcast,
  // No database, no lock. The supervisor acts anyway and says so below: an
  // operator running two armed instances without one should know it is on them.
  unenforced: !readModel.enabled,
  attempt: async () => {
    const result = await readModel.claimSingleton(BigInt(SINGLETON_KEY));
    return { held: result.held, release: () => result.client?.release() };
  },
  onTakeover: () => {
    health.mode = "live";
    log("took over as the acting supervisor");
    alerter.clear("not-acting");
  },
});
const isLive = (): boolean => claim.live;

if (broadcast && !readModel.enabled) {
  log(
    "no DATABASE_URL, so the single-supervisor lock is NOT enforced — " +
      "if two armed instances run at once, both will invest",
  );
}
await claim.ensure();
if (broadcast && !claim.held) {
  log("another supervisor holds the claim — running as a DRY RUN and retrying every sweep");
}
health.mode = isLive() ? "live" : "dry-run";

// ASKED BEFORE THE BANNER, so the banner can tell the truth about it. A mirror
// that is off, or pointed at a database without the schema, is invisible from
// every other signal this process emits.
const history = await readModel.preflight();
if (!history.ok && readModel.enabled) {
  log(`read model is not usable: ${history.detail}`);
}

log("supervisor starting", {
  program: program.programId.toBase58(),
  attester: attester.publicKey.toBase58(),
  crank: crank.publicKey.toBase58(),
  sweepMs,
  pools: pools.size,
  // FROM isLive(), NOT FROM `broadcast`. An instance that lost the claim
  // announced itself as LIVE in its startup banner and in /status while
  // settling nothing — the single most misleading line it could print.
  mode: isLive() ? "LIVE — settlements and purchases will be broadcast" : "dry run — nothing will be sent",
  signing: privyConfig !== null ? "Privy (no local wallet keys)" : "local keypairs (.local/signers)",
  // The website's calendar and history come from here. "off" and "BROKEN" both
  // mean the site will show an empty past for vaults that really did settle.
  history: history.detail,
});

/**
 * LET GO PROMPTLY. The advisory lock lives on the held session, so without this
 * a redeployed container keeps its claim until the connection eventually dies —
 * and the new instance, which is the one meant to be acting, runs dry for as
 * long as that takes. Releasing on the signal Railway actually sends turns a
 * handover into seconds instead of minutes.
 *
 * tini forwards SIGTERM to the process group (see the Dockerfile), so this
 * fires on every redeploy and every manual stop.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (claim.held) {
      log("releasing the supervisor claim");
      claim.release();
    }
    process.exit(0);
  });
}

await sweep();
setInterval(() => void sweep(), sweepMs);
