// Reads a Nuvem Solana vault (the solana-lab experiment) — server-side only.
//
// DELIBERATELY SELF-CONTAINED, unlike every other read in this app. The lab is
// an experiment; its configuration must not ripple through ServerConfig,
// PublicConfig and toPublicConfig, and switching it off must be the absence of
// two env vars, not a code change. The DevPanel card talks to /api/solana and
// renders whatever this module reports — including "off".
//
// ZERO DEPENDENCIES, ON PURPOSE. A vault read is one getAccountInfo and 125
// bytes of fixed layout; pulling @solana/web3.js in for that would double this
// app's supply-chain surface for one dev-panel card. The decoder below is NOT
// trusted from memory: scripts/check-solana-decode.mts replays account bytes
// that the REAL program wrote on a validator (scripts/fixtures/) and compares
// field by field against what the program's own client decoded. Regenerate the
// fixtures after ANY change to the lab's state.rs.
//
// The layouts mirror packages/solana-lab-old/program/programs/nuvem-vault/src/state.rs
// (Anchor: 8-byte discriminator, then Borsh fields in declaration order).

import { poolRpc, solanaRpcUrls } from "./rpc-pool";

export type SolanaConfigResult =
  /** Not configured. The lab is off; nothing else in this app is affected. */
  | { readonly kind: "DISABLED" }
  | {
      readonly kind: "OK";
      /** The operator's first choice. Kept for callers that name one endpoint. */
      readonly rpcUrl: string;
      /**
       * Every endpoint, in order, ending with the public one — see rpc-pool.ts.
       * Reads should use THIS: a single endpoint is a single point of failure,
       * and one provider's 429 took the whole product's read path down.
       */
      readonly rpcUrls: readonly string[];
      readonly programId: string;
    }
  /** Configured and unusable — never softened to DISABLED. Same lesson as the
   * keeper's investment config: a half-configured feature that quietly does
   * nothing is the failure this shape exists to prevent. */
  | { readonly kind: "INVALID"; readonly problems: readonly string[] };

export function loadSolanaConfig(env: NodeJS.ProcessEnv): SolanaConfigResult {
  // EITHER VARIABLE COUNTS AS CONFIGURED. The second endpoint exists so a
  // rate-limited provider does not take the read path down; an operator who
  // sets only the spare should get a working site, not "not configured".
  const rpcUrl = env.NUVEM_SOLANA_RPC_URL?.trim() || env.NUVEM_SOLANA_RPC_URL2?.trim() || "";
  const programId = env.NUVEM_SOLANA_PROGRAM_ID?.trim() ?? "";
  if (rpcUrl === "" && programId === "") return { kind: "DISABLED" };

  const problems: string[] = [];
  if (rpcUrl === "") problems.push("NUVEM_SOLANA_RPC_URL is required when NUVEM_SOLANA_PROGRAM_ID is set");
  if (programId === "") problems.push("NUVEM_SOLANA_PROGRAM_ID is required when NUVEM_SOLANA_RPC_URL is set");
  if (programId !== "") {
    const decoded = tryBase58Decode(programId);
    if (decoded === null || decoded.length !== 32) {
      problems.push(`NUVEM_SOLANA_PROGRAM_ID is not a base58 32-byte address: "${programId}"`);
    }
  }
  if (problems.length > 0) return { kind: "INVALID", problems };
  return { kind: "OK", rpcUrl, rpcUrls: solanaRpcUrls(env), programId };
}

