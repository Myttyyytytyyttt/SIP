// The vault's activity, read from the chain — and enriched by the read model
// when one exists.
//
// CHAIN FIRST, DATABASE SECOND, and that order is the point. /api/history reads
// the Postgres mirror the supervisor writes; it holds measured profit alongside
// each contribution, which no chain read can recover. But it is optional
// infrastructure, and on a deployment where it is unset or the keeper has not
// run, it answers with nothing. "Nothing" on a savings history reads as "your
// money did nothing", which is the one thing this screen must never say by
// accident. So the chain — which cannot be empty, because it is where the money
// moved — is the source, and the mirror only adds detail on top.

import { PublicKey } from "@solana/web3.js";

import { readSolanaActivity } from "../index";
import { DEFAULT_SOLANA_STOCKS, loadSolanaConfig, parseSolanaStocks, tryBase58Decode } from "../index";
import { deriveVaultPda } from "../index";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleSolanaActivity(request: Request): Promise<Response> {
  const config = loadSolanaConfig(process.env);
  if (config.kind === "DISABLED") return json({ kind: "DISABLED" });
  if (config.kind === "INVALID") return json({ kind: "INVALID", problems: config.problems }, 503);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "The request body is not JSON." }, 400);
  }

  // Either an owner (whose vault is derived) or a vault address directly, so
  // the owner-facing card and the paste-an-address reader share one route.
  let vaultAddress: string;
  if (typeof body.owner === "string") {
    if (tryBase58Decode(body.owner)?.length !== 32) {
      return json({ error: "`owner` must be a base58 32-byte address." }, 400);
    }
    vaultAddress = deriveVaultPda(new PublicKey(config.programId), new PublicKey(body.owner)).toBase58();
  } else if (typeof body.vault === "string") {
    if (tryBase58Decode(body.vault)?.length !== 32) {
      return json({ error: "`vault` must be a base58 32-byte address." }, 400);
    }
    vaultAddress = body.vault;
  } else {
    return json({ error: "Pass either `owner` or `vault`." }, 400);
  }

  const limit = Number(body.limit ?? 40);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return json({ error: "`limit` must be an integer in [1, 100]." }, 400);
  }

  const stocks = parseSolanaStocks(process.env.NUVEM_SOLANA_STOCKS ?? DEFAULT_SOLANA_STOCKS).stocks;
  const activity = await readSolanaActivity(config, vaultAddress, stocks, limit);
  return json({ kind: "OK", vaultAddress, activity });
}
