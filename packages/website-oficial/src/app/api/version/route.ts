/**
 * GET /api/version — the commit this deployment runs, so a tab that loaded an
 * older bundle can tell (src/lib/build-version.ts, src/hooks/use-new-version.ts).
 *
 * It answers a public git commit id and nothing else: no configuration, no
 * environment, nothing that could be down. Never cached — a cached answer is
 * the old build's — and read per request, so the deployment answering is the
 * one named.
 */
import { servedCommit } from "@/lib/build-version";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ commit: servedCommit(process.env) }, { headers: { "cache-control": "no-store" } });
}
