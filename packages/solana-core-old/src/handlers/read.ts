// Reads one Nuvem Solana vault (the solana-lab experiment), server-side.
//
// SEPARATE FROM /api/dashboard ON PURPOSE. The lab must be able to be off,
// broken or redeployed without the main dashboard noticing, and this route's
// answer for "off" is an honest 200 with kind DISABLED — the DevPanel card
// renders that as text, because "the lab is not configured" is information,
// not an error.
//
// TWO WAYS IN. `{vault}` reads a pasted address — the lab's tests print
// addresses, and the reader card must accept ANY vault, not just yours.
// `{owner}` derives the vault PDA from a wallet and reads that, plus the
// CURRENT set of linked wallets: it exists so the onboarding card can tell a
// returning owner "you already have this vault" instead of offering to create
// what create_vault would refuse. Owner lookup used to be deferred because PDA
// derivation needed a real dependency; solana-tx.ts made web3.js a server-side
// resident, so the reason expired.

import { PublicKey } from "@solana/web3.js";

import { listVaultHoldings, listVaultLinks, loadSolanaConfig, parseSolanaStocks, readSolanaLink, readSolanaPolicy, readSolanaVault, tryBase58Decode, DEFAULT_SOLANA_STOCKS } from "../index";
import { deriveInvestPda, deriveLinkPda, deriveVaultPda } from "../index";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export async function handleSolanaRead(request: Request): Promise<Response> {
  const config = loadSolanaConfig(process.env);
  if (config.kind === "DISABLED") {
    return json({ kind: "DISABLED", detail: "NUVEM_SOLANA_RPC_URL / NUVEM_SOLANA_PROGRAM_ID are not set." });
  }
  if (config.kind === "INVALID") {
    // 503 like the dashboard's misconfiguration answer: configured-and-wrong
    // is an operator problem, never softened into "off".
    return json({ kind: "INVALID", problems: config.problems }, 503);
  }

  let vault: unknown;
  let link: unknown;
  let owner: unknown;
  let wallet: unknown;
  let wallets: unknown;
  try {
    ({ vault, link, owner, wallet, wallets } = (await request.json()) as {
      vault?: unknown;
      link?: unknown;
      owner?: unknown;
      wallet?: unknown;
      wallets?: unknown;
    });
  } catch {
    return json({ error: "The request body is not JSON." }, 400);
  }

  // Owner mode: derive the vault PDA, read it, and list its linked wallets.
  if (owner !== undefined) {
    if (typeof owner !== "string" || tryBase58Decode(owner)?.length !== 32) {
      return json({ error: "`owner` must be a base58 32-byte address." }, 400);
    }
    // Optional TRADING wallets. Each link PDA — ["link", wallet] — is GLOBAL: a
    // wallet links to exactly one vault, ever, so whether THIS vault's list
    // contains it is not the whole answer. The card needs the global one per
    // wallet to avoid offering a link the chain must refuse.
    //
    // A LIST, because a trader runs a bundle. `wallet` stays accepted as the
    // one-element form.
    const requested: string[] = [];
    if (typeof wallet === "string") requested.push(wallet);
    if (Array.isArray(wallets)) {
      for (const entry of wallets) {
        if (typeof entry === "string") requested.push(entry);
      }
    }
    if (requested.length > 32) {
      return json({ error: "at most 32 wallets may be asked about at once" }, 400);
    }
    for (const address of requested) {
      if (tryBase58Decode(address)?.length !== 32) {
        return json({ error: `"${address.slice(0, 12)}…" is not a base58 32-byte address.` }, 400);
      }
    }
    const programId = new PublicKey(config.programId);
    const vaultPda = deriveVaultPda(programId, new PublicKey(owner));
    const vaultAddress = vaultPda.toBase58();
    const stocks = parseSolanaStocks(process.env.NUVEM_SOLANA_STOCKS ?? DEFAULT_SOLANA_STOCKS).stocks;
    const [read, links, walletLinkReads, policyRead, holdings] = await Promise.all([
      readSolanaVault(config, vaultAddress),
      listVaultLinks(config, vaultAddress),
      Promise.all(
        requested.map(async (address) => ({
          address,
          read: await readSolanaLink(config, deriveLinkPda(programId, new PublicKey(address)).toBase58()),
        })),
      ),
      // The investment policy: same tri-state discipline as vaultExists — the
      // card must distinguish "no basket chosen yet" from "could not read".
      readSolanaPolicy(config, deriveInvestPda(programId, vaultPda).toBase58()),
      // What the savings BECAME. Without this the owner would have to know a
      // mint address to withdraw a stock they never chose to hold by address.
      listVaultHoldings(config, vaultAddress, stocks),
    ]);

    // THREE-VALUED ON PURPOSE. true: the vault account decoded. false: the
    // chain answered and nothing is there. null: the read FAILED — and a
    // failure must never be presented as absence, because "no vault yet,
    // create one" about an owner who has one sends the tester into an
    // on-chain refusal that reads like a bug.
    const vaultExists = read.state.ok ? true : read.state.missing === true ? false : null;

    // Per wallet, keyed by the TRADING wallet address the caller asked about
    // (not the link PDA, which the caller never has). Tri-state as everywhere:
    // linked / not linked / could not be read.
    const walletLinks = walletLinkReads.map((entry) => ({
      wallet: entry.address,
      linkAddress: entry.read.address,
      linked: entry.read.state.ok ? true : entry.read.state.missing === true ? false : null,
      vault: entry.read.state.ok ? entry.read.state.value.vault : null,
    }));
    // The one-wallet shape, preserved for callers that asked with `wallet`.
    const walletLink =
      typeof wallet === "string"
        ? (walletLinks.find((entry) => entry.wallet === wallet) ?? null)
        : null;

    const policyExists = policyRead.state.ok ? true : policyRead.state.missing === true ? false : null;

    return json({
      kind: "OK",
      programId: config.programId,
      vaultAddress,
      vaultExists,
      read,
      links,
      walletLink,
      walletLinks,
      holdings,
      policyAddress: policyRead.address,
      policyExists,
      policy: policyRead,
    });
  }

  if (typeof vault !== "string" || vault.length === 0 || vault.length > 64) {
    return json({ error: "`vault` must be a base58 address string." }, 400);
  }
  if (link !== undefined && (typeof link !== "string" || link.length === 0 || link.length > 64)) {
    return json({ error: "`link` must be a base58 address string when present." }, 400);
  }

  // The link is optional: the vault stands alone, but the settle cursor —
  // nonce and frontier — lives on the link, and watching it advance after each
  // drill run is what "the flow works" looks like from the outside.
  const [read, linkRead] = await Promise.all([
    readSolanaVault(config, vault),
    typeof link === "string" ? readSolanaLink(config, link) : Promise.resolve(null),
  ]);
  return json({ kind: "OK", programId: config.programId, read, linkRead });
}
