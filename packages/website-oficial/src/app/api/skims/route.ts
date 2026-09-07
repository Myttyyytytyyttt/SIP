// GET /api/skims?vault=0x… — what the rule put aside, what was collected and
// what is still pending per trading wallet, from the worker's READ MODEL, never
// from the chain.
//
// Ported from HEAD's src/app/api/saving-days/route.ts (fd927b0), reshaped for
// the volume ledger: one vault in, one row per wallet out, as tagged-bigint
// JSON so a wei amount never crosses the wire as a float.
//
// ABSENT IS NOT EMPTY, and this route's whole contract turns on it. The ledger
// is optional — no DATABASE_URL, tables the worker never created, a worker that
// has not run — and any of those would make a naive query silently return
// nothing. A status drawn from a silent database would print "0 put aside" over
// money that really moved. So a database that cannot be reached answers
// `source: "unavailable"` with its reason, and the page says so instead of
// guessing.

import { isAddress } from "viem";

import { jsonResponse } from "@/lib/serialize";
import { databaseUrlFrom, explorerUrlFrom, readSkims, type SkimsResponse } from "@/lib/skims";

// DATABASE_URL is read at request time, never at build time.
export const dynamic = "force-dynamic";

function unavailable(reason: string): SkimsResponse {
  return { source: "unavailable", reason };
}

export async function GET(request: Request): Promise<Response> {
  const vault = new URL(request.url).searchParams.get("vault")?.trim() ?? "";
  // strict: false — /api/vault hands out checksummed addresses and the worker
  // stores lowercase ones; both name the same vault and both are welcome here.
  if (!isAddress(vault, { strict: false })) {
    return jsonResponse({ error: "`vault` must be an address." }, 400);
  }

  const databaseUrl = databaseUrlFrom(process.env);
  if (databaseUrl === null) {
    // 200, not 5xx: "we do not have a database here" is information about this
    // deployment, not a failure of the request — DISABLED, not broken.
    return jsonResponse(unavailable("skim status is not configured on this deployment (no DATABASE_URL)"));
  }

  const read = await readSkims(vault, databaseUrl);
  if (!read.ok) {
    return jsonResponse(unavailable(read.reason));
  }

  const body: SkimsResponse = {
    source: "ledger",
    vault,
    explorerUrl: explorerUrlFrom(process.env),
    wallets: read.wallets,
  };
  return jsonResponse(body);
}
