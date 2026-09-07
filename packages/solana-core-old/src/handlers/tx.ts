// Builds and broadcasts solana-lab transactions for the onboarding card.
//
// THE SERVER NEVER SIGNS. `build` returns an unsigned transaction naming its
// required signers; the browser signs with the user's Privy Solana wallets and
// posts the signed bytes back through `send`. The split keeps @solana/web3.js
// out of the client bundle and every key out of this process.

import { PublicKey } from "@solana/web3.js";

import { BUILTIN_SOLANA_POOLS, loadSolanaConfig, parseSolanaPolicyDefaults } from "../index";
import { parsePoolRegistry, rawRateWad, readPoolPrices, USDC_MINT, WSOL_MINT } from "../pricing";
import { buildCreateVault, buildLinkWallet, buildSetInvestPolicy, buildSetPolicy, buildUnlinkWallet, buildWithdraw, buildWithdrawToken } from "../index";
import { poolRpc } from "../rpc-pool";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function rpc(urls: readonly string[], method: string, params: unknown[]): Promise<unknown> {
  return poolRpc(urls, method, params);
}

const pubkey = (raw: unknown): PublicKey | null => {
  if (typeof raw !== "string") return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
};

/**
 * How far below the live market the OWNER-SIGNED floors are set, in bps.
 *
 * A CONSTANT, NOT AN ENVIRONMENT VARIABLE, deliberately. It is a safety floor,
 * not an operational knob, and this deployment has already lost a wallet to a
 * mistyped Privy id in an env var — every additional variable is another value
 * that can be pasted wrong into a place nobody reads.
 *
 * WHY 1500 AND NOT 200. The floor is signed ONCE and then sits on chain for the
 * life of the policy while the market moves underneath it; the keeper applies
 * its own, much tighter per-call `min_out` on every actual trade (the program
 * allows tighter, never looser). So this number's job is to survive weeks of
 * ordinary drift without stranding a vault, while still bounding what a bad
 * route can take. 15% does both. The floors it replaces were ~85% and ~99.8%
 * below market and were never meant to leave the drill.
 */
const FLOOR_SLIPPAGE_BPS = 1500n;

const haircut = (wad: bigint): bigint => (wad * (10_000n - FLOOR_SLIPPAGE_BPS)) / 10_000n;

/**
 * Live floors for a basket, or the mints that could not be quoted.
 *
 * REFUSES RATHER THAN FALLING BACK. A constant here is what made every policy
 * this app ever wrote drainable: `minConvertRateWad` was pinned at a $30/SOL
 * floor and `minOutRateWad` at ~460x below the NVDAx rate, and because they
 * were constants nothing ever noticed. There is no fallback in this function on
 * purpose — an unquotable leg means the user is not asked to sign anything.
 */
async function liveFloors(
  rpcUrls: readonly string[],
  legMints: readonly string[],
): Promise<
  | { ok: true; convertWad: bigint; legWad: ReadonlyMap<string, bigint> }
  | { ok: false; problems: readonly string[] }
