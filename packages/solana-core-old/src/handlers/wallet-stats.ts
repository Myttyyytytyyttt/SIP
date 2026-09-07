// One trading wallet's measured stats — volume moved, profits settled into the
// vault, last time it did anything. POST { wallet, vault }.

import { loadSolanaConfig, readSolanaWalletStats, tryBase58Decode } from "../index";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleSolanaWalletStats(request: Request): Promise<Response> {
  const config = loadSolanaConfig(process.env);
  if (config.kind === "DISABLED") return json({ kind: "DISABLED" });
  if (config.kind === "INVALID") return json({ kind: "INVALID", problems: config.problems }, 503);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "The request body is not JSON." }, 400);
  }

  for (const field of ["wallet", "vault"] as const) {
    if (typeof body[field] !== "string" || tryBase58Decode(body[field] as string)?.length !== 32) {
      return json({ error: `\`${field}\` must be a base58 32-byte address.` }, 400);
    }
  }

  const stats = await readSolanaWalletStats(config, body.wallet as string, body.vault as string);
  return json({ kind: "OK", stats });
}
