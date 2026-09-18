// One investment turn for one vault: wrap what settled, convert it, buy the leg.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/invest-tick.ts). Seven
// things changed: the policy's in_mint is checked before anything moves, so are
// either pause switch, the 30-day cap and the owner's conversion floor, a wrap
// moves no more than the crank can front and a convert no more than convert.rs
// admits in one call (all six in invest-decision.ts), and the crank is null in
// a dry run, which never reaches a line that needs it. Everything else is the
// old behaviour, deliberately: the stranded-wSOL rescue, the refusal before
// convert on an unroutable basket, the all-or-nothing per-leg minimum, one
// transaction per leg, the compute budget price, and purchases recorded on
// FAILED too.
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

import type * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
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
import { summarizeUpstreamError } from "@sip/solana-log";
import { decodeVault, readInvestmentPolicy } from "./accounts.js";
import { BN } from "./anchor-interop.js";
import {
  CRANK_WRAP_RESERVE_LAMPORTS,
  USDC_MINT,
  WRAP_DUST_LAMPORTS,
  chainDay,
  convertAmount,
  convertDecision,
  inMintDecision,
  investPauseDecision,
  rollingDecision,
  shouldConvert,
  wrapPlan,
  type WrapPlan,
  type WrapReport,
} from "./invest-decision.js";
import { method, type MethodCall } from "./methods.js";
import { tightenMinOut } from "./min-out.js";
import { RAYDIUM_CLMM, type SwapV2Args, buildSwapV2AccountMetas, buildSwapV2Data, fetchLiveRoute } from "./program-scripts.js";

const USDC = USDC_MINT;
const WSOL_USDC_POOL = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");

// ── THE INVEST PATH'S THREE INSTRUCTIONS, AS FUNCTIONS A GATE CAN RUN ────────
//
// All three used to be written inline in investTurn, wrapped around the .rpc()
// or .instruction() that sends them, which put them out of reach of anything
// without a chain, a crank and a funded vault. So the preflight — the one gate
// that runs in a REAL Node process, and therefore the only kind that can see a
// CommonJS/ESM interop bug — reached settle_v2 through the keeper's own
// settleInstruction and reached these three through a hand-written COPY inside
// preflight.ts. A copy only ever proves the copy works.
//
// MEASURED ON THIS BRANCH, both spellings, with the fix reverted here only:
//   a `new anchor.BN` at the three sites → tsc exits 0, `tsx bin/keeper.mts
//   --preflight` prints {"preflight":"ok","invariants":14}; the image builds and
//   the keeper throws "anchor.BN is not a constructor" on the first invest —
//   2026-09-18's outage, one file over. Only the grep in
//   test/anchor-interop.test.ts catches it, and only that literal spelling:
//   written as `const { BN: NumberBN } = anchor`, typecheck, preflight AND the
//   full 371-test suite are all green, while a real Node process from this
//   package prints `destructured BN = undefined`.
//
// Extracted, the preflight runs THESE functions and compares the bytes they
// build against fixed vectors. The arguments can no longer throw in production
// while every gate is green, arrive from a foreign bn.js, or change width
// unnoticed.
//
// THEY RETURN THE CALL, NOT THE INSTRUCTION, deliberately: the wrap is sent
// with .signers([crank]).rpc() and the other two with .instruction() into
// sendWithBudget. Handing back the fully-argued call leaves every byte of what
// production sends exactly as it was — and .instruction(), which is what the
// preflight calls, is what .rpc() reaches for internally anyway.

/** wrap_sol: `lamports` of the vault's own SOL into the vault's wSOL account. */
export function wrapSolCall(
  program: anchor.Program,
  accounts: {
    readonly crank: PublicKey;
    readonly vault: PublicKey;
    readonly policy: PublicKey;
    readonly vaultWsol: PublicKey;
  },
  lamports: bigint,
): MethodCall {
  return method(program, "wrapSol")(new BN(lamports.toString())).accountsPartial({
    crank: accounts.crank,
    vault: accounts.vault,
    policy: accounts.policy,
    vaultWsol: accounts.vaultWsol,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });
}

