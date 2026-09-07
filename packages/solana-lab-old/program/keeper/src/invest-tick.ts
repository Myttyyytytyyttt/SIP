// One investment turn for one vault: wrap what settled, convert it, buy the leg.
//
// THE CRANK OWNS NO AUTHORITY. Every bound — the venue, the floors, the caps —
// lives in policy state the vault owner signed; this only picks the moment and
// supplies a live route. That is why it needs no Privy signer, unlike settle:
// the vault PDA signs its own movements inside the program.
//
// IT IS DELIBERATELY LAZY. Below a threshold it does nothing: three pool fees
// and three transaction fees to move dust is a worse outcome for the user than
// waiting for the next session. The threshold is the policy's own
// min_investment, read from the chain rather than configured here twice.

import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { fetchLiveRoute } from "../../scripts/live-route";
import { tightenMinOut } from "./min-out";
import { buildSwapV2AccountMetas, buildSwapV2Data, RAYDIUM_CLMM } from "../../scripts/raydium-swap";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_USDC_POOL = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");

export type InvestOutcome = "IDLE" | "NO_POLICY" | "INVESTED" | "REFUSED" | "FAILED";

export interface InvestResult {
  readonly outcome: InvestOutcome;
  readonly detail: string;
  /**
   * EVERY purchase that confirmed, one per leg, carried out so the supervisor
   * records history from what was MEASURED here, never from what was intended.
   * Present on INVESTED — and on FAILED too, when legs confirmed before the
   * basket broke: a 5-leg basket that died on leg 3 still moved real money on
   * legs 1 and 2, and history that drops a confirmed on-chain purchase because
   * a LATER one failed is history that lies.
   */
  readonly purchases?: readonly {
    readonly target: string;
    readonly spentRaw: bigint;
    readonly receivedRaw: bigint;
    readonly signature: string;
    readonly slot: bigint;
  }[];
}

export interface InvestDeps {
  readonly connection: Connection;
  readonly program: anchor.Program;
  readonly vault: PublicKey;
  readonly crank: Keypair;
  /** Pool for each investable mint, from the operator's registry. */
  readonly pools: ReadonlyMap<string, PublicKey>;
  readonly live: boolean;
}

