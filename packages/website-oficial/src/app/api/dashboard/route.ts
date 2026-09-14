/**
 * GET /api/dashboard?admin=0x… — the whole dashboard for one pension key, in
 * the shape src/mocks/types.ts fixes, as `{ source, data, notice }`.
 *
 * The page at `/` builds this on the server and does not need the route; this
 * exists so the same object can be refetched without a navigation (a client
 * poll after a pull lands, a second screen, a smoke check against a deployment)
 * and so the derivation has exactly one implementation — src/lib/dashboard.ts —
 * whichever way it is reached.
 *
 * 200 EVEN WHEN THE ANSWER IS THE MOCK. "This deployment has no ledger" and
 * "this key has no vault" are facts about the deployment, not failures of the
 * request; they arrive as `source: "mock"` with the reason in `notice`, the same
 * DISABLED-not-broken shape as /api/skims. The only non-2xx here is a malformed
 * address or a deployment with no configuration at all.
 *
 * NOTHING PRIVILEGED CROSSES THE WIRE. loadDashboard's notices are built from
 * redacted readers (src/lib/redact.ts, and the Postgres-specific pass in
 * dashboard.ts), and the config — which holds the keyed RPC URL and the
 * connection string — never leaves this function.
 */

import { getAddress, isAddress } from "viem";

import { EVM_ROUTE_OFF_MESSAGE, evmRouteGate, loadEvmConfig } from "@/lib/config";
import { loadDashboard } from "@/lib/dashboard";
import { jsonResponse } from "@/lib/serialize";

// DATABASE_URL and the RPC URL are read at request time, never at build time.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  // The EVM dashboard. Under SIP_CHAIN=solana it answers 404 until the Solana
  // loader lands here; nothing EVM is read.
  const gate = evmRouteGate(process.env);
  if (gate.kind === "solana") return jsonResponse({ error: EVM_ROUTE_OFF_MESSAGE }, 404);
  if (gate.kind === "invalid") {
    return jsonResponse({ error: "This deployment is not configured.", problems: [gate.problem] }, 503);
  }

  const admin = new URL(request.url).searchParams.get("admin")?.trim() ?? "";
  // strict: false — a pension key pasted lowercase names the same account as
  // the checksummed form /api/vault hands out.
  if (!isAddress(admin, { strict: false })) {
    return jsonResponse({ error: "`admin` must be an address." }, 400);
  }

  const load = loadEvmConfig(process.env, { needPrivyAppId: false });
  if (!load.ok) {
    return jsonResponse({ error: "This deployment is not configured.", problems: load.problems }, 503);
  }

  return jsonResponse(await loadDashboard(load.config, getAddress(admin)));
}
