/**
 * The wire contract between the route handlers under src/app/api and the client
 * components. It lives here, rather than being exported from the route modules,
 * so a client component can `import type` it without any chance of pulling a
 * server-only module (and the privileged RPC URL it reads) into the browser
 * bundle. Ported from the Nuvem dashboard's src/lib/api-types.ts (HEAD fd927b0).
 *
 * Values of type `bigint` travel tagged — see src/lib/serialize.ts; read a
 * response with `parseTagged<T>(await response.text())`, never `.json()`.
 */

import type { Address, Hex } from "viem";

import type { ConfigProblem } from "./config";

// ---------------------------------------------------------------------------
// POST /api/create-vault
// ---------------------------------------------------------------------------

export interface CreateVaultPreview {
  readonly userSalt: Hex;
  readonly initData: Hex;
  readonly cohortId: bigint;
  readonly cohortRegistered: boolean;
  readonly vaultId: Hex | null;
  readonly predicted: Address | null;
  readonly predictionError: string | null;
  /** null when the simulation succeeded; the decoded revert otherwise. */
  readonly simulationError: string | null;
}

export type ReceiptState =
  | { readonly state: "pending" }
  | { readonly state: "success" }
  | { readonly state: "reverted" };

// ---------------------------------------------------------------------------
// GET /api/vault
// ---------------------------------------------------------------------------

/**
 * NuvemTypes.AccountStatus minus NONE: an address the vault has never heard of
 * is not "an account with status NONE", it is simply not in the list.
 */
export type VaultAccountStatus = "PENDING" | "ACTIVE" | "PAUSED" | "REVOKED";

export interface VaultAccountView {
  readonly address: Address;
  readonly status: VaultAccountStatus;
  /** Basis points of every fill's notional this wallet puts aside. */
  readonly savingsBps: number;
  /** UNIX seconds, NOT a block number. Zero once the invite is consumed. */
  readonly inviteDeadline: number;
  readonly inviteNonce: bigint;
  readonly inviteAdminEpoch: bigint;
}

/** `GET /api/vault?admin=0x…` */
export interface VaultByAdminResponse {
  /** VaultFactory.vaultOfAdmin(admin); null means this pension key has no vault yet. */
  readonly vault: Address | null;
  readonly cohortId: bigint;
  /** Every trading wallet the vault's logs name, with its CURRENT status. */
  readonly accounts: readonly VaultAccountView[];
  /**
   * Null when the log scan and every account read succeeded. Otherwise the
   * reason the list above may be INCOMPLETE — render it as "unknown", never as
   * "no trading wallets". A wallet missing from this list looks exactly like a
   * wallet that does not exist, which is the one thing the page must not imply
   * by accident.
   */
  readonly accountsError: string | null;
}

/** `GET /api/vault?account=0x…` */
export interface VaultByAccountResponse {
  /** VaultFactory.activeVaultOf(account); null means not linked anywhere. */
  readonly activeVaultOf: Address | null;
}

// ---------------------------------------------------------------------------
// Every non-2xx body
// ---------------------------------------------------------------------------

export interface ApiError {
  readonly error: string;
  readonly problems?: readonly ConfigProblem[];
}
