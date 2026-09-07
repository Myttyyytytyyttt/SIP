// "Will my wallet actually settle?" — answered server-side, from the chain.
//
// SEPARATE FROM /api/solana ON PURPOSE. That route reports STATE; this one
// reports a JUDGEMENT about that state, and the two have different failure
// modes: a dashboard that cannot read a balance still shows the rest, while a
// checklist missing one answer must say so rather than render a shorter list of
// ticks. Keeping them apart means neither degrades the other.

import { PublicKey } from "@solana/web3.js";

import { buildSolanaChecks, buildSolanaVerdict } from "../index";
import {
  DEFAULT_SOLANA_STOCKS,
  loadSolanaConfig,
  parseSolanaStocks,
  readSolanaLink,
  readSolanaPolicy,
  readSolanaVault,
  tryBase58Decode,
} from "../index";
import { deriveInvestPda, deriveLinkPda, deriveVaultPda } from "../index";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Has this wallet granted the keeper's session signer?
 *
 * NOT ON CHAIN, and the single most consequential thing this checklist can
 * report: a wallet without it is discovered by the keeper and refused by Privy
 * on every sweep, forever, while every on-chain check passes. It bit this
 * project already.
 *
 * OPTIONAL BY DESIGN. Answering it needs the Privy app SECRET, which this
 * surface deliberately does not carry — the web holds the app id and nothing
 * that can act. An operator who wants the check sets PRIVY_APP_SECRET here and
 * accepts that; absent it, the checklist says "not verified" and explains why,
 * which is the honest answer and never a tick.
 *
 * Returns null for "could not check", with the reason.
 */
async function checkSignerGranted(
  wallet: string,
  expectedSignerId: string | undefined,
): Promise<{ granted: boolean | null; detail: string }> {
  const appId = process.env.PRIVY_APP_ID?.trim();
  const appSecret = process.env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    return {
      granted: null,
      detail: "this deployment does not hold the Privy app secret, so the grant cannot be read from here",
    };
  }
  if (!expectedSignerId) {
    return { granted: null, detail: "NUVEM_SOLANA_SIGNER_ID is not set, so there is no signer to look for" };
  }

  try {
    // Direct REST rather than the node SDK: one paginated GET does not justify
    // adding a signing-capable dependency to the surface that serves pages.
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL("https://api.privy.io/v1/wallets");
      url.searchParams.set("chain_type", "solana");
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);

      const response = await fetch(url, {
        headers: {
          authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
          "privy-app-id": appId,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return { granted: null, detail: `Privy answered HTTP ${response.status}` };
      }
      const body = (await response.json()) as {
        data?: readonly { address?: string; additional_signers?: readonly { signer_id?: string }[] }[];
        next_cursor?: string | null;
      };
      const found = (body.data ?? []).find((entry) => entry.address === wallet);
      if (found !== undefined) {
        const granted = (found.additional_signers ?? []).some((signer) => signer.signer_id === expectedSignerId);
        return {
          granted,
          detail: granted
            ? "the keeper's signer is registered on this wallet"
            : "this wallet has granted no keeper signer",
        };
      }
      if (!body.next_cursor) break;
      cursor = body.next_cursor;
    }
    return { granted: null, detail: "this address is not a Privy wallet in this app" };
  } catch (error) {
    // The URL and credentials never travel into the message.
    return { granted: null, detail: `the Privy lookup failed (${error instanceof Error ? error.name : "unknown"})` };
  }
}