export async function runInvestTick(deps: InvestDeps): Promise<InvestResult> {
  const { connection, program, vault, crank } = deps;
  const [policyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("invest"), vault.toBuffer()],
    program.programId,
  );

  // The generic Program<Idl> has no typed account namespace; the runtime one
  // does. Cast at the boundary rather than threading the generated type here.
  const accounts = program.account as unknown as Record<string, { fetchNullable(a: PublicKey): Promise<any> }>;
  const policy = await accounts.investmentPolicy!.fetchNullable(policyPda);
  if (policy === null) return { outcome: "NO_POLICY", detail: "the owner has not chosen a basket yet" };
  if (!policy.enabled) return { outcome: "IDLE", detail: "investing is switched off in the policy" };

  const vaultInfo = await connection.getAccountInfo(vault);
  if (vaultInfo === null) return { outcome: "FAILED", detail: "vault account missing" };
  const rentFloor = await connection.getMinimumBalanceForRentExemption(vaultInfo.data.length);
  const free = BigInt(vaultInfo.lamports - rentFloor);

  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
  // WHAT IS ALREADY WRAPPED COUNTS. wrap and convert are two transactions, so a
  // convert that reverts — on slippage, on congestion, on a dropped RPC —
  // leaves the vault's SOL sitting as wSOL. Nothing here used to read this
  // balance: every convert moved only the amount freshly wrapped in the same
  // tick, so that stranded wSOL was never converted again, by any later sweep,
  // ever. The next tick would report "0 free lamports and 0 USDC" and go quiet,
  // which was false — the money was in this account.
  const wsolHeld = await balanceOf(connection, wsolAta);
  const usdcAta = getAssociatedTokenAddressSync(USDC, vault, true, TOKEN_PROGRAM_ID);
  const usdcHeld = await balanceOf(connection, usdcAta);

  // The floor is the policy's own minimum, in USDC. Convert what is free only
  // if doing so could plausibly clear it — at ~$100/SOL, 0.01 SOL is ~$1.
  const minInvestment = BigInt(policy.minInvestment.toString());
  if (free < 5_000_000n && wsolHeld === 0n && usdcHeld < minInvestment) {
    return {
      outcome: "IDLE",
      detail: `${free} free lamports, ${wsolHeld} wSOL and ${usdcHeld} USDC — below the policy minimum`,
    };
  }
  if (!deps.live) {
    return { outcome: "INVESTED", detail: `DRY RUN — would wrap ${free} lamports and invest` };
  }

  // A MISSING POOL REFUSES THE WHOLE BASKET — and it refuses BEFORE the
  // convert, not after. The old order wrapped and market-sold the vault's SOL
  // into USDC first and only then noticed the basket was unroutable, so a
  // policy the keeper's registry could not serve would sell the owner's SOL
  // exposure on every sweep in service of a purchase that was knowably
  // impossible before the swap. Nothing below this line moves money until the
  // whole basket has a route.
  const unroutable = policy.legs
    .map((leg: { mint: PublicKey }) => new PublicKey(leg.mint).toBase58())
    .filter((mint: string) => !deps.pools.has(mint));
  if (unroutable.length > 0) {
    return {
      outcome: "REFUSED",
      detail: `no pool configured for ${unroutable.join(", ")} — refusing to guess, refusing a partial basket, and refusing to convert SOL toward it`,
    };
  }

  const purchases: { target: string; spentRaw: bigint; receivedRaw: bigint; signature: string; slot: bigint }[] = [];
  try {
    // ── wrap + convert, if there is free SOL worth moving ──────────────────
    if (free >= 5_000_000n || wsolHeld > 0n) {
      await createAssociatedTokenAccountIdempotent(connection, crank, NATIVE_MINT, vault, undefined, TOKEN_PROGRAM_ID, undefined, true);
      await createAssociatedTokenAccountIdempotent(connection, crank, USDC, vault, undefined, TOKEN_PROGRAM_ID, undefined, true);
      // Only if there is new SOL worth wrapping. Reaching here with free below
      // the threshold means we are here to rescue stranded wSOL, and the
      // program refuses a zero amount.
      if (free >= 5_000_000n) {
        await program.methods
          .wrapSol(new anchor.BN(free.toString()))
          .accountsPartial({
            crank: crank.publicKey, vault, vaultWsol: wsolAta,
            tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          })
          .signers([crank])
          .rpc();
      }

      // EVERYTHING THE VAULT HOLDS AS wSOL, re-read after the wrap so a balance
      // stranded by an earlier failed convert is swept up with the new one.
      const toConvert = await balanceOf(connection, wsolAta);
      if (toConvert === 0n) return { outcome: "IDLE", detail: "nothing wrapped to convert" };

      const route = await fetchLiveRoute(connection, WSOL_USDC_POOL, NATIVE_MINT, USDC, TOKEN_PROGRAM_ID);
      const convertFloor = (toConvert * BigInt(policy.minConvertRateWad.toString())) / 10n ** 18n;
      const { minOut } = tightenMinOut(toConvert, convertFloor, route.observed);
      const args = { payer: vault, inputTokenAccount: wsolAta, outputTokenAccount: usdcAta, amountIn: toConvert, minAmountOut: minOut };
      await sendWithBudget(program.provider as anchor.AnchorProvider, crank,
        await program.methods
          .convert(new anchor.BN(toConvert.toString()), new anchor.BN(minOut.toString()), buildSwapV2Data(args))
          .accountsPartial({ crank: crank.publicKey, vault, policy: policyPda, vaultWsol: wsolAta, vaultIn: usdcAta, venueProgram: RAYDIUM_CLMM })
          .remainingAccounts(buildSwapV2AccountMetas(route, args).map((m) => ({ ...m, isSigner: false })))
          .instruction());
    }

    // ── invest EVERY leg, by the weights the owner signed ─────────────────
    //
    // ONE TRANSACTION PER LEG, not one for the basket: state.rs says why — an
    // 8-leg basket cannot fit under the 64-account cap with a CLMM route per
    // leg. The program takes a leg INDEX for exactly this reason, and the
    // keeper used to pass 0 always, so a user who chose a basket got only its
    // first stock while the weights sat on chain being ignored.
    const usdc = await balanceOf(connection, usdcAta);
    if (usdc < minInvestment) {
      return { outcome: "IDLE", detail: `${usdc} USDC held, below policy minimum ${minInvestment}` };
    }

    const maxPerCall = BigInt(policy.maxPerCall.toString());
    const budget = usdc > maxPerCall ? maxPerCall : usdc;

    // THE PROGRAM CHECKS EACH LEG, NOT THE TOTAL.
    //
    // invest.rs requires `amount_in >= min_investment` on EVERY call, and a
    // basket splits the budget by weight — so a six-leg basket at a $5 minimum
    // needs $25 before even its largest leg qualifies, and $50 before its
    // smallest does. The check above compares only the TOTAL, so a vault
    // holding $7.48 sailed past it and then had all six of its transactions
    // refused by the program, one after another, every sweep, forever. The
    // Railway log filled with simulation dumps that named the amount and never
    // the arithmetic.
    //
    // ALL OR NOTHING, the same doctrine as the unroutable-leg refusal above:
    // buying only the legs that happen to clear the minimum is a partial basket
    // that silently drifts away from the weights the owner signed.
    const shares = policy.legs.map((leg: { weightBps: number }) => (budget * BigInt(leg.weightBps)) / 10_000n);
    const short = shares.filter((share: bigint) => share < minInvestment).length;
    if (short > 0) {
      // The number that is actually actionable is how much this basket needs,
      // not which leg fell short — so it is computed and stated.
      const heaviest = policy.legs.reduce((a: number, leg: { weightBps: number }) => Math.max(a, leg.weightBps), 0);
      const lightest = policy.legs.reduce((a: number, leg: { weightBps: number }) => Math.min(a, leg.weightBps), 10_000);
      const usd = (raw: bigint) => `$${(Number(raw) / 1e6).toFixed(2)}`;
      const needed = (bps: number) => usd((minInvestment * 10_000n) / BigInt(bps));
      return {
        outcome: "IDLE",
        detail:
          `${usd(usdc)} across ${policy.legs.length} legs is ${usd(shares[0] ?? 0n)}-ish each, under the ` +
          `${usd(minInvestment)} per-call minimum (${short} of ${policy.legs.length} legs short). ` +
          `This basket needs ${needed(heaviest)} for its largest leg to qualify and ${needed(lightest)} for all of them. ` +
          `Lower the minimum or hold fewer stocks to invest smaller amounts.`,
      };
    }

    const filled: string[] = [];
    let anyLive = false;
    for (const [index, leg] of policy.legs.entries()) {
      const weight = BigInt(leg.weightBps);
      const amountIn = (budget * weight) / 10_000n;
      // A leg whose share rounds to nothing is skipped rather than sent: the
      // program refuses a zero min_out, and a zero-amount swap is a fee for
      // nothing.
      if (amountIn === 0n) continue;

      const mint = new PublicKey(leg.mint);
      const pool = deps.pools.get(mint.toBase58())!;
      const targetAta = await createAssociatedTokenAccountIdempotent(connection, crank, mint, vault, undefined, TOKEN_2022_PROGRAM_ID, undefined, true);

      const route = await fetchLiveRoute(connection, pool, USDC, mint, TOKEN_2022_PROGRAM_ID);
      const investFloor = (amountIn * BigInt(leg.minOutRateWad.toString())) / 10n ** 18n;
      const { minOut, live } = tightenMinOut(amountIn, investFloor, route.observed);
      anyLive = anyLive || live;

      const args = { payer: vault, inputTokenAccount: usdcAta, outputTokenAccount: targetAta, amountIn, minAmountOut: minOut };
      const before = await balanceOf(connection, targetAta);
      const signature = await sendWithBudget(program.provider as anchor.AnchorProvider, crank,
        await program.methods
          .invest(index, new anchor.BN(amountIn.toString()), new anchor.BN(minOut.toString()), buildSwapV2Data(args))
          .accountsPartial({ crank: crank.publicKey, vault, policy: policyPda, vaultIn: usdcAta, vaultTarget: targetAta, targetMint: mint, venueProgram: RAYDIUM_CLMM })
          .remainingAccounts(buildSwapV2AccountMetas(route, args).map((m) => ({ ...m, isSigner: false })))
          .instruction());
      const bought = (await balanceOf(connection, targetAta)) - before;
      filled.push(`${Number(weight) / 100}% ${mint.toBase58().slice(0, 8)}… ${amountIn}→${bought}`);
      purchases.push({
        target: mint.toBase58(),
        spentRaw: amountIn,
        receivedRaw: bought,
        signature,
        slot: BigInt(await connection.getSlot("confirmed")),
      });
    }

    if (filled.length === 0) {
      return { outcome: "IDLE", detail: `${budget} USDC splits to nothing across ${policy.legs.length} leg(s)` };
    }
    return {
      outcome: "INVESTED",
      detail:
        `bought ${filled.join(" · ")}` +
        (anyLive
          ? " (min_out from a live observed price)"
          : " (min_out is the POLICY FLOOR — no live price was observable)"),
      purchases,
    };
  } catch (error) {
    return {
      outcome: "FAILED",
      detail: error instanceof Error ? error.message : String(error),
      // The legs that confirmed before the failure are REAL: signatures on
      // chain, USDC spent. They go into history even though the basket broke.
      purchases: purchases.length > 0 ? purchases : undefined,
    };
  }
}

async function balanceOf(connection: Connection, ata: PublicKey): Promise<bigint> {
  try {
    const res = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(res.value.amount);
  } catch {
    return 0n;
  }
}

async function sendWithBudget(
  provider: anchor.AnchorProvider,
  crank: Keypair,
  instruction: anchor.web3.TransactionInstruction,
): Promise<string> {
  // A LIMIT WITHOUT A PRICE IS NOT A BID. Setting only the unit limit told the
  // scheduler how much room to reserve and offered nothing for it, so under
  // congestion these transactions are deprioritised and dropped — and there is
  // no retry anywhere. The price is small in absolute terms (600k units at
  // 10_000 micro-lamports is ~0.006 SOL) and buys inclusion when it matters.
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }))
    .add(instruction);
  return provider.sendAndConfirm(tx, [crank]);
}
