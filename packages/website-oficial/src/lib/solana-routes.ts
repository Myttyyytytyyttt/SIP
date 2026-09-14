/**
 * The two Solana route handlers, bound to this app's gate.
 *
 * Everything that decides what is relayed, verified, simulated or sent lives in
 * @sip/solana-core (createSolanaRpcHandler / createSolanaTxHandler) and is tested
 * there. This file only answers "is Solana on, and with which settings?" per
 * request, from process.env (or an env a test passes). The route files export one
 * module-level instance each; tests build fresh ones with their own clock, fetch
 * and limiters, so bucket state never leaks between cases.
 */
import "server-only";

import {
  createSolanaRpcHandler,
  createSolanaTxHandler,
  type SolanaRouteHandler,
  type SolanaRpcHandlerOptions,
  type SolanaTxHandlerOptions,
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