> {
  const poolFor = parsePoolRegistry(process.env.NUVEM_SOLANA_POOLS ?? BUILTIN_SOLANA_POOLS);
  // THE wSOL POOL FALLS BACK TO THE BUILTIN, THE LEGS DO NOT — and the asymmetry
  // is deliberate. NUVEM_SOLANA_POOLS is the operator's TRADING registry: a
  // deployment that pins it to the two stocks it actually trades is making a
  // statement about stocks, not about whether SOL has a price. Without this
  // fallback that narrow, entirely reasonable setting refused EVERY policy with
  // "no wSOL/USDC pool is registered" — caught by running this against the real
  // .env.mainnet, which is exactly such a registry. The legs stay strict on
  // purpose: a leg with no pool is one the keeper would refuse to buy anyway,
  // so refusing to sign for it is the honest answer, not a regression.
  const wsolPool =
    process.env.NUVEM_SOLANA_WSOL_POOL?.trim() ||
    poolFor.get(WSOL_MINT) ||
    parsePoolRegistry(BUILTIN_SOLANA_POOLS).get(WSOL_MINT);

  const problems: string[] = [];
  const needed = new Set<string>();
  if (wsolPool === undefined || wsolPool === "") {
    problems.push("no wSOL/USDC pool is registered, so the SOL conversion floor cannot be quoted");
  } else {
    needed.add(wsolPool);
  }
  for (const mint of legMints) {
    const pool = poolFor.get(mint);
    if (pool === undefined) problems.push(`no pool is registered for ${mint}`);
    else needed.add(pool);
  }
  if (problems.length > 0) return { ok: false, problems };

  const prices = await readPoolPrices(rpcUrls, [...needed]);
  if (!prices.ok) return { ok: false, problems: [`the pools could not be read (${prices.error})`] };

  const wsolPrice = prices.value.get(wsolPool as string);
  const convertRate = wsolPrice === undefined ? null : rawRateWad(WSOL_MINT, USDC_MINT, wsolPrice);
  if (convertRate === null) {
    return { ok: false, problems: ["the wSOL/USDC pool did not decode to a price"] };
  }

  const legWad = new Map<string, bigint>();
  for (const mint of legMints) {
    const price = prices.value.get(poolFor.get(mint) as string);
    // USDC in, the stock out — the direction `invest` actually trades.
    const rate = price === undefined ? null : rawRateWad(USDC_MINT, mint, price);
    if (rate === null) problems.push(`the pool for ${mint} did not decode to a price`);
    else legWad.set(mint, haircut(rate));
  }
  if (problems.length > 0) return { ok: false, problems };

  return { ok: true, convertWad: haircut(convertRate), legWad };
}

