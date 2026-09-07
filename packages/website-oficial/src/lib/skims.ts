// Reads the worker's skim ledger for one vault — server-side only (this module
// holds a pg pool; the browser gets its answer through /api/skims and may
// import only the types from here).
//
// Ported from HEAD's src/lib/history.ts (fd927b0), minus the Solana schema and
// the profit / investment rows; the SSL helper from history-ssl.ts is inlined.
//
// SAME DISCIPLINE AS THE CHAIN READS (vault.ts): a value that cannot be read is
// SAID to be unavailable, never faked. The ledger is DERIVED and may be absent
// (no DATABASE_URL, tables the worker has not created yet) or behind; it is
// status for display, never a source of truth. If it cannot be reached the
// page shows "Status unavailable" and carries on — the same DISABLED-not-broken
// shape as the keeper's config.
//
// Schema: packages/worker/src/ledger/schema.ts is the truth; it was a stub when
// this was written, so the queries below use exactly the columns named in
// packages/worker/DESIGN.md §2 "ledger" and nothing more.

import { Pool } from "pg";
import type { Address, Hex } from "viem";

import { settingFrom } from "@/lib/config";
import { redactSecrets } from "@/lib/redact";

/** The worker's window states (packages/worker/src/types.ts); anything else is shown verbatim. */
export type SkimWindowStatus = "OPEN" | "SIGNED" | "SUBMITTED" | "CONFIRMED" | "FAILED";

export interface SkimWindow {
  /** Last L2 block the window covers. */
  readonly endL2: bigint;
  readonly sumNotionalWei: bigint;
  readonly status: SkimWindowStatus | string;
}

export interface SkimPull {
  readonly txHash: Hex;
  readonly contributionWei: bigint;
  readonly outcome: string;
  /** ISO timestamp when the ledger records one; null when it does not. */
  readonly at: string | null;
}

export interface SkimWallet {
  /** Lowercase, as the ledger stores it. */
  readonly address: Address;
  /** Everything the rule ever put aside for this wallet. */
  readonly owedTotalWei: bigint;
  /** What has actually been pulled into the vault. */
  readonly collectedTotalWei: bigint;
  /** owed − collected: put aside but not yet collectable (the wallet held no ETH). */
  readonly pendingWei: bigint;
  readonly lastWindow: SkimWindow | null;
  /** The last pull that was actually sent (dry runs and skips carry no hash and are not "a pull"). */
  readonly lastPull: SkimPull | null;
}

/** The body of GET /api/skims, as tagged-bigint JSON (src/lib/serialize.ts). */
export type SkimsResponse =
  | {
      readonly source: "ledger";
      readonly vault: Address;
      readonly explorerUrl: string | null;
      readonly wallets: readonly SkimWallet[];
    }
  /** No database here, no tables, or the query failed — NOT "nothing put aside". */
  | { readonly source: "unavailable"; readonly reason: string };

export type SkimsRead =
  | { readonly ok: true; readonly wallets: readonly SkimWallet[] }
  | { readonly ok: false; readonly reason: string };

// BOTH READ THROUGH config.ts's ALIAS TABLE, not through a private list of
// names. They used to accept two spellings each where loadConfig accepts three
// and four, so a deployment configured with NUVEM_DATABASE_URL or
// NEXT_PUBLIC_EXPLORER_URL had a database and an explorer everywhere except
// here — and this module's whole contract is that "absent" is said out loud, so
// it would have said "skim status is not configured" about a configured one.

/** The worker's Postgres (`DATABASE_URL`, the name @sip/worker reads too). Null when absent or blank. */
export function databaseUrlFrom(env: NodeJS.ProcessEnv): string | null {
  return settingFrom(env, "databaseUrl");
}