/** convert: the vault's wSOL to USDC, at no worse than `minOut`, through the venue the policy names. */
export function convertCall(
  program: anchor.Program,
  accounts: {
    readonly crank: PublicKey;
    readonly vault: PublicKey;
    readonly policy: PublicKey;
    readonly vaultWsol: PublicKey;
    readonly vaultIn: PublicKey;
  },
  args: { readonly amountIn: bigint; readonly minOut: bigint; readonly swap: SwapV2Args },
): MethodCall {
  return method(program, "convert")(
    new BN(args.amountIn.toString()),
    new BN(args.minOut.toString()),
    buildSwapV2Data(args.swap),
  ).accountsPartial({
    crank: accounts.crank,
    vault: accounts.vault,
    policy: accounts.policy,
    vaultWsol: accounts.vaultWsol,
    vaultIn: accounts.vaultIn,
    venueProgram: RAYDIUM_CLMM,
  });
}

/** invest: one leg of the signed basket, by its INDEX — the program prices and bounds the rest. */
export function investCall(
  program: anchor.Program,
  accounts: {
    readonly crank: PublicKey;
    readonly vault: PublicKey;
    readonly policy: PublicKey;
    readonly vaultIn: PublicKey;
    readonly vaultTarget: PublicKey;
    readonly targetMint: PublicKey;
  },
  args: { readonly legIndex: number; readonly amountIn: bigint; readonly minOut: bigint; readonly swap: SwapV2Args },
): MethodCall {
  return method(program, "invest")(
    args.legIndex,
    new BN(args.amountIn.toString()),
    new BN(args.minOut.toString()),
    buildSwapV2Data(args.swap),
  ).accountsPartial({
    crank: accounts.crank,
    vault: accounts.vault,
    policy: accounts.policy,
    vaultIn: accounts.vaultIn,
    vaultTarget: accounts.vaultTarget,
    targetMint: accounts.targetMint,
    venueProgram: RAYDIUM_CLMM,
  });
}

/** PAUSED, like NO_POLICY and IDLE, is a resting state: nothing moved and nothing broke. */
export type InvestOutcome = "IDLE" | "NO_POLICY" | "PAUSED" | "INVESTED" | "REFUSED" | "FAILED";

export interface InvestPurchase {
  readonly target: string;
  readonly spentRaw: bigint;
  readonly receivedRaw: bigint;
  readonly signature: string;
  readonly slot: bigint;
}

export interface InvestResult {
  readonly outcome: InvestOutcome;
  readonly detail: string;
  /**
   * EVERY purchase that confirmed, one per leg, carried out so the keeper
   * records history from what was MEASURED here, never from what was intended.
   * Present on INVESTED — and on FAILED too, when legs confirmed before the
   * basket broke: a 5-leg basket that died on leg 3 still moved real money on
   * legs 1 and 2, and history that drops a confirmed on-chain purchase because
   * a LATER one failed is history that lies.
   */
  readonly purchases?: readonly InvestPurchase[];
  /**
   * What the turn found about the wrap, whenever conversion is on and it read
   * the vault's free SOL: a dry run's plan, or a live turn's, sized against the
   * crank's balance at the moment of the wrap. The keeper counts the turns in a
   * row that found the crank short of the vault.
   */
  readonly wrap?: WrapReport;
}

export interface InvestDeps {
  readonly connection: Connection;
  readonly program: anchor.Program;
  readonly vault: PublicKey;
  /** Pays for every wrap, convert and invest: the settle key. NULL IN DRY RUN; required live. */
  readonly crank: Keypair | null;
  /**
   * The crank's lamports from this sweep's chain snapshot, null when it could
   * not be read. It decides whether a turn wakes to wrap and what a dry run
   * says it would wrap; a live wrap reads the balance again first.
   */
  readonly crankLamports: bigint | null;
  /** Pool for each investable mint, from the operator's registry. */
  readonly pools: ReadonlyMap<string, PublicKey>;
  readonly live: boolean;
  /** The protocol's emergency switch, from the ProtocolConfig this sweep read. */
  readonly protocolPaused: boolean;
}

/** What a turn learns on its way through, whichever way it then ends. */
interface TurnFindings {
  wrap?: WrapReport;
  /** Set once a convert that left wSOL behind has landed, saying how much waits. */
  converted?: string;
}