// ── base58 (the Bitcoin/Solana alphabet) ─────────────────────────────────────

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function tryBase58Decode(text: string): Uint8Array | null {
  if (text.length === 0 || text.length > 64) return null;
  let n = 0n;
  for (const char of text) {
    const digit = ALPHABET_MAP.get(char);
    if (digit === undefined) return null;
    n = n * 58n + digit;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // Leading '1's encode leading zero bytes.
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

// ── the two account layouts ──────────────────────────────────────────────────

// Anchor discriminators: sha256("account:<Name>")[0..8]. PINNED AS CONSTANTS
// and verified against the captured fixtures by check-solana-decode — a
// mismatch means state.rs changed and this whole file is stale.
export const VAULT_DISCRIMINATOR = "d308e82b02987577";
export const TRADING_LINK_DISCRIMINATOR = "c3228b98660ae4e3";

export const VAULT_SPACE = 125;
export const TRADING_LINK_SPACE = 129;
export const INVESTMENT_POLICY_DISCRIMINATOR = "cd3c025cc269b105";
/** Fixed: Anchor allocates max space (8 legs) even when fewer are stored. */
export const INVESTMENT_POLICY_SPACE = 938;

export interface SolanaVaultState {
  readonly owner: string;
  readonly version: number;
  readonly paused: boolean;
  readonly skimBps: number;
  /** Lamports ever settled in, as a decimal string (u64 exceeds Number). */
  readonly lifetimeSaved: string;
  readonly createdAt: string;
}

export interface SolanaTradingLinkState {
  readonly wallet: string;
  readonly vault: string;
  readonly epoch: string;
  readonly settlementNonce: string;
  readonly frontierSlot: string;
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function decodeVault(data: Uint8Array): SolanaVaultState {
  if (data.length !== VAULT_SPACE) {
    throw new Error(`vault account is ${data.length} bytes, expected ${VAULT_SPACE}`);
  }
  const disc = hex(data.subarray(0, 8));
  if (disc !== VAULT_DISCRIMINATOR) {
    throw new Error(`not a Vault account (discriminator ${disc})`);
  }
  const dv = view(data);
  return {
    owner: base58Encode(data.subarray(8, 40)),
    // Offset 40 is `bump`, NOT version — the first run of the fixture guard
    // caught exactly that: a decoder reading 255 (the canonical bump) as the
    // layout version, which is why the guard exists.
    version: data[41]!,
    paused: data[42] !== 0,
    skimBps: dv.getUint16(43, true),
    lifetimeSaved: dv.getBigUint64(45, true).toString(),
    createdAt: dv.getBigInt64(53, true).toString(),
  };
}

export interface SolanaPolicyLeg {
  readonly mint: string;
  readonly weightBps: number;
  /** WAD (1e18) floor: min out-raw per in-raw. Decimal string — u128. */
  readonly minOutRateWad: string;
}

export interface SolanaInvestmentPolicyState {
  readonly vault: string;
  readonly enabled: boolean;
  readonly venueProgram: string;
  readonly legs: readonly SolanaPolicyLeg[];
  readonly minConvertRateWad: string;
  readonly minInvestment: string;
  readonly maxPerCall: string;
  readonly maxRolling30d: string;
  readonly lifetimeInvested: string;
  readonly policyNonce: string;
}

/** u128 LE out of two u64 reads — DataView has no getBigUint128. */
const u128 = (dv: DataView, offset: number): bigint =>
  dv.getBigUint64(offset, true) + (dv.getBigUint64(offset + 8, true) << 64n);

export function decodeInvestmentPolicy(data: Uint8Array): SolanaInvestmentPolicyState {
  if (data.length !== INVESTMENT_POLICY_SPACE) {
    throw new Error(`policy account is ${data.length} bytes, expected ${INVESTMENT_POLICY_SPACE}`);
  }
  const disc = hex(data.subarray(0, 8));
  if (disc !== INVESTMENT_POLICY_DISCRIMINATOR) {
    throw new Error(`not an InvestmentPolicy account (discriminator ${disc})`);
  }
  const dv = view(data);

  // Borsh writes fields COMPACTLY: the vec carries its live length and every
  // field after it starts where the previous one ended — the account's fixed
  // size only pads zeros at the tail. So offsets past `legs` are computed,
  // never constant, and a decoder with hardcoded ones would pass for one-leg
  // policies and silently misread every other.
  const legsLen = dv.getUint32(73, true);
  if (legsLen > 8) throw new Error(`policy claims ${legsLen} legs; the program caps at 8`);
  const legs: SolanaPolicyLeg[] = [];
  let at = 77;
  for (let i = 0; i < legsLen; i++) {
    legs.push({
      mint: base58Encode(data.subarray(at, at + 32)),
      weightBps: dv.getUint16(at + 32, true),
      minOutRateWad: u128(dv, at + 34).toString(),
    });
    at += 50;
  }

  const minConvertRateWad = u128(dv, at).toString();
  at += 16;
  const minInvestment = dv.getBigUint64(at, true).toString();
  const maxPerCall = dv.getBigUint64(at + 8, true).toString();
  const maxRolling30d = dv.getBigUint64(at + 16, true).toString();
  at += 24;
  at += 31 * 4 + 31 * 8; // bucket_days + bucket_amounts: enforcement state, not display
  const lifetimeInvested = dv.getBigUint64(at, true).toString();
  const policyNonce = dv.getBigUint64(at + 8, true).toString();

  return {
    vault: base58Encode(data.subarray(8, 40)),
    enabled: data[40] !== 0,
    venueProgram: base58Encode(data.subarray(41, 73)),
    legs,
    minConvertRateWad,
    minInvestment,
    maxPerCall,
    maxRolling30d,
    lifetimeInvested,
    policyNonce,
  };
}

export function decodeTradingLink(data: Uint8Array): SolanaTradingLinkState {
  if (data.length !== TRADING_LINK_SPACE) {
    throw new Error(`trading link account is ${data.length} bytes, expected ${TRADING_LINK_SPACE}`);
  }
  const disc = hex(data.subarray(0, 8));
  if (disc !== TRADING_LINK_DISCRIMINATOR) {
    throw new Error(`not a TradingLink account (discriminator ${disc})`);
  }
  const dv = view(data);
  return {
    wallet: base58Encode(data.subarray(8, 40)),
    vault: base58Encode(data.subarray(40, 72)),
    epoch: dv.getBigUint64(72, true).toString(),
    settlementNonce: dv.getBigUint64(80, true).toString(),
    frontierSlot: dv.getBigUint64(88, true).toString(),
  };
}

// ── the read ─────────────────────────────────────────────────────────────────

export type SolanaRead<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: string;
      /**
       * True ONLY when the chain answered and the account does not exist.
       * A failed read never sets it — so "absent" is machine-readable and can
       * never be conflated with "unreadable", which is the difference between
       * offering create_vault and offering something the chain must refuse.
       */
      readonly missing?: true;
    };

export interface SolanaVaultRead {
  readonly address: string;
  readonly state: SolanaRead<SolanaVaultState>;
  readonly lamports: SolanaRead<string>;
  /** lamports minus the rent-exempt floor — what withdraw() would allow. The
   * floor is READ from the RPC, not derived: rent parameters are consensus
   * state and a pending SIMD proposes dividing them by ten. */
  readonly withdrawableLamports: SolanaRead<string>;
}

async function rpcCall(urls: readonly string[], method: string, params: unknown[]): Promise<unknown> {
  return poolRpc(urls, method, params);
}

/**
 * Reads one vault by address. The program-owner check is the anti-scam gate:
 * an account at the right size with the right discriminator but owned by a
 * different program is a forgery, and base58 addresses are cheap to mint.
 */
export async function readSolanaVault(
  config: { rpcUrls: readonly string[]; programId: string },
  address: string,
): Promise<SolanaVaultRead> {
  const decoded = tryBase58Decode(address);
  if (decoded === null || decoded.length !== 32) {
    const bad = { ok: false as const, error: "not a base58 32-byte address" };
    return { address, state: bad, lamports: bad, withdrawableLamports: bad };
  }

  try {
    const result = (await rpcCall(config.rpcUrls, "getAccountInfo", [
      address,
      { encoding: "base64", commitment: "confirmed" },
    ])) as { value: { data: [string, string]; lamports: number; owner: string } | null };

    if (result.value === null) {
      const missing = { ok: false as const, error: "no account exists at this address", missing: true as const };
      return { address, state: missing, lamports: missing, withdrawableLamports: missing };
    }
    if (result.value.owner !== config.programId) {
      const forged = {
        ok: false as const,
        error: `account is owned by ${result.value.owner}, not the configured program — refusing to decode`,
      };
      return { address, state: forged, lamports: forged, withdrawableLamports: forged };
    }

    const data = Uint8Array.from(Buffer.from(result.value.data[0], "base64"));
    const state = decodeVault(data);
    const lamports = BigInt(result.value.lamports);

    let withdrawable: SolanaRead<string>;
    try {
      const floor = (await rpcCall(config.rpcUrls, "getMinimumBalanceForRentExemption", [
        data.length,
      ])) as number;
      const free = lamports - BigInt(floor);
      withdrawable = { ok: true, value: (free > 0n ? free : 0n).toString() };
    } catch (error) {
      withdrawable = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    return {
      address,
      state: { ok: true, value: state },
      lamports: { ok: true, value: lamports.toString() },
      withdrawableLamports: withdrawable,
    };
  } catch (error) {
    const failed = { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    return { address, state: failed, lamports: failed, withdrawableLamports: failed };
  }
}

export interface SolanaLinkRead {
  readonly address: string;
  readonly state: SolanaRead<SolanaTradingLinkState>;
}

/**
 * Reads one trading link by address — the settle cursor made visible. Same
 * anti-forgery gate as the vault read: wrong program owner, no decode.
 */
export async function readSolanaLink(
  config: { rpcUrls: readonly string[]; programId: string },
  address: string,
): Promise<SolanaLinkRead> {
  const decoded = tryBase58Decode(address);
  if (decoded === null || decoded.length !== 32) {
    return { address, state: { ok: false, error: "not a base58 32-byte address" } };
  }
  try {
    const result = (await rpcCall(config.rpcUrls, "getAccountInfo", [
      address,
      { encoding: "base64", commitment: "confirmed" },
    ])) as { value: { data: [string, string]; owner: string } | null };

    if (result.value === null) {
      return { address, state: { ok: false, error: "no account exists at this address", missing: true } };
    }
    if (result.value.owner !== config.programId) {
      return {
        address,
        state: {
          ok: false,
          error: `account is owned by ${result.value.owner}, not the configured program — refusing to decode`,
        },
      };
    }
    const data = Uint8Array.from(Buffer.from(result.value.data[0], "base64"));
    return { address, state: { ok: true, value: decodeTradingLink(data) } };
  } catch (error) {
    return {
      address,
      state: { ok: false, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

// ── the links of one vault ───────────────────────────────────────────────────

export interface SolanaVaultLink {
  /** The TradingLink PDA's own address. */
  readonly address: string;
  readonly state: SolanaTradingLinkState;
}

/**
 * Every trading wallet currently linked to `vaultAddress` — the CURRENT set,
 * not history, exactly like the keeper's discovery: a TradingLink is an
 * account, unlink CLOSES it, so existence is membership and there is nothing
 * stale to filter out.
 *
 * The memcmp narrows server-side to links whose stored vault (offset 40)
 * matches, so the RPC does the scan; dataSize keeps every other account type
 * out. decodeTradingLink then re-checks the discriminator — a future account
 * type could share the size, and 129 bytes of coincidence must not decode into
 * a wallet list.
 */
export async function listVaultLinks(
  config: { rpcUrls: readonly string[]; programId: string },
  vaultAddress: string,
): Promise<SolanaRead<readonly SolanaVaultLink[]>> {
  try {
    const result = (await rpcCall(config.rpcUrls, "getProgramAccounts", [
      config.programId,
      {
        commitment: "confirmed",
        encoding: "base64",
        filters: [
          { dataSize: TRADING_LINK_SPACE },
          { memcmp: { offset: 40, bytes: vaultAddress } },
        ],
      },
    ])) as readonly { pubkey: string; account: { data: [string, string] } }[];

    const links: SolanaVaultLink[] = [];
    for (const { pubkey, account } of result) {
      try {
        const state = decodeTradingLink(Uint8Array.from(Buffer.from(account.data[0], "base64")));
        // The memcmp already matched, but the RPC is not the trust boundary —
        // the decoder's own reading of the vault field is.
        if (state.vault === vaultAddress) links.push({ address: pubkey, state });
      } catch {
        // Right size, wrong discriminator: not a TradingLink. Skipped, not fatal.
      }
    }
    return { ok: true, value: links };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface SolanaPolicyRead {
  readonly address: string;
  readonly state: SolanaRead<SolanaInvestmentPolicyState>;
}

/** Reads one investment policy by address. Same anti-forgery gate as the rest. */
export async function readSolanaPolicy(
  config: { rpcUrls: readonly string[]; programId: string },
  address: string,
): Promise<SolanaPolicyRead> {
  const decoded = tryBase58Decode(address);
  if (decoded === null || decoded.length !== 32) {
    return { address, state: { ok: false, error: "not a base58 32-byte address" } };
  }
  try {
    const result = (await rpcCall(config.rpcUrls, "getAccountInfo", [
      address,
      { encoding: "base64", commitment: "confirmed" },
    ])) as { value: { data: [string, string]; owner: string } | null };

    if (result.value === null) {
      return { address, state: { ok: false, error: "no account exists at this address", missing: true } };
    }
    if (result.value.owner !== config.programId) {
      return {
        address,
        state: {
          ok: false,
          error: `account is owned by ${result.value.owner}, not the configured program — refusing to decode`,
        },
      };
    }
    const data = Uint8Array.from(Buffer.from(result.value.data[0], "base64"));
    return { address, state: { ok: true, value: decodeInvestmentPolicy(data) } };
  } catch (error) {
    return { address, state: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

// ── the default investment policy ───────────────────────────────────────────

/**
 * THE PLATFORM'S POLICY, in one place.
 *
 * The user's only decision is WHICH STOCK. Everything below is ours, for the
 * same reason RH's caps are RH's: these are not preferences a saver can price,
 * they are safety limits whose right value depends on how the keeper behaves —
 * which we know and they do not. Asking for them was friction wearing the
 * costume of control.
 *
 * WHAT EACH ONE ACTUALLY GUARDS — none of them is about cost. On Solana a $5
 * buy pays roughly three cents all in (proportional pool fee plus a sub-cent
 * network fee), so the minimum is not a break-even threshold:
 *
 *  - `minInvestmentUsdc` is an ANTI-DUST rule. It stops the keeper turning one
 *    settlement into a stream of micro-purchases, each a separate position
 *    line and a separate taxable event for the user.
 *  - `maxPerCallUsdc` bounds ONE keeper action. If a route, a price feed or the
 *    keeper itself misbehaves, this is the most that can be spent before a
 *    human sees it.
 *  - `maxRolling30dUsdc` bounds a COMPROMISED keeper over a month, in 31 day
 *    buckets the program enforces (state.rs InvestmentPolicy).
 *
 * These are SIGNED BY THE OWNER and enforced ON CHAIN — that is what makes
 * them protection rather than configuration. The keeper cannot raise them; it
 * can only act within what the user's wallet already agreed to.
 *
 * Operators tune them with NUVEM_SOLANA_POLICY_DEFAULTS ("min,perCall,rolling"
 * in whole USDC) without a rebuild, same doctrine as every other value here.
 */
export interface SolanaPolicyDefaults {
  readonly minInvestmentUsdc: number;
  readonly maxPerCallUsdc: number;
  readonly maxRolling30dUsdc: number;
}

export const BUILTIN_SOLANA_POLICY_DEFAULTS: SolanaPolicyDefaults = {
  minInvestmentUsdc: 5,
  maxPerCallUsdc: 500,
  maxRolling30dUsdc: 5_000,
};

/**
 * Parses the operator override. A malformed value is a PROBLEM, never a silent
 * fallback: an operator who set a $50 minimum and got $5 would find out from
 * their users. The program's own rule (0 < min ≤ perCall ≤ rolling) is checked
 * here too, so a contradictory triple is refused before anyone signs it.
 */
export function parseSolanaPolicyDefaults(
  raw: string | undefined,
): { defaults: SolanaPolicyDefaults; problems: string[] } {
  const text = raw?.trim() ?? "";
  if (text === "") return { defaults: BUILTIN_SOLANA_POLICY_DEFAULTS, problems: [] };

  const parts = text.split(",").map((part) => part.trim());
  if (parts.length !== 3) {
    return {
      defaults: BUILTIN_SOLANA_POLICY_DEFAULTS,
      problems: [`expected three comma-separated whole USDC amounts "min,perCall,rolling", got "${text.slice(0, 40)}"`],
    };
  }
  const numbers = parts.map(Number);
  for (const [i, value] of numbers.entries()) {
    if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
      return {
        defaults: BUILTIN_SOLANA_POLICY_DEFAULTS,
        problems: [`"${parts[i]}" is not a whole USDC amount between 1 and 1000000`],
      };
    }
  }
  const [minInvestmentUsdc, maxPerCallUsdc, maxRolling30dUsdc] = numbers as [number, number, number];
  if (!(minInvestmentUsdc <= maxPerCallUsdc && maxPerCallUsdc <= maxRolling30dUsdc)) {
    return {
      defaults: BUILTIN_SOLANA_POLICY_DEFAULTS,
      problems: [`the caps must satisfy min ≤ per-call ≤ 30-day, got ${minInvestmentUsdc}, ${maxPerCallUsdc}, ${maxRolling30dUsdc}`],
    };
  }
  return { defaults: { minInvestmentUsdc, maxPerCallUsdc, maxRolling30dUsdc }, problems: [] };
}

// ── the Solana stock list ────────────────────────────────────────────────────

export interface SolanaStock {
  readonly symbol: string;
  readonly mint: string;
  readonly name: string;
}

/**
 * The default is MEASURED, not invented — the same standard lib/stocks.ts sets
 * for the EVM list: this exact mint was bought on mainnet by the drill
 * (0.01737042 NVDAx, the fixture's lifetimeInvested is that purchase), and it
 * is the one pool the keeper's registry carries. A stock added here without a
 * pool in NUVEM_SOLANA_POOLS is refused by the keeper BY NAME, never silently.
 */
/**
 * The 20 xStocks with the deepest Raydium CLMM liquidity against USDC on
 * 2026-08-26, ranked by pool TVL (from USD 2.5M QQQx down to USD 44k INTCx —
 * the 21st had USD 20k and it only gets thinner). Chosen by DATA, not by fame:
 * the cliff below this line is where a USD 500 buy starts moving the price.
 */
export const DEFAULT_SOLANA_STOCKS =
  "QQQx:Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ:Nasdaq 100,SPYx:XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W:S&P 500,CRCLx:XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1:Circle,TSLAx:XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB:Tesla,NVDAx:Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh:NVIDIA,SPCXx:Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8:SpaceX,COINx:Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu:Coinbase,MSTRx:XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ:MicroStrategy,AMZNx:Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg:Amazon,GLDx:Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re:Gold,GOOGLx:XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN:Alphabet,MSFTx:XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX:Microsoft,STRCx:Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH:Strategy PP Variable,HOODx:XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg:Robinhood,AVGOx:XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo:Broadcom,METAx:Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu:Meta,AAPLx:XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp:Apple,BRK.Bx:Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x:Berkshire Hathaway,PLTRx:XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4:Palantir,INTCx:XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM:Intel";

/**
 * The pool each of those mints trades against USDC in — the SAME source the
 * prices come from, so what the portfolio shows and what the keeper buys can
 * never quote different venues. Every address here was read back on mainnet
 * and decoded with this package's own decoder before being committed.
 *
 * PRICING DEFAULTS ONLY. The keeper's TRADING registry stays in its own
 * environment on purpose — money movement keeps explicit operator config —
 * but a read-only price having a verified builtin beats a portfolio that
 * cannot value what the platform itself sold you. NUVEM_SOLANA_POOLS still
 * overrides this entirely when set.
 */
export const BUILTIN_SOLANA_POOLS =
  "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ=GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG,XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W=6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE,XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1=GYqHjuDzTiw7i52Xv1qohDE6eJr6eSZpsrBVikGZyaFV,XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB=8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF,Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh=49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6,Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8=AHNN6JmvaGG6XUoSg7sEr38gRYDB2jTbUvqXVuqaRHpq,Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu=w7SGmPeXoMCsjvXqgsAmUn56uypyDsjAtsxeVkaiqxa,XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ=RyhF4cksVZY7vcqJpoytHcxcGNKRp27PEGhSnEPpbGv,Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg=6m5aXAve4uh6Kt4ytKyCLWNMjd8PYP5vujwNCtycrUiD,Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re=78ReVNMLGRWmjtf2HmBoHUe2pRcsctXTTbxJnbhchyze,XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN=B8YAwjGYk6qidWzGBXMAxP7nYfG8g74EZ3Y4gFSsobRw,XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX=CLu4kFM4nb67xrdN7vJnMxXXir8Z5hA4HJUzPFccXjsL,Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH=DU9dgBU6Yh2JjsYcjtRY21G14dhQxn6Xm5PT949Sa4tA,XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg=DXWbip5LducMAbDSSpLYz9Xik3253EPeAYQufQtx7LXs,XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo=EkpbWmPzrzFsv2xkJRdvWs61aRuDBVdrJK7WQmctBFnB,Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu=3L7KbPVaAQA4UTecaGQYsm6UCq5F3sZM9zAYkxqYt63j,XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp=CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y,Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x=B4UdLnvzCrnfRndLdgGTYZjcKTDsaFKB54cmKb2GoSne,XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4=2EbY6YYKdQY9mmn9voiadgMcEnmZ5oe7qkcFVmywNrrE,XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM=6KoZB86BFDk6TZbB4CTBoAA8PPbpmEwSWFjCyfkt1Uw4," +
  // wSOL/USDC — how native SOL gets a dollar value.
  "So11111111111111111111111111111111111111112=3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv";

/**
 * Parses NUVEM_SOLANA_STOCKS ("SYMBOL:mint:Name," — the EVM variable's format
 * with a base58 mint in the address slot). Malformed entries are returned as
 * problems rather than dropped: a list that silently shrinks looks identical
 * to an operator who chose fewer stocks.
 */
export function parseSolanaStocks(raw: string): { stocks: SolanaStock[]; problems: string[] } {
  const stocks: SolanaStock[] = [];
  const problems: string[] = [];
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [symbol, mint, ...nameParts] = entry.split(":");
    const name = nameParts.join(":").trim();
    if (!symbol?.trim() || !mint?.trim() || name === "") {
      problems.push(`"${entry.slice(0, 40)}" is not SYMBOL:mint:Name`);
      continue;
    }
    const decoded = tryBase58Decode(mint.trim());
    if (decoded === null || decoded.length !== 32) {
      problems.push(`"${symbol.trim()}" has a mint that is not a base58 32-byte address`);
      continue;
    }
    if (stocks.some((existing) => existing.mint === mint.trim())) {
      problems.push(`"${symbol.trim()}" repeats a mint already in the list`);
      continue;
    }
    stocks.push({ symbol: symbol.trim(), mint: mint.trim(), name });
  }
  if (stocks.length === 0 && problems.length === 0) problems.push("the list is empty");
  return { stocks, problems };
}

// ── what the vault actually holds ───────────────────────────────────────────

export interface SolanaVaultHolding {
  readonly mint: string;
  /**
   * Raw amount, decimal string — u64 can exceed Number. THIS is what a
   * transfer moves, and it is NOT uiAmount x 10^decimals for every mint.
   */
  readonly amountRaw: string;
  readonly decimals: number;
  /**
   * What the holder actually owns, as the RPC formatted it — and deliberately
   * NOT derivable from amountRaw here.
   *
   * xStocks mints carry Token-2022's `scaledUiAmount` extension: NVDAx today
   * has a multiplier of ~1.0009, so 464278 raw units display as 0.00464704.
   * That gap is the mechanism issuers use for corporate actions, not a
   * rounding bug — so DISPLAY this and TRANSFER amountRaw. Deriving one from
   * the other, in either direction, moves the wrong quantity.
   */
  readonly uiAmount: string;
  /** The mint's OWNING program: classic SPL or Token-2022. Read, not assumed —
   * a withdraw built with the wrong one fails, and stocks differ from USDC. */
  readonly tokenProgram: string;
  /** Symbol when this deployment lists the mint; null otherwise (decoration). */
  readonly symbol: string | null;
}

export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * Every non-zero token balance the vault PDA owns, across BOTH token programs.
 *
 * This is what makes a token withdraw offerable: the owner cannot be asked to
 * type a mint address they have never seen. The keeper's purchases land in
 * vault-owned ATAs, so this is the list of what their savings became.
 */
export async function listVaultHoldings(
  config: { rpcUrls: readonly string[]; programId: string },
  vaultAddress: string,
  stocks: readonly SolanaStock[] = [],
): Promise<SolanaRead<readonly SolanaVaultHolding[]>> {
  const decoded = tryBase58Decode(vaultAddress);
  if (decoded === null || decoded.length !== 32) {
    return { ok: false, error: "not a base58 32-byte address" };
  }
  try {
    const holdings: SolanaVaultHolding[] = [];
    for (const tokenProgram of [SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const result = (await rpcCall(config.rpcUrls, "getTokenAccountsByOwner", [
        vaultAddress,
        { programId: tokenProgram },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ])) as {
        value: readonly {
          account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number; uiAmountString: string } } } } };
        }[];
      };
      for (const entry of result.value) {
        const info = entry.account.data.parsed.info;
        // Zero balances are accounts the keeper opened, not savings. Showing
        // them as withdrawable options would be noise with a button.
        if (info.tokenAmount.amount === "0") continue;
        holdings.push({
          mint: info.mint,
          amountRaw: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals,
          uiAmount: info.tokenAmount.uiAmountString,
          tokenProgram,
          symbol: stocks.find((stock) => stock.mint === info.mint)?.symbol ?? null,
        });
      }
    }
    return { ok: true, value: holdings };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