/** `NUVEM_EXPLORER_URL` and its aliases, trailing slashes dropped. Null when unset. */
export function explorerUrlFrom(env: NodeJS.ProcessEnv): string | null {
  const url = settingFrom(env, "explorerUrl");
  if (url === null) return null;
  const trimmed = url.replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

/**
 * Mirrors the keeper's sslOptionsFor (keeper-old/src/ledger-pg.ts) without
 * importing across packages: Supabase and most managed Postgres terminate TLS
 * with a cert the default chain rejects, so encrypt with relaxed validation
 * unless sslmode was explicitly disabled — which no provider hands out, so it
 * only appears where somebody typed it.
 */
function sslOptionsFor(connectionString: string): { rejectUnauthorized: false } | false {
  let mode: string | null;
  try {
    mode = new URL(connectionString).searchParams.get("sslmode");
  } catch {
    // Unparseable, so nothing was explicitly disabled. Encrypt.
    return { rejectUnauthorized: false };
  }
  return mode?.toLowerCase() === "disable" ? false : { rejectUnauthorized: false };
}

// One pool per server process, lazily built. Kept small: this is a read path
// for a dashboard, not the worker's loop.
let pool: Pool | null = null;
let poolUrl: string | null = null;

function getPool(url: string): Pool {
  if (pool !== null && poolUrl === url) return pool;
  pool?.end().catch(() => {});
  pool = new Pool({
    connectionString: url,
    ssl: sslOptionsFor(url),
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", () => {}); // an idle client erroring must not crash the server
  poolUrl = url;
  return pool;
}

/**
 * A reason fit for a browser. pg's messages can carry a host and port, a user
 * name or — from a URL parse — the connection string itself; anything URL-,
 * host- or key-shaped is stripped before it leaves the server. The local pass
 * handles what is Postgres-specific (hosts, ports, user names); the shared
 * redactor then sweeps every URL- and token-shaped run, as for every route.
 */
function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "[host]")
    .replace(/\b[a-z0-9.-]+\.[a-z]{2,}:\d{1,5}\b/gi, "[host]")
    .replace(/0x[0-9a-f]{64}\b/gi, "[hex]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[hex]")
    .replace(/for user "[^"]*"/gi, "for user")
    .replace(/\s+/g, " ")
    .trim();
  const cleaned = redactSecrets(scrubbed);
  if (cleaned === "") return "the ledger could not be read";
  return cleaned.length > 200 ? `${cleaned.slice(0, 199)}…` : cleaned;
}

/** numeric(78,0)::text -> bigint. Anything else is a malformed row, and a malformed row is not a number. */
function toWei(value: unknown, column: string): bigint {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`ledger column ${column} is not an integer`);
}

function toAddress(value: unknown, column: string): Address {
  if (typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value)) return value.toLowerCase() as Address;
  throw new Error(`ledger column ${column} is not an address`);
}

function toHash(value: unknown, column: string): Hex {
  if (typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value)) return value.toLowerCase() as Hex;
  throw new Error(`ledger column ${column} is not a transaction hash`);
}

/**
 * DESIGN.md names no timestamp on sip_pull. The real DDL may well add one
 * (`created_at` is the reflex), so the row travels as jsonb too and the first
 * timestamp-looking column wins; none means `at: null`, never a made-up time.
 * Only the timestamp is read from the jsonb — the wei columns come through
 * `::text`, because a 78-digit numeric inside JSON becomes a float in JS.
 */
const TIMESTAMP_COLUMNS = ["at", "created_at", "recorded_at", "sent_at", "inserted_at", "updated_at"] as const;

function timestampOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  for (const column of TIMESTAMP_COLUMNS) {
    const value = record[column];
    if (typeof value !== "string") continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

interface WalletRow {
  readonly address: unknown;
  readonly owed_total_wei: unknown;
  readonly collected_total_wei: unknown;
}

interface WindowRow {
  readonly wallet: unknown;
  readonly end_l2: unknown;
  readonly sum_notional_wei: unknown;
  readonly status: unknown;
}

interface PullRow {
  readonly wallet: unknown;
  readonly tx_hash: unknown;
  readonly contribution_wei: unknown;
  readonly outcome: unknown;
  readonly raw: unknown;
}

/**
 * Put aside / collected / pending per trading wallet of one vault, with each
 * wallet's latest window and latest sent pull. `vault` is matched
 * case-insensitively so a checksummed address from /api/vault finds the
 * lowercase rows the worker writes.
 */
export async function readSkims(vault: Address, databaseUrl: string): Promise<SkimsRead> {
  const key = vault.toLowerCase();
  try {
    const client = await getPool(databaseUrl).connect();
    try {
      const wallets = await client.query<WalletRow>(
        `SELECT address,
                owed_total_wei::text      AS owed_total_wei,
                collected_total_wei::text AS collected_total_wei
           FROM sip_wallet
          WHERE lower(vault) = $1
          ORDER BY address`,
        [key],
      );

      // The latest window per wallet: highest end block, then the newest id
      // (serial) for two windows ending on the same block after a re-close.
      const windows = await client.query<WindowRow>(
        `SELECT DISTINCT ON (wallet)
                wallet,
                end_l2::text           AS end_l2,
                sum_notional_wei::text AS sum_notional_wei,
                status
           FROM sip_window
          WHERE lower(vault) = $1
          ORDER BY wallet, end_l2 DESC, id DESC`,
        [key],
      );

      // The latest SENT pull per wallet. A dry run records no hash and a skip
      // no intent, so `tx_hash IS NOT NULL` is "it left the building" without
      // depending on how the outcome column spells it. Within a wallet the
      // nonce only ever grows, so it orders retries of one window correctly.
      // `detail` is dropped from the jsonb: it may carry the signed raw tx and
      // the attestation, none of which this page needs to hold.
      const pulls = await client.query<PullRow>(
        `SELECT DISTINCT ON (w.wallet)
                w.wallet,
                p.tx_hash,
                p.contribution_wei::text AS contribution_wei,
                p.outcome,
                (to_jsonb(p) - 'detail') AS raw
           FROM sip_pull p
           JOIN sip_window w ON w.id = p.window_id
          WHERE lower(w.vault) = $1
            AND p.tx_hash IS NOT NULL
          ORDER BY w.wallet, w.end_l2 DESC, w.id DESC, p.nonce DESC NULLS LAST`,
        [key],
      );

      const lastWindow = new Map<string, SkimWindow>();
      for (const row of windows.rows) {
        lastWindow.set(toAddress(row.wallet, "sip_window.wallet"), {
          endL2: toWei(row.end_l2, "sip_window.end_l2"),
          sumNotionalWei: toWei(row.sum_notional_wei, "sip_window.sum_notional_wei"),
          status: typeof row.status === "string" ? row.status : "UNKNOWN",
        });
      }

      const lastPull = new Map<string, SkimPull>();
      for (const row of pulls.rows) {
        lastPull.set(toAddress(row.wallet, "sip_window.wallet"), {
          txHash: toHash(row.tx_hash, "sip_pull.tx_hash"),
          contributionWei: toWei(row.contribution_wei, "sip_pull.contribution_wei"),
          outcome: typeof row.outcome === "string" ? row.outcome : "UNKNOWN",
          at: timestampOf(row.raw),
        });
      }

      const out: SkimWallet[] = wallets.rows.map((row) => {
        const address = toAddress(row.address, "sip_wallet.address");
        const owedTotalWei = toWei(row.owed_total_wei, "sip_wallet.owed_total_wei");
        const collectedTotalWei = toWei(row.collected_total_wei, "sip_wallet.collected_total_wei");
        const pending = owedTotalWei - collectedTotalWei;
        return {
          address,
          owedTotalWei,
          collectedTotalWei,
          pendingWei: pending > 0n ? pending : 0n,
          lastWindow: lastWindow.get(address) ?? null,
          lastPull: lastPull.get(address) ?? null,
        };
      });
      return { ok: true, wallets: out };
    } finally {
      client.release();
    }
  } catch (error) {
    return { ok: false, reason: safeReason(error) };
  }
}