export async function handleSolanaTx(request: Request): Promise<Response> {
  const config = loadSolanaConfig(process.env);
  if (config.kind === "DISABLED") return json({ error: "The Solana lab is not configured." }, 503);
  if (config.kind === "INVALID") return json({ error: config.problems.join("; ") }, 503);
  const programId = new PublicKey(config.programId);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "The request body is not JSON." }, 400);
  }

  try {
    if (body.action === "send") {
      if (typeof body.signedTxBase64 !== "string") return json({ error: "signedTxBase64 is required." }, 400);
      const signature = (await rpc(config.rpcUrls, "sendTransaction", [
        body.signedTxBase64,
        { encoding: "base64", preflightCommitment: "confirmed" },
      ])) as string;
      // Poll briefly so the card can read fresh state right after.
      for (let i = 0; i < 20; i++) {
        const statuses = (await rpc(config.rpcUrls, "getSignatureStatuses", [[signature]])) as {
          value: ({ confirmationStatus?: string; err?: unknown } | null)[];
        };
        const status = statuses.value[0];
        if (status?.err) return json({ error: `transaction failed: ${JSON.stringify(status.err)}`, signature }, 400);
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
          return json({ signature });
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return json({ signature, warning: "broadcast, but confirmation was not observed in time" });
    }

    const owner = pubkey(body.owner);
    if (owner === null) return json({ error: "`owner` must be a base58 pubkey." }, 400);
    // getLatestBlockhash answers {context, value:{blockhash,...}} — the hash is
    // NESTED. Destructuring it from the top level yielded undefined, and the
    // failure surfaced far away as web3.js's "Transaction recentBlockhash
    // required" when serialize() hit an unsigned, unanchored transaction.
    const latest = (await rpc(config.rpcUrls, "getLatestBlockhash", [
      { commitment: "confirmed" },
    ])) as { value?: { blockhash?: string } };
    const blockhash = latest.value?.blockhash;
    if (typeof blockhash !== "string") {
      return json({ error: "the RPC returned no blockhash; nothing was built" }, 502);
    }

    if (body.action === "buildCreateVault") {
      const skimBps = Number(body.skimBps);
      if (!Number.isInteger(skimBps) || skimBps < 1 || skimBps > 10_000) {
        return json({ error: "skimBps must be an integer in [1, 10000]." }, 400);
      }
      return json(buildCreateVault(programId, owner, skimBps, blockhash));
    }
    if (body.action === "buildSetInvestPolicy") {
      // TWO SHAPES, ONE MEANING. `legs: [{mint, weightBps}]` is the basket;
      // `mint` alone remains accepted as a 1-leg basket at 100% so nothing that
      // already calls this breaks. Floors per leg are the platform's, below.
      const rawLegs: unknown = Array.isArray(body.legs)
        ? body.legs
        : typeof body.mint === "string"
          ? [{ mint: body.mint, weightBps: 10_000 }]
          : null;
      if (!Array.isArray(rawLegs) || rawLegs.length === 0 || rawLegs.length > 8) {
        return json({ error: "`legs` must be 1..8 of {mint, weightBps} (or pass a single `mint`)." }, 400);
      }
      const legs: { mint: PublicKey; weightBps: number }[] = [];
      for (const raw of rawLegs as { mint?: unknown; weightBps?: unknown }[]) {
        const legMint = pubkey(raw.mint);
        const weight = Number(raw.weightBps);
        if (legMint === null) return json({ error: "every leg needs `mint`, a base58 pubkey." }, 400);
        if (!Number.isInteger(weight) || weight <= 0 || weight > 10_000) {
          return json({ error: "every leg needs `weightBps`, an integer in 1..10000." }, 400);
        }
        legs.push({ mint: legMint, weightBps: weight });
      }
      if (legs.reduce((sum, leg) => sum + leg.weightBps, 0) !== 10_000) {
        return json({ error: "leg weights must sum to exactly 10000 bps." }, 400);
      }
      if (new Set(legs.map((leg) => leg.mint.toBase58())).size !== legs.length) {
        return json({ error: "a basket cannot repeat a mint." }, 400);
      }

      // Caps arrive as whole USDC dollars from the card and become raw 1e6
      // here — one conversion, server-side, so the card never does money math.
      const usdc = (raw: unknown, fallback: number): bigint | null => {
        const value = raw === undefined ? fallback : Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 1_000_000) return null;
        return BigInt(value) * 1_000_000n;
      };
      // THE PLATFORM'S POLICY, defined once in lib/solana.ts and explained
      // there. The card sends only the mint; these are ours. Per-request
      // overrides stay accepted for testing and never reach the UI.
      const { defaults, problems: defaultProblems } = parseSolanaPolicyDefaults(
        process.env.NUVEM_SOLANA_POLICY_DEFAULTS,
      );
      if (defaultProblems.length > 0) {
        // A misconfigured platform default must not quietly become the builtin
        // one HERE: the operator asked for something specific and this is a
        // transaction someone is about to sign.
        return json({ error: `NUVEM_SOLANA_POLICY_DEFAULTS: ${defaultProblems.join("; ")}` }, 503);
      }
      const minInvestment = usdc(body.minInvestmentUsdc, defaults.minInvestmentUsdc);
      const maxPerCall = usdc(body.maxPerCallUsdc, defaults.maxPerCallUsdc);
      const maxRolling30d = usdc(body.maxRolling30dUsdc, defaults.maxRolling30dUsdc);
      if (minInvestment === null || maxPerCall === null || maxRolling30d === null) {
        return json({ error: "caps must be whole USDC amounts between 1 and 1000000" }, 400);
      }
      // The program refuses min > perCall > rolling on chain; failing here just
      // turns a wallet-signed refusal into an immediate, explained one.
      if (!(minInvestment <= maxPerCall && maxPerCall <= maxRolling30d)) {
        return json({ error: "caps must satisfy min ≤ per-call ≤ 30-day" }, 400);
      }

      // QUOTED LIVE, AND THE POLICY IS NOT BUILT IF THEY CANNOT BE.
      //
      // These floors used to be constants — a $30/SOL conversion floor and a
      // per-leg floor ~460x under market — carried over from the drill. On
      // chain, `convert` takes a bare `crank: Signer` and charges no rolling
      // bucket, so ANY anonymous account could route a vault's SOL through a
      // pool it controlled and keep everything above those floors. The floors
      // are the only thing standing between a funded vault and a stranger
      // until the program's crank is constrained, so they are now read from
      // the same pools the portfolio prices from, and a quote that cannot be
      // had stops the signature instead of falling back to a number.
      const floors = await liveFloors(config.rpcUrls, legs.map((leg) => leg.mint.toBase58()));
      if (!floors.ok) {
        return json(
          {
            error:
              `The basket cannot be priced right now, so nothing was prepared to sign: ${floors.problems.join("; ")}.`,
          },
          503,
        );
      }

      return json(
        buildSetInvestPolicy(
          programId,
          owner,
          {
            legs: legs.map((leg) => ({
              ...leg,
              minOutRateWad: floors.legWad.get(leg.mint.toBase58()) as bigint,
            })),
            minConvertRateWad: floors.convertWad,
            minInvestment,
            maxPerCall,
            maxRolling30d,
            enabled: true,
          },
          blockhash,
        ),
      );
    }
    if (body.action === "buildWithdraw") {
      // Amount in LAMPORTS as a decimal string: a JS number cannot carry u64,
      // and this one is money.
      let lamports: bigint;
      try {
        lamports = BigInt(String(body.lamports));
      } catch {
        return json({ error: "`lamports` must be a whole number as a string." }, 400);
      }
      if (lamports <= 0n) return json({ error: "`lamports` must be above zero." }, 400);
      return json(buildWithdraw(programId, owner, lamports, blockhash));
    }
    if (body.action === "buildWithdrawToken") {
      const mint = pubkey(body.mint);
      if (mint === null) return json({ error: "`mint` must be a base58 pubkey." }, 400);
      // The token program is NOT assumed: stocks are Token-2022, USDC and wSOL
      // are classic SPL, and a transfer built against the wrong one fails. The
      // caller reads it from the holdings the chain reported.
      const tokenProgram = pubkey(body.tokenProgram);
      if (tokenProgram === null) return json({ error: "`tokenProgram` must be a base58 pubkey." }, 400);
      let amountRaw: bigint;
      try {
        amountRaw = BigInt(String(body.amountRaw));
      } catch {
        return json({ error: "`amountRaw` must be a whole number as a string." }, 400);
      }
      if (amountRaw <= 0n) return json({ error: "`amountRaw` must be above zero." }, 400);
      return json(buildWithdrawToken(programId, owner, mint, tokenProgram, amountRaw, blockhash));
    }
    if (body.action === "buildUnlinkWallet") {
      const wallet = pubkey(body.wallet);
      if (wallet === null) return json({ error: "`wallet` must be a base58 pubkey." }, 400);
      return json(buildUnlinkWallet(programId, owner, wallet, blockhash));
    }
    if (body.action === "buildSetPolicy") {
      // BOTH fields, always. The instruction writes skim and pause together, so
      // accepting one and defaulting the other would silently un-pause a vault
      // whose owner only meant to change their savings rate.
      const skimBps = Number(body.skimBps);
      if (!Number.isInteger(skimBps) || skimBps < 1 || skimBps > 10_000) {
        return json({ error: "skimBps must be an integer in [1, 10000]; zero is refused on chain." }, 400);
      }
      if (typeof body.paused !== "boolean") {
        return json({ error: "`paused` must be true or false — the instruction writes it either way." }, 400);
      }
      return json(buildSetPolicy(programId, owner, skimBps, body.paused, blockhash));
    }
    if (body.action === "buildLinkWallet") {
      const wallet = pubkey(body.wallet);
      if (wallet === null) return json({ error: "`wallet` must be a base58 pubkey." }, 400);
      return json(buildLinkWallet(programId, owner, wallet, blockhash));
    }
    return json({ error: "unknown action" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}
