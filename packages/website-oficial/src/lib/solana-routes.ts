/**
 * The Solana route handlers, bound to this app's gate.
 *
 * Everything that decides what is relayed, built, read, verified, simulated or
 * sent lives in @sip/solana-core (createSolanaRpcHandler, createSolanaTxHandler,
 * createSolanaBuildHandler, createSolanaVaultHandler) and is tested there. This
 * file only answers "are the settings complete, and which are they?" per request,
 * from process.env (or an env a test passes). The route files export one
 * module-level instance each; tests build fresh ones with their own clock, fetch
 * and limiters, so bucket state never leaks between cases.
 */
import "server-only";

import {
  createSolanaBuildHandler,
  createSolanaRpcHandler,
  createSolanaTxHandler,
  createSolanaVaultHandler,
  type SolanaBuildHandlerOptions,
  type SolanaRouteHandler,
  type SolanaRpcHandlerOptions,
  type SolanaTxHandlerOptions,
  type SolanaVaultHandlerOptions,
} from "@sip/solana-core/server";

import type { Env } from "./config";
import { solanaGate } from "./load-config";

type WithEnv<T> = Omit<T, "gate"> & {
  /** Read at each request. Default: process.env. */
  readonly env?: Env;
};

/** POST /api/solana-rpc: the allowlisted JSON-RPC relay. */
export function solanaRpcRoute(options: WithEnv<SolanaRpcHandlerOptions> = {}): SolanaRouteHandler {
  const { env, ...rest } = options;
  return createSolanaRpcHandler({ ...rest, gate: () => solanaGate(env ?? process.env) });
}

/** POST /api/solana-tx: verified broadcast of a fully signed owner transaction. */
export function solanaTxRoute(options: WithEnv<SolanaTxHandlerOptions> = {}): SolanaRouteHandler {
  const { env, ...rest } = options;
  return createSolanaTxHandler({ ...rest, gate: () => solanaGate(env ?? process.env) });
}

/** POST /api/solana-build: unsigned owner transactions and the link consent, built from the chain's state. Never signs. */
export function solanaBuildRoute(options: WithEnv<SolanaBuildHandlerOptions> = {}): SolanaRouteHandler {
  const { env, ...rest } = options;
  return createSolanaBuildHandler({ ...rest, gate: () => solanaGate(env ?? process.env) });
}

/** POST /api/solana-vault: the pension key's vault, its trading wallets' links, rents and live pool prices, read server-side. */
export function solanaVaultRoute(options: WithEnv<SolanaVaultHandlerOptions> = {}): SolanaRouteHandler {
  const { env, ...rest } = options;
  return createSolanaVaultHandler({ ...rest, gate: () => solanaGate(env ?? process.env) });
}