export async function handleSolanaDiagnostics(request: Request): Promise<Response> {
  const config = loadSolanaConfig(process.env);
  if (config.kind === "DISABLED") return json({ kind: "DISABLED" });
  if (config.kind === "INVALID") return json({ kind: "INVALID", problems: config.problems }, 503);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "The request body is not JSON." }, 400);
  }

  const owner = body.owner;
  if (typeof owner !== "string" || tryBase58Decode(owner)?.length !== 32) {
    return json({ error: "`owner` must be a base58 32-byte address." }, 400);
  }
  // ONE or MANY. A trader runs a bundle, and "will my wallets settle?" is a
  // question about all of them — the vault-level checks are shared, only the
  // link and the signer differ, so the shared reads happen once for the set.
  const requested: string[] = [];
  if (typeof body.wallet === "string") requested.push(body.wallet);
  if (Array.isArray(body.wallets)) {
    for (const entry of body.wallets) if (typeof entry === "string") requested.push(entry);
  }
  if (requested.length > 32) return json({ error: "at most 32 wallets at once" }, 400);
  for (const address of requested) {
    if (tryBase58Decode(address)?.length !== 32) {
      return json({ error: `"${address.slice(0, 12)}…" is not a base58 32-byte address.` }, 400);
    }
  }

  const programId = new PublicKey(config.programId);
  const vaultPda = deriveVaultPda(programId, new PublicKey(owner));
  const vaultAddress = vaultPda.toBase58();

  // Shared across the whole bundle: read once, not once per wallet.
  const [vaultRead, policyRead] = await Promise.all([
    readSolanaVault(config, vaultAddress),
    readSolanaPolicy(config, deriveInvestPda(programId, vaultPda).toBase58()),
  ]);
  const perWalletReads = await Promise.all(
    requested.map(async (address) => ({
      address,
      link: await readSolanaLink(config, deriveLinkPda(programId, new PublicKey(address)).toBase58()),
      signer: await checkSignerGranted(address, process.env.NUVEM_SOLANA_SIGNER_ID?.trim() || undefined),
    })),
  );

  // ABSENT AND UNREADABLE ARE DIFFERENT, everywhere in this payload — the
  // checklist renders them differently and a conflation here would erase that.
  const stocks = parseSolanaStocks(process.env.NUVEM_SOLANA_STOCKS ?? DEFAULT_SOLANA_STOCKS).stocks;
  // UNSET IS NOT EMPTY. The registry lives in the keeper's environment; this
  // surface usually cannot see it, and an empty list would make the checklist
  // claim the keeper has no route for a stock it buys every day.
  const poolsRaw = process.env.NUVEM_SOLANA_POOLS?.trim() ?? "";
  const investablePools =
    poolsRaw === ""
      ? null
      : poolsRaw
          .split(",")
          .map((entry) => entry.trim().split("="))
          // BOTH halves must be real base58 addresses for the entry to count as
          // a route. The keeper refuses a malformed entry at startup BY NAME;
          // counting one here as routable would show a green "the keeper can
          // buy this" from a value that gives it no route at all.
          .filter((parts): parts is [string, string] =>
            parts.length === 2 && tryBase58Decode(parts[0]!.trim())?.length === 32 && tryBase58Decode(parts[1]!.trim())?.length === 32)
          .map((parts) => parts[0]!.trim());

  const shared = {
    vault: vaultRead.state.ok ? vaultRead.state.value : null,
    vaultReadFailed: !vaultRead.state.ok && vaultRead.state.missing !== true,
    vaultAddress,
    policy: policyRead.state.ok ? policyRead.state.value : null,
    policyReadFailed: !policyRead.state.ok && policyRead.state.missing !== true,
    investablePools,
    stocks,
  } as const;

  const build = (entry: (typeof perWalletReads)[number] | null) => {
    const checks = buildSolanaChecks({
      ...shared,
      link: entry?.link.state.ok ? entry.link.state.value : null,
      // Same distinction the vault and policy reads keep: only a chain-confirmed
      // absence is an absence; anything else is a failed read.
      linkReadFailed: entry !== null && !entry.link.state.ok && entry.link.state.missing !== true,
      wallet: entry?.address ?? null,
      signerGranted: entry?.signer.granted ?? null,
      signerDetail: entry?.signer.detail ?? null,
    });
    return { wallet: entry?.address ?? null, checks, verdict: buildSolanaVerdict(checks) };
  };

  const results = perWalletReads.length === 0 ? [build(null)] : perWalletReads.map(build);
  return json({
    kind: "OK",
    vaultAddress,
    results,
    // The single-wallet shape, kept for callers that asked with `wallet`.
    checks: results[0]?.checks ?? [],
    verdict: results[0]?.verdict ?? null,
  });
}