/**
 * One investment turn, with what it found about the wrap and the convert
 * attached to whichever outcome it ends in. The turn has a dozen ways out; the
 * findings are written once, here, rather than in each of them.
 */
export async function runInvestTick(deps: InvestDeps): Promise<InvestResult> {
  const found: TurnFindings = {};
  const result = await investTurn(deps, found);
  return {
    ...result,
    ...(found.converted === undefined ? {} : { detail: `${found.converted}; ${result.detail}` }),
    ...(found.wrap === undefined ? {} : { wrap: found.wrap }),
  };
}

async function investTurn(deps: InvestDeps, found: TurnFindings): Promise<InvestResult> {
  const { connection, program, vault } = deps;

  const policy = await readInvestmentPolicy(program, vault);
  if (policy === null) return { outcome: "NO_POLICY", detail: "the owner has not chosen a basket yet" };
  if (!policy.enabled) return { outcome: "IDLE", detail: "investing is switched off in the policy" };

  // BEFORE ANY BALANCE, ANY WRAP, ANY ROUTE: every floor and cap below is an
  // amount of in_mint, and the only in_mint this keeper can route is USDC.
  const refused = inMintDecision(policy.inMint);
  if (refused !== null) return refused;
  const policyPda = policy.address;

  // THE CHAIN'S CLOCK COMES WITH THE VAULT, in the same request: the 30-day cap
  // below is counted in the program's days, never this host's.
  const [vaultInfo, clockInfo] = await connection.getMultipleAccountsInfo([vault, SYSVAR_CLOCK_PUBKEY]);
  if (vaultInfo === null || vaultInfo === undefined) return { outcome: "FAILED", detail: "vault account missing" };
  // BEFORE ANY OTHER READ, ANY ATA, ANY WRAP: either pause switch. The vault's
  // own switch is decoded from the read that also gives its lamports, so a
  // paused vault never gets as far as wrap_sol. The program refuses that wrap
  // too now (VaultPaused); asking anyway would only buy a failed transaction
  // and report FAILED where the owner chose a rest.
  const paused = investPauseDecision({
    vaultPaused: decodeVault(program, vaultInfo.data).paused,
    protocolPaused: deps.protocolPaused,
  });
  if (paused !== null) return paused;

  // BEFORE ANY BALANCE, ANY ATA, ANY WRAP: whether the 30-day cap leaves the
  // basket room. convert records nothing against it and invest refuses every
  // leg past it, so a turn that sold the SOL first would leave the savings in
  // USDC the vault may not spend (rollingDecision). The Clock sysvar is slot,
  // epoch_start_timestamp, epoch and leader_schedule_epoch, then unix_timestamp
  // as an i64 at byte 32.
  if (clockInfo === null || clockInfo === undefined || clockInfo.data.length < 40) {
    return { outcome: "FAILED", detail: "the Clock sysvar could not be read, so the 30-day cap cannot be checked; nothing was sent" };
  }
  const rolling = rollingDecision({ policy, today: chainDay(clockInfo.data.readBigInt64LE(32)) });
  if (!rolling.invest) return { outcome: rolling.outcome, detail: rolling.detail };

  // BEFORE ANY ATA, ANY WRAP: whether the owner ever turned conversion on.
  // wrap_sol and convert both refuse a zero conversion floor, and this tick once
  // looked only at `enabled`, so such a vault had a refused wrap sent for it on
  // every sweep. Its SOL now stays SOL, the USDC it already holds is still
  // invested, and every detail from here on says why the SOL did not move.
  const conversion = convertDecision(policy);
  const noted = (detail: string): string =>
    conversion.convert ? detail : `${detail.replace(/\.$/, "")} — ${conversion.detail}`;

  const rentFloor = await connection.getMinimumBalanceForRentExemption(vaultInfo.data.length);
  const free = BigInt(vaultInfo.lamports - rentFloor);

  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
  // WHAT IS ALREADY WRAPPED COUNTS. wrap and convert are two transactions, so a
  // convert that reverts — on slippage, on congestion, on a dropped RPC —
  // leaves the vault's SOL sitting as wSOL. Nothing used to read this balance:
  // every convert moved only the amount freshly wrapped in the same tick, so
  // that stranded wSOL was never converted again, by any later sweep, ever.
  const wsolHeld = await balanceOf(connection, wsolAta);
  const usdcAta = getAssociatedTokenAddressSync(USDC, vault, true, TOKEN_PROGRAM_ID);
  const usdcHeld = await balanceOf(connection, usdcAta);

  // The floor is the policy's own minimum, in USDC. Convert what is free only
  // if doing so could plausibly clear it — at ~$100/SOL, 0.01 SOL is ~$1 — and
  // sweep up any wSOL an earlier convert left behind, once it is more than dust
  // (shouldConvert). Neither while conversion is off: then only the USDC
  // already held can wake this turn.
  //
  // AND NO MORE THAN THE CRANK CAN FRONT (wrapPlan), sized here from the
  // sweep's snapshot of its balance. That figure decides whether the turn wakes
  // and what a dry run says; a live turn reads the balance again before it
  // wraps. A balance the snapshot could not read fronts nothing.
  const minInvestment = policy.minInvestment;
  const crankRead = deps.crankLamports !== null;
  const planned = conversion.convert ? wrapPlan({ free, crankLamports: deps.crankLamports ?? 0n }) : null;
  if (planned !== null) found.wrap = wrapReport(planned, deps.live ? 0n : planned.amount);
  const converts = planned !== null && shouldConvert(wsolHeld, planned.amount);
  if (!converts && usdcHeld < minInvestment) {
    return {
      outcome: "IDLE",
      detail:
        planned === null
          ? noted(`${usdcHeld} USDC, below the policy minimum ${minInvestment}`)
          : planned.short
            ? `${wsolHeld} wSOL and ${usdcHeld} USDC, below the policy minimum, and nothing wrapped: ${shortfall(planned, crankRead)}`
            : `${planned.free} free lamports, ${wsolHeld} wSOL and ${usdcHeld} USDC — below the policy minimum`,
    };
  }
  if (!deps.live) {
    return {
      outcome: "INVESTED",
      detail:
        planned === null
          ? noted(`DRY RUN — would invest the ${usdcHeld} USDC already in the vault`)
          : `DRY RUN — would wrap ${planned.amount} lamports and invest` +
            (planned.short ? `; ${shortfall(planned, crankRead)}` : ""),
    };
  }
  const crank = deps.crank;
  if (crank === null) {
    // Unreachable from the keeper, which passes the settle key whenever it is
    // live. Refused rather than guessed at: nothing can be paid for without it.
    return { outcome: "FAILED", detail: "a live invest turn arrived without the crank; nothing was sent" };
  }

  // A MISSING POOL REFUSES THE WHOLE BASKET — and it refuses BEFORE the
  // convert, not after. The old order wrapped and market-sold the vault's SOL
  // into USDC first and only then noticed the basket was unroutable, so a
  // policy the keeper's registry could not serve would sell the owner's SOL
  // exposure on every sweep in service of a purchase that was knowably
  // impossible before the swap. Nothing below this line moves money until the
  // whole basket has a route.
  const unroutable = policy.legs.map((leg) => leg.mint.toBase58()).filter((mint) => !deps.pools.has(mint));
  if (unroutable.length > 0) {
    return {
      outcome: "REFUSED",
      detail: `no pool configured for ${unroutable.join(", ")} — refusing to guess, refusing a partial basket, and refusing to convert SOL toward it`,
    };
  }

  const purchases: InvestPurchase[] = [];
  try {
    // ── wrap + convert, if conversion is on and there is SOL worth moving ──
    if (converts) {
      await createAssociatedTokenAccountIdempotent(connection, crank, NATIVE_MINT, vault, undefined, TOKEN_PROGRAM_ID, undefined, true);
      await createAssociatedTokenAccountIdempotent(connection, crank, USDC, vault, undefined, TOKEN_PROGRAM_ID, undefined, true);
      // THE CRANK'S BALANCE NOW, NOT THE SNAPSHOT'S. Every earlier turn in this
      // sweep paid its fees and token-account rent out of it, and so did the two
      // accounts just above, so the top of the sweep can promise a wrap the
      // crank no longer covers.
      const wrap = wrapPlan({ free, crankLamports: BigInt(await connection.getBalance(crank.publicKey, "confirmed")) });
      found.wrap = wrapReport(wrap, 0n);
      // Only if there is new SOL worth wrapping and a crank to front it.
      // Reaching here with nothing to wrap means we are here to rescue stranded
      // wSOL, and the program refuses a zero amount.
      if (wrap.amount > 0n) {
        // The policy goes in by name: wrap_sol loads it and refuses a vault
        // whose policy is disabled or names no conversion floor, both of which
        // this turn ruled out before it got here.
        await wrapSolCall(program, { crank: crank.publicKey, vault, policy: policyPda, vaultWsol: wsolAta }, wrap.amount)
          .signers([crank])
          .rpc();
        found.wrap = wrapReport(wrap, wrap.amount);
      }

      // EVERYTHING THE VAULT HOLDS AS wSOL, re-read after the wrap so a balance
      // stranded by an earlier failed convert is swept up with the new one —
      // up to what convert.rs admits in one call, the rest left for later
      // sweeps (convertAmount), and none of it when it is dust nothing wrapped.
      const held = await balanceOf(connection, wsolAta);
      if (held === 0n || !shouldConvert(held, found.wrap?.wrapped ?? 0n)) {
        return { outcome: "IDLE", detail: `nothing wrapped to convert, and ${held} wSOL is not worth a swap` };
      }
      const toConvert = convertAmount(held, policy.maxPerCall);

      const route = await fetchLiveRoute(connection, WSOL_USDC_POOL, NATIVE_MINT, USDC, TOKEN_PROGRAM_ID);
      const convertFloor = (toConvert * policy.minConvertRateWad) / 10n ** 18n;
      const { minOut } = tightenMinOut(toConvert, convertFloor, route.observed);
      const args = { payer: vault, inputTokenAccount: wsolAta, outputTokenAccount: usdcAta, amountIn: toConvert, minAmountOut: minOut };
      await sendWithBudget(program.provider as anchor.AnchorProvider, crank,
        await convertCall(
          program,
          { crank: crank.publicKey, vault, policy: policyPda, vaultWsol: wsolAta, vaultIn: usdcAta },
          { amountIn: toConvert, minOut, swap: args },
        )
          .remainingAccounts(buildSwapV2AccountMetas(route, args).map((m) => ({ ...m, isSigner: false })))
          .instruction());
      if (toConvert < held) found.converted = `converted ${toConvert} of ${held} wSOL; ${held - toConvert} left for later sweeps`;
    }

    // ── invest EVERY leg, by the weights the owner signed ─────────────────
    //
    // ONE TRANSACTION PER LEG, not one for the basket: state.rs says why — an
    // 8-leg basket cannot fit under the 64-account cap with a CLMM route per
    // leg. The program takes a leg INDEX for exactly this reason.
    const usdc = await balanceOf(connection, usdcAta);
    if (usdc < minInvestment) {
      return { outcome: "IDLE", detail: noted(`${usdc} USDC held, below policy minimum ${minInvestment}`) };
    }

    // NO MORE THAN THE 30-DAY CAP ADMITS, as well as the per-call cap. Every leg
    // records its spend before the next is checked, and the shares add up to at
    // most the budget, so a budget within the headroom keeps every leg within it.
    const maxPerCall = policy.maxPerCall;
    const perCall = usdc > maxPerCall ? maxPerCall : usdc;
    const budget = perCall > rolling.headroom ? rolling.headroom : perCall;

    // THE PROGRAM CHECKS EACH LEG, NOT THE TOTAL.
    //
    // invest.rs requires `amount_in >= min_investment` on EVERY call, and a
    // basket splits the budget by weight — so a six-leg basket at a $5 minimum
    // needs $25 before even its largest leg qualifies, and $50 before its
    // smallest does. Comparing only the TOTAL let a vault holding $7.48 sail
    // past and then have all six of its transactions refused by the program,
    // one after another, every sweep, forever.
    //
    // ALL OR NOTHING, the same doctrine as the unroutable-leg refusal above:
    // buying only the legs that happen to clear the minimum is a partial basket
    // that silently drifts away from the weights the owner signed.
    const shares = policy.legs.map((leg) => (budget * BigInt(leg.weightBps)) / 10_000n);
    const short = shares.filter((share) => share < minInvestment).length;
    if (short > 0) {
      // The number that is actually actionable is how much this basket needs,
      // not which leg fell short — so it is computed and stated.
      const heaviest = policy.legs.reduce((a, leg) => Math.max(a, leg.weightBps), 0);
      const lightest = policy.legs.reduce((a, leg) => Math.min(a, leg.weightBps), 10_000);
      const usd = (raw: bigint) => `$${(Number(raw) / 1e6).toFixed(2)}`;
      const needed = (bps: number) => usd((minInvestment * 10_000n) / BigInt(bps));
      return {
        outcome: "IDLE",
        detail: noted(
          `${usd(usdc)} across ${policy.legs.length} legs is ${usd(shares[0] ?? 0n)}-ish each, under the ` +
            `${usd(minInvestment)} per-call minimum (${short} of ${policy.legs.length} legs short). ` +
            `This basket needs ${needed(heaviest)} for its largest leg to qualify and ${needed(lightest)} for all of them. ` +
            `Lower the minimum or hold fewer stocks to invest smaller amounts.`,
        ),
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

      const mint = leg.mint;
      const pool = deps.pools.get(mint.toBase58())!;
      const targetAta = await createAssociatedTokenAccountIdempotent(connection, crank, mint, vault, undefined, TOKEN_2022_PROGRAM_ID, undefined, true);

      const route = await fetchLiveRoute(connection, pool, USDC, mint, TOKEN_2022_PROGRAM_ID);
      const investFloor = (amountIn * leg.minOutRateWad) / 10n ** 18n;
      const { minOut, live } = tightenMinOut(amountIn, investFloor, route.observed);
      anyLive = anyLive || live;

      const args = { payer: vault, inputTokenAccount: usdcAta, outputTokenAccount: targetAta, amountIn, minAmountOut: minOut };
      const before = await balanceOf(connection, targetAta);
      const signature = await sendWithBudget(program.provider as anchor.AnchorProvider, crank,
        await investCall(
          program,
          { crank: crank.publicKey, vault, policy: policyPda, vaultIn: usdcAta, vaultTarget: targetAta, targetMint: mint },
          { legIndex: index, amountIn, minOut, swap: args },
        )
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
      return { outcome: "IDLE", detail: noted(`${budget} USDC splits to nothing across ${policy.legs.length} leg(s)`) };
    }
    return {
      outcome: "INVESTED",
      detail: noted(
        `bought ${filled.join(" · ")}` +
          (anyLive
            ? " (min_out from a live observed price)"
            : " (min_out is the POLICY FLOOR — no live price was observable)"),
      ),
      purchases,
    };
  } catch (error) {
    return {
      outcome: "FAILED",
      detail: noted(summarizeUpstreamError(error, { take: 3, maxChars: 500 })),
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

/** A wrap plan as the turn reports it, with the lamports it actually wrapped. */
function wrapReport(plan: WrapPlan, wrapped: bigint): WrapReport {
  return { free: plan.free, allowance: plan.allowance, wrapped, short: plan.short };
}

/** Why a short plan leaves free SOL unwrapped, in words for a detail. */
function shortfall(plan: WrapPlan, crankRead: boolean): string {
  const why = !crankRead
    ? "the crank's balance was not read this sweep, and a balance not read fronts nothing"
    : `the crank can front ${plan.allowance} (its balance less the ${CRANK_WRAP_RESERVE_LAMPORTS}-lamport reserve)` +
      (plan.amount === 0n ? `, under the ${WRAP_DUST_LAMPORTS} lamports worth a wrap` : "");
  return `${plan.free - plan.amount} free lamports wait for later sweeps, because ${why}`;
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
  // 10_000 micro-lamports is 6_000 lamports, on top of the 5_000-lamport
  // signature fee) and buys inclusion when it matters.
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }))
    .add(instruction);
  return provider.sendAndConfirm(tx, [crank]);
}
