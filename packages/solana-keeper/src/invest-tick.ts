// One investment turn for one vault: wrap what settled, convert it, buy the leg.
//
// Ported from the solana-lab keeper (keeper/src/invest-tick.ts). Nine things
// changed: the policy's in_mint is checked before anything moves, so are either
// pause switch, the 30-day cap and the owner's conversion floor, every leg's
// mint is checked for a token program, a transfer hook and a transfer fee the
// program cannot buy through, the SOL hop is priced against Pyth as well as
// against the pool it would trade on, a wrap moves no more than the crank can
// front and a convert no more than convert.rs admits in one call (all eight in
// invest-decision.ts), and the crank is null in a dry run, which never reaches a
// line that needs it. Everything else is the old behaviour, deliberately: the
// stranded-wSOL rescue, the refusal before convert on an unroutable basket, the
// all-or-nothing per-leg minimum, one transaction per leg, the compute budget
// price, and purchases recorded on FAILED too.
//
// THE CRANK OWNS NO AUTHORITY. Every bound — the venue, the floors, the caps —
// lives in policy state the vault owner signed; this only picks the moment and
// supplies a live route. That is why it needs no Privy signer, unlike settle:
// the vault PDA signs its own movements inside the program.
//
// THAT SENTENCE WAS NOT TRUE OF THE VENUE, and now is. convert and invest both
// take a venue account the program pins against policy.venue_program, and this
// tick passed the RAYDIUM_CLMM literal at both — the crank choosing a term of
// the policy. It matched every policy signed to date and would have matched no
// other: a venue re-signed anywhere else means WrongVenue on every convert and
// every invest, every sweep, forever, reported as a failed transaction that
// names nothing. The venue now comes off the policy this tick already reads, and
// a venue this keeper cannot build a route for is refused in words, beside the
// unroutable, inadmissible and too-thin refusals, before anything moves.
//
// IT IS DELIBERATELY LAZY. Below a threshold it does nothing: three pool fees
// and three transaction fees to move dust is a worse outcome for the user than
// waiting for the next session. The threshold is the policy's own
// min_investment, read from the chain rather than configured here twice.

import type * as anchor from "@coral-xyz/anchor";
import {
  type AccountMeta,
  type AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionMessage,
  type TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { summarizeUpstreamError } from "@sip/solana-log";
import { decodeVault, readInvestmentPolicy, type InvestmentPolicyState } from "./accounts.js";
import type { Alert } from "./alerts.js";
import { BN } from "./anchor-interop.js";
import {
  CRANK_WRAP_RESERVE_LAMPORTS,
  USDC_MINT,
  WRAP_DUST_LAMPORTS,
  basketBudget,
  chainDay,
  convertAmount,
  convertDecision,
  convertCapLamports,
  inMintDecision,
  investPauseDecision,
  legAdmissionDecision,
  legDepthDecision,
  legFeeWarnings,
  legShare,
  legSlippageBps,
  oracleConvertDecision,
  rollingDecision,
  routeRateWad,
  shouldConvert,
  turnSpendCeiling,
  venueDecision,
  wrapPlan,
  JUPITER_V6_PROGRAM,
  type ConvertDecision,
  type LegVenue,
  type WrapPlan,
  type WrapReport,
} from "./invest-decision.js";
import { method, type MethodCall } from "./methods.js";
// FOUR NAMES LEFT WITH THE RAYDIUM ARM. raydiumLegVenue, raydiumSides,
// readRouteAccounts and vaultOwnedAmong were imported here for the pool-reading
// branch that no longer exists; the typecheck did not object, because an unused
// IMPORT is not an unused local. They are gone: an import is a claim about what
// this file does, and this one claimed a venue the keeper has retired.
// Three of the four are gone from venue-depth.ts too: the adapter itself went
// on 2026-09-23, and its header says what held it there and what replaced it.
// readRouteAccounts stays, because measureLegVenue reads the route's accounts
// with it; it only stopped being called from here.
import { VenueMeasurementRefusal, measureLegVenue } from "./venue-depth.js";
import type { TransferFeeTerms } from "./min-out.js";
import { JupiterRouteRefusal, type JupiterRoute, investAmountIn, investMinOut, verifyRouteFresh } from "./program-scripts.js";
import {
  PYTH_RECEIVER_PROGRAM,
  PYTH_SOL_USD_FEED,
  PYTH_SOL_USD_FEED_ID_HEX,
  PYTH_USDC_USD_FEED,
  PYTH_USDC_USD_FEED_ID_HEX,
  decodePythPriceUpdate,
  type PythPriceUpdate,
} from "./pyth.js";

const USDC = USDC_MINT;

// WSOL_USDC_POOL IS GONE, and its absence is the point. The convert used to
// read one hardcoded Raydium CLMM pool — 3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv
// — for the wSOL -> USDC hop. venue_program is ONE field on the owner-signed
// policy that convert.rs:88-91 and invest.rs:119-122 BOTH pin against, so the
// conversion cannot stay on Raydium while the basket moves to Jupiter: it is
// the same signature. The convert is now quoted by Jupiter like any other leg,
// which is also why it is measured by the same depth gate at the same moment.

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

/**
 * convert: the vault's wSOL to USDC, at no worse than `minOut`, through the
 * venue the policy names.
 *
 * THE VENUE COMES FROM THE POLICY, and it did not always. This builder and the
 * one below passed the RAYDIUM_CLMM literal, while convert.rs and invest.rs both
 * pin the account against `policy.venue_program` (WrongVenue) — so the crank was
 * sending a venue of its own choosing to a program that checks the owner's. It
 * agreed with every policy signed to date and would have agreed with no other:
 * one re-signed venue and every convert and every invest for that vault reverts,
 * every sweep, with nothing saying why. The caller now passes what it read off
 * the chain (`policy.venueProgram`), and venueDecision refuses a venue this
 * keeper cannot route before any of this is reached.
 *
 * AND IT IS NO LONGER OPTIONAL. It used to default to RAYDIUM_CLMM so the
 * preflight and the builder tests — which have no policy to read a venue from —
 * could call this offline and still get the bytes production sent. That default
 * is now a venue this keeper REFUSES, so leaving it in place would mean every
 * offline caller silently building an instruction the live gate would never
 * allow: a vector that pins the wrong thing. The offline callers pass
 * JUPITER_V6_PROGRAM explicitly instead, which is what production passes.
 *
 * `venueData` IS THE BLOB THE PROGRAM CPIs WITH, VERBATIM. convert.rs takes it
 * as `venue_data: Vec<u8>` and hands it to invoke_signed as the inner
 * instruction's `data` without looking at a byte of it. It used to be built
 * here, by buildSwapV2Data over a SwapV2Args, because the venue was always
 * Raydium; under Jupiter the bytes are `route.venueData`, built by Jupiter's own
 * /swap-instructions and then VERIFIED against the accounts and amounts we asked
 * for (verifySharedAccountsRoute). Taking the blob rather than the arguments is
 * what makes this builder venue-agnostic — the program's own shape.
 */
export function convertCall(
  program: anchor.Program,
  accounts: {
    readonly crank: PublicKey;
    readonly vault: PublicKey;
    readonly policy: PublicKey;
    readonly vaultWsol: PublicKey;
    readonly vaultIn: PublicKey;
    /** The venue `policy.venue_program` names. Required: there is no safe default. */
    readonly venueProgram: PublicKey;
  },
  args: { readonly amountIn: bigint; readonly minOut: bigint; readonly venueData: Buffer },
): MethodCall {
  return method(program, "convert")(
    new BN(args.amountIn.toString()),
    new BN(args.minOut.toString()),
    args.venueData,
  ).accountsPartial({
    crank: accounts.crank,
    vault: accounts.vault,
    policy: accounts.policy,
    vaultWsol: accounts.vaultWsol,
    vaultIn: accounts.vaultIn,
    venueProgram: accounts.venueProgram,
  });
}

/**
 * invest: one leg of the signed basket, by its INDEX — the program prices and
 * bounds the rest.
 *
 * `venueProgram` is the policy's and `venueData` is the route's, exactly as
 * convertCall's are and for the same reasons: see convertCall above.
 */
export function investCall(
  program: anchor.Program,
  accounts: {
    readonly crank: PublicKey;
    readonly vault: PublicKey;
    readonly policy: PublicKey;
    readonly vaultIn: PublicKey;
    readonly vaultTarget: PublicKey;
    readonly targetMint: PublicKey;
    /** The venue `policy.venue_program` names. Required: there is no safe default. */
    readonly venueProgram: PublicKey;
  },
  args: { readonly legIndex: number; readonly amountIn: bigint; readonly minOut: bigint; readonly venueData: Buffer },
): MethodCall {
  return method(program, "invest")(
    args.legIndex,
    new BN(args.amountIn.toString()),
    new BN(args.minOut.toString()),
    args.venueData,
  ).accountsPartial({
    crank: accounts.crank,
    vault: accounts.vault,
    policy: accounts.policy,
    vaultIn: accounts.vaultIn,
    vaultTarget: accounts.vaultTarget,
    targetMint: accounts.targetMint,
    venueProgram: accounts.venueProgram,
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
  /**
   * The fee warnings this turn's own leg read earned, ready for the alerter —
   * PRESENT (possibly empty) whenever the turn got as far as reading the leg
   * mints, and ABSENT when it stopped before them.
   *
   * WHY THE EMPTY ARRAY IS NOT THE SAME AS `undefined`. bin/keeper.mts clears a
   * standing leg-fee alert when this sweep no longer raises it, and "no warnings
   * this turn" is only evidence of that when the turn LOOKED. A turn that
   * refused on the in_mint, the venue or an unroutable basket never reads a mint
   * at all, and treating its silence as "the fee came back down" would clear a
   * standing warning about a condition nobody has checked.
   *
   * NEVER AN OUTCOME AND NEVER A DETAIL. Every alert here is a warning about a
   * LATER sweep — the fee that stops this basket next month — so it rides beside
   * the verdict and changes none of it. What this turn does today is decided by
   * legAdmissionDecision alone, exactly as before.
   */
  readonly feeWarnings?: readonly Alert[];
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
  readonly live: boolean;
  /** The protocol's emergency switch, from the ProtocolConfig this sweep read. */
  readonly protocolPaused: boolean;
}

/** What a turn learns on its way through, whichever way it then ends. */
interface TurnFindings {
  wrap?: WrapReport;
  /**
   * THE ALARM ON A POLICY WHOSE min_convert_rate_wad IS 0 — set the moment the
   * turn reads the policy, and carried at the FRONT of whatever detail the turn
   * ends with.
   *
   * A ZERO THERE IS VALID AND IS NEVER REFUSED (convertDecision says why), which
   * is exactly what makes it dangerous: the program accepts the policy, nothing
   * in set_invest_policy validates the field, and the only symptom is a
   * SOL-to-USDC hop that silently stops happening. It used to be reported by
   * `noted` alone, which appends to SOME of the turn's dozen ways out and not to
   * others — a vault whose basket was also unroutable, inadmissible or too thin
   * said nothing about it at all. Here it rides EVERY way out from the read
   * onwards, refusals and failures included, and it leads rather than trails
   * because a truncated log line has to keep it.
   */
  conversionOff?: string;
  /**
   * What became of the wSOL, once the turn got as far as deciding: a convert
   * that landed and left some behind, or a convert the oracle would not price,
   * saying in both cases how much waits for a later sweep.
   */
  converted?: string;
  /**
   * The leg-fee warnings read out of the mint bytes this turn already fetched,
   * set ONCE at the admission gate and carried out on whatever outcome the turn
   * then reaches — the same reason `wrap` is a finding rather than a return
   * value. The gate has a dozen ways out below it, and a notice that only
   * survived the happy one would be missing from exactly the turns an operator
   * reads.
   */
  feeWarnings?: readonly Alert[];
}

/**
 * One investment turn, with what it found about the wrap and the convert
 * attached to whichever outcome it ends in. The turn has a dozen ways out; the
 * findings are written once, here, rather than in each of them.
 */
export async function runInvestTick(deps: InvestDeps): Promise<InvestResult> {
  const found: TurnFindings = {};
  const result = await investTurn(deps, found);
  // In order, and they cannot both be set: a turn with conversion off never
  // reaches the convert that writes `converted`.
  const notes = [found.conversionOff, found.converted].filter((note): note is string => note !== undefined);
  return {
    ...result,
    ...(notes.length === 0 ? {} : { detail: `${notes.join("; ")}; ${result.detail}` }),
    ...(found.wrap === undefined ? {} : { wrap: found.wrap }),
    ...(found.feeWarnings === undefined ? {} : { feeWarnings: found.feeWarnings }),
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
  //
  // AND SO DO PYTH'S TWO FEEDS, IN THAT SAME REQUEST. The oracle gate below
  // costs this turn nothing it was not already paying: two more addresses in a
  // getMultipleAccountsInfo that was being sent anyway, resolved against the
  // very unix_timestamp that comes back beside them. A gate that cost a round
  // trip per vault per sweep would be a gate an operator eventually turns off.
  const [vaultInfo, clockInfo, solFeedInfo, usdcFeedInfo] = await connection.getMultipleAccountsInfo([
    vault,
    SYSVAR_CLOCK_PUBKEY,
    PYTH_SOL_USD_FEED,
    PYTH_USDC_USD_FEED,
  ]);
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
  const nowUnixSeconds = clockInfo.data.readBigInt64LE(32);
  const rolling = rollingDecision({ policy, today: chainDay(nowUnixSeconds) });
  if (!rolling.invest) return { outcome: rolling.outcome, detail: rolling.detail };

  // BEFORE ANY ATA, ANY WRAP: whether the owner ever turned conversion on.
  // wrap_sol and convert both refuse a zero conversion floor, and this tick once
  // looked only at `enabled`, so such a vault had a refused wrap sent for it on
  // every sweep. Its SOL now stays SOL, the USDC it already holds is still
  // invested, and every detail from here on says why the SOL did not move.
  //
  // AND WHETHER AN ORACLE OUTSIDE THE VENUE STILL SEES THE PRICE. The slippage
  // bound min-out.ts draws comes from the POOL'S OWN captured swap, so a pool
  // pushed somewhere absurd prices its own bound, agrees with itself and passes
  // every check this keeper makes; the floor underneath is the owner's, signed
  // once at 1000 bps under the pool price of that day. Pyth is the only number
  // in the turn that does not come from the venue being traded against. The
  // OWNER of each feed account is checked HERE, at the read — bytes cannot say
  // who wrote them — and the decision itself is pure (oracleConvertDecision).
  //
  // A BAD READING RESTS EXACTLY AS A ZERO FLOOR DOES: no wrap, no convert, and
  // the USDC the vault already holds still invested below. It cannot fail the
  // turn and cannot stop the sweep.
  const solFeed = readPythFeed(solFeedInfo, PYTH_SOL_USD_FEED_ID_HEX);
  const usdcFeed = readPythFeed(usdcFeedInfo, PYTH_USDC_USD_FEED_ID_HEX);
  const signed = convertDecision(policy);
  const conversion: ConvertDecision = signed.convert
    ? oracleConvertDecision({ sol: solFeed, usdc: usdcFeed, nowUnixSeconds, routeWad: null })
    : signed;
  // TWO DIFFERENT SILENCES, REPORTED TWO DIFFERENT WAYS. A zero conversion floor
  // is a standing property of the policy that no sweep will change, so it is a
  // finding: written once, carried at the front of every way out of this turn.
  // An oracle that rested the hop is a property of THIS MOMENT — the next sweep
  // may well convert — so it stays a note appended to the detail of whichever
  // rest the turn ends in. Keeping them apart is what stops the zero-floor
  // alarm being appended twice to the same sentence.
  if (!signed.convert) found.conversionOff = signed.detail;
  const oracleRested = signed.convert && !conversion.convert ? conversion.detail : null;
  const noted = (detail: string): string =>
    oracleRested === null ? detail : `${detail.replace(/\.$/, "")} — ${oracleRested}`;

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

  // ── the all-or-nothing gate: nothing below moves money until all of it passes ──
  //
  // THE VENUE THE POLICY NAMES COMES FIRST, because it is the cheapest of the
  // four and the only one that needs nothing from the chain — the policy is
  // already in hand. convert.rs and invest.rs both pin the venue account against
  // policy.venue_program (WrongVenue), so a venue this keeper cannot build a
  // route for is a vault whose every convert and every invest would revert, on
  // every sweep, forever. Refused here, with the reason in words, rather than
  // discovered one failed transaction at a time — and refused before the wrap,
  // so the owner's SOL exposure is not sold toward a basket that cannot be
  // bought, which is the same doctrine as the three refusals below it.
  const wrongVenue = venueDecision(policy.venueProgram);
  if (wrongVenue !== null) return wrongVenue;

  // THE POOL REGISTRY IS GONE FROM THIS PATH, AND THE DOCTRINE IT SERVED IS NOT.
  //
  // WHAT IT USED TO DO. A leg with no entry in the operator's mint -> Raydium
  // pool registry refused the whole basket here, before the convert, so the
  // owner's SOL was never sold toward a purchase that was knowably impossible.
  // That ordering is the doctrine and it is untouched; what changed is which
  // fact answers the question.
  //
  // WHY IT CANNOT STAY. Under Jupiter there is no per-mint pool to configure:
  // Jupiter finds the route, across venues that have no pool account at all —
  // ANTHROPIC on Hadron, OPENAI on Manifest (a CLOB), SPACEX on Meteora. A
  // registry check here would refuse EXACTLY the assets this migration exists
  // to buy, and it would refuse them for a missing row rather than for anything
  // true about the market.
  //
  // WHAT ANSWERS IT NOW. measureBasketVenues, a few lines below and still
  // before the wrap: a leg Jupiter cannot route is a route the builder refuses,
  // and a refusal there returns REFUSED for the WHOLE basket — the convert
  // included — with nothing wrapped. The guarantee is strictly stronger than
  // the registry's, because it is a live answer about this leg at this size
  // rather than a row somebody added once.

  // A leg whose mint the program
  // cannot buy safely — not Token-2022, a real transfer hook, or a transfer fee
  // above MAX_LEG_FEE_BPS — refuses the whole basket here, before the wrap.
  // Every one of those is knowable from the mint's own bytes, and the fee in
  // particular is the issuer's to change: these mints have gone 0 -> 50 -> 100
  // -> 300 bps (the last written for epoch 1043, read 2026-09-24), and the same
  // key can schedule 10_000. The decision itself is pure
  // (legAdmissionDecision); this only fetches the bytes and the epoch to judge
  // them in — the epoch out of the Clock ALREADY READ above, so the fee is
  // resolved against the very clock Token-2022 charges by.
  //
  // THE POOL STATES NO LONGER RIDE THIS REQUEST, because there are no pools to
  // read: the depth gate censuses the accounts the ROUTE names, which only
  // Jupiter can tell us and only after a quote. This read is the leg mints and
  // nothing else.
  const currentEpoch = clockInfo.data.readBigUInt64LE(16);
  const legInfos = await connection.getMultipleAccountsInfo(policy.legs.map((leg) => leg.mint), "confirmed");
  const legMints = policy.legs.map((leg, index) => {
    const info = legInfos[index] ?? null;
    return { mint: leg.mint, account: info === null ? null : { owner: info.owner, data: info.data } };
  });
  const admission = legAdmissionDecision({ legs: legMints, currentEpoch });

  // AND THE NOTICE THE REFUSAL CANNOT GIVE, off the same bytes and the same
  // clock, one line above the return that can end the turn.
  //
  // A WARNING, NOT A SECOND GATE. legFeeWarnings changes no outcome, no
  // purchase and no detail string: it reports the leg whose fee is at the
  // ceiling or one issuer step under it, or which carries a rise already
  // written for a later epoch. From epoch 1043 ANTHROPIC's fee is EXACTLY
  // MAX_LEG_FEE_BPS (300, already written on chain when read 2026-09-24),
  // admitted only because that comparison is strictly greater-than — and
  // before this line nothing anywhere said so: the basket was bought, the turn
  // reported INVESTED, and the single next write by one key would stop every
  // leg and the SOL conversion together with no notice before it. The alerts
  // go out on the result and are raised in bin/keeper.mts.
  //
  // THE SAME ARRAY AND THE SAME EPOCH, WHICH IS WHY `legMints` WAS HOISTED.
  // Both calls are pure and both walk the mint's TLV, so two independently
  // built arrays — or a second `clockInfo` read — could disagree about what
  // they looked at, and the warning would then be about a leg the refusal never
  // judged. There is one array, one epoch, and nothing between the two calls.
  //
  // IT RUNS BEFORE THE REFUSAL RETURNS, on purpose. A basket refused today for
  // leg A's transfer hook must still carry the notice that leg B's fee is one
  // step from stopping it forever: this turn's problem is not next month's, and
  // legFeeWarnings skips every leg legAdmissionDecision refused for unreadable
  // bytes rather than guessing a rate out of them.
  found.feeWarnings = legFeeWarnings({ legs: legMints, currentEpoch });

  if (!admission.admit) return { outcome: admission.outcome, detail: admission.detail };

  // AND ON THE SAME LINE AGAIN: whether the VENUES this turn would trade
  // against can actually serve what it would push at them, RIGHT NOW.
  //
  // A BUILD-TIME CHECK CANNOT PROTECT AGAINST A VENUE DRAINING. check:legs
  // passed a leg holding 6,700 dollars; two days later the same venue held 51,
  // and any buy over about 11 reverts — while the product's own default buy is
  // 5, which is UNDER that threshold and would have filled. Nothing about the
  // leg changed; depth is a property of the moment, so it is measured in the
  // turn, against the amount this turn would really spend on each leg.
  //
  // TWO ARMS, ONE VERDICT (invest-decision.ts). ARM 1 counts the venue's
  // inventory of the asset each hop pays us, over the accounts the ROUTE names,
  // excluding every vault-owned account. ARM 2 divides the turn's implied rate
  // by a sixteenth-sized probe's, from one source in one instant. NEITHER
  // MEASURES PRICE, and the section header in invest-decision.ts says where the
  // price defences actually live.
  //
  // THE AMOUNT IS THE ONE THE SWAP LOOP WILL USE, not a default purchase:
  // max_per_call caps the whole basket and is then split by weight, so a
  // 1,000-dollar cap over three legs is about 333 dollars into ONE venue. The
  // convert has not happened yet, so a converting turn is tested at the most it
  // could reach — and the budget below is clamped to that same ceiling, so what
  // was tested is what is spent (turnSpendCeiling). BOTH ARMS ARE MONOTONE IN
  // SIZE: a smaller spend takes fewer units (higher cover) and has no more
  // impact, so a gate passed at the ceiling holds for anything the turn
  // actually spends.
  //
  // AND THE CONVERT IS ONE OF THE LEGS. venue_program is ONE field on the
  // owner-signed policy (state.rs:212) that both convert.rs:88-91 and
  // invest.rs:119-122 pin the passed account against, so wSOL -> USDC trades on
  // the same venue as the basket and is measured by the same function, at a
  // zero transfer fee. A refused conversion refuses the basket and a refused
  // leg refuses the conversion: ONE verdict, as today, and reached before the
  // wrap so the owner's SOL is never sold toward a basket that cannot be
  // bought.
  const spendCeiling = turnSpendCeiling({
    held: usdcHeld,
    converting: converts,
    maxPerCall: policy.maxPerCall,
    headroom: rolling.headroom,
  });
  // DERIVED, NOT CREATED, and hoisted above the gate because the route builder
  // needs the destination account to refuse an unmeasured vault account: the
  // address is arithmetic over the mint and the vault, so it costs nothing, and
  // whether the account EXISTS is still the token-account plan's question.
  const legAtas = policy.legs.map((leg) => getAssociatedTokenAddressSync(leg.mint, vault, true, TOKEN_2022_PROGRAM_ID));

  // THE MOST wSOL THIS TURN COULD CONVERT, which is what the convert leg is
  // measured at. The wrap has not happened, so the reachable balance is what is
  // already stranded as wSOL plus every free lamport the vault holds, capped by
  // what convert.rs admits in one call. Measuring the ceiling rather than the
  // eventual amount is the same monotonicity argument as the legs': the real
  // convert is no larger, so it takes no more out of the venue.
  const convertCeiling = converts ? convertAmount(wsolHeld + free, policy.maxPerCall) : 0n;

  let measured: { readonly legs: LegVenue[] };
  try {
    measured = await measureBasketVenues(connection, {
      vault,
      policy,
      legAtas,
      usdcAta,
      wsolAta,
      spendCeiling,
      convertCeiling,
      admissionFees: admission.worstCaseFees,
    });
  } catch (error) {
    // A MEASUREMENT THAT COULD NOT BE TAKEN IS A REFUSAL, NEVER A PASS, and it
    // is still a refusal BEFORE THE WRAP. A route the builder refused, a quote
    // that did not answer, an RPC that failed: none of them is evidence that
    // the venue is deep, and the doctrine is that the owner's SOL is not sold
    // toward a basket whose depth is unknown.
    if (error instanceof VenueMeasurementRefusal) return { outcome: "REFUSED", detail: error.message };
    return {
      outcome: "REFUSED",
      detail:
        `the venues this basket would trade against could not be measured: ${summarizeUpstreamError(error)} — refusing ` +
        "the whole basket and refusing to convert SOL toward it, because an unmeasurable depth is not a depth",
    };
  }

  const depth = legDepthDecision({ inMint: policy.inMint, legs: measured.legs });
  if (!depth.deep) return { outcome: depth.outcome, detail: depth.detail };

  // ── the token accounts this turn may have to create ────────────────────────
  //
  // THE ATA STORM. createAssociatedTokenAccountIdempotent sends a TRANSACTION of
  // its own on every call: the INSTRUCTION is idempotent on chain, the 5,000
  // lamports are not, and the call was made whether or not the account already
  // existed. This turn used to open with two of them and then send one more per
  // leg — for a three-leg basket, five transactions before a single lamport of
  // the owner's money moved, every sweep, forever. Of 27 signatures on the live
  // vault on 2026-09-20, 17 were exactly that, and they pushed the real settle
  // off the first page of the dashboard's history.
  //
  // TWO THINGS WERE WRONG AND BOTH ARE FIXED HERE. Accounts were created that
  // were not needed: now ONE getMultipleAccountsInfo reads every candidate at
  // once and only the genuinely absent ones are created. And they were created
  // before the turn knew it could proceed: now no create is ever sent on its
  // own — each one rides the very transaction that uses the account, so it
  // happens if and only if that transaction happens, after the route is in hand
  // and every refusal gate above has passed. A turn that refuses, or rests on
  // the per-leg minimum, now creates nothing and reads nothing.
  //
  // IDEMPOTENCY IS KEPT, AND IT IS WHAT MAKES THE READ SAFE. The instruction is
  // still the idempotent one, so an account created by anyone between the read
  // and the send is a no-op rather than a failed basket.
  const plan = tokenAccountPlan(connection, crank.publicKey, vault, [
    { address: wsolAta, mint: NATIVE_MINT, programId: TOKEN_PROGRAM_ID },
    { address: usdcAta, mint: USDC, programId: TOKEN_PROGRAM_ID },
    ...policy.legs.map((leg, index) => ({ address: legAtas[index]!, mint: leg.mint, programId: TOKEN_2022_PROGRAM_ID })),
  ]);

  // ONE CACHE FOR THE WHOLE TURN, for the reason lookupTableCache gives: the
  // legs of a basket share Jupiter's tables, and the convert shares them with
  // the legs. It is built here, beside the token-account plan and for the same
  // reason — a turn that refuses above reaches neither.
  const tables = lookupTableCache(connection);

  const purchases: InvestPurchase[] = [];
  try {
    // ── wrap + convert, if conversion is on and there is SOL worth moving ──
    if (converts) {
      // THE CRANK'S BALANCE NOW, NOT THE SNAPSHOT'S. Every earlier turn in this
      // sweep paid its fees and token-account rent out of it, so the top of the
      // sweep can promise a wrap the crank no longer covers.
      const wrap = wrapPlan({ free, crankLamports: BigInt(await connection.getBalance(crank.publicKey, "confirmed")) });
      found.wrap = wrapReport(wrap, 0n);
      // Only if there is new SOL worth wrapping and a crank to front it.
      // Reaching here with nothing to wrap means we are here to rescue stranded
      // wSOL, and the program refuses a zero amount.
      if (wrap.amount > 0n) {
        // The policy goes in by name: wrap_sol loads it and refuses a vault
        // whose policy is disabled or names no conversion floor, both of which
        // this turn ruled out before it got here.
        //
        // AND THE wSOL ACCOUNT IS CREATED IN THIS SAME TRANSACTION when it is
        // missing, rather than in one of its own beforehand: wrap_sol is the
        // first instruction that needs it, and an account created here is an
        // account this turn certainly used. The create chains onto the
        // EXTRACTED builder, which hands back the call and not the
        // instruction precisely so that it still can.
        await wrapSolCall(program, { crank: crank.publicKey, vault, policy: policyPda, vaultWsol: wsolAta }, wrap.amount)
          .preInstructions(await plan.createsFor(wsolAta))
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

      // THE ROUTE FOR THE AMOUNT THIS CONVERT ACTUALLY SENDS.
      //
      // WHY IT IS BUILT AGAIN RATHER THAN REUSED. A Jupiter route's instruction
      // data carries the in-amount it was quoted for, so a route built at the
      // gate's CEILING cannot be sent for the smaller amount convertAmount
      // settles on — the swap blob and amount_in would disagree, and the
      // program would be handed a swap for money the vault is not spending.
      // The gate above still did its job: it refused BEFORE the wrap, at the
      // largest size this turn could reach, and both arms are monotone in size.
      //
      // AND IT IS MEASURED AGAIN, not merely quoted again — remeasureForSend is
      // the same measurement the gate made AND the same verdict on it, so this
      // re-build carries its own census, its own depth refusal and its own
      // slippage refusal rather than trusting the ceiling's. It kept only the
      // route until 2026-09-21, which is to say it computed the census and
      // discarded it.
      let readyConvert: { readonly route: JupiterRoute; readonly amountToSend: bigint; readonly minOut: bigint } | null = null;
      try {
        const route = await remeasureForSend(connection, NATIVE_MINT, {
          vault,
          vaultIn: wsolAta,
          vaultTarget: usdcAta,
          inputMint: NATIVE_MINT,
          targetMint: policy.inMint,
          spend: toConvert,
          feeBps: 0n,
          maxAge: { maxAgeMs: ROUTE_MAX_AGE_MS },
          // THE OWNER'S FLOOR, APPLIED WHERE MISSING IT IS SURVIVABLE. The
          // route builder refuses a quote whose min_out would land under
          // min_convert_rate_wad — which is exactly what convert.rs would
          // answer with FloorTooLow, only without the fee.
          ownerFloorRateWad: policy.minConvertRateWad,
        });
        // BOTH NUMBERS INSIDE THE SAME try, because both are derived from this
        // route's own bytes and both can refuse: investAmountIn if the blob
        // spends anything other than what we asked for, investMinOut if the
        // floor it recomputes disagrees with the route or sits under the
        // owner's. A refusal from either is the same kind of answer as a
        // refusal from the build, and gets the same rest.
        readyConvert = {
          route,
          amountToSend: investAmountIn(route),
          minOut: investMinOut(route),
        };
      } catch (error) {
        // THE wSOL IS ALREADY WRAPPED BY NOW, and that is exactly why this is a
        // rest rather than a failure: the stranded-wSOL rescue at the top of
        // this block picks the balance up on a later sweep, and the USDC the
        // vault already holds is still invested below. The refusal that keeps
        // the owner's SOL as SOL is the one BEFORE the wrap.
        //
        // TWO REFUSAL TYPES, ONE OUTCOME. VenueMeasurementRefusal is the depth
        // gate's; JupiterRouteRefusal is the route builder's, and carries the
        // owner-floor case. Anything else is a real fault and still throws.
        if (!(error instanceof VenueMeasurementRefusal) && !(error instanceof JupiterRouteRefusal)) throw error;
        found.converted = `${held} wSOL was not converted, and waits for a later sweep: ${summarizeUpstreamError(error)}`;
      }
      if (readyConvert !== null) {
      const route = readyConvert.route;
      const observed = { inRaw: route.request.amountIn, outRaw: route.output.netOfQuotedOut };
      // THE SAME DECISION, ASKED AGAIN NOW THAT THERE IS A ROUTE TO COMPARE.
      // Its freshness arms passed before the wrap and cannot newly fire here —
      // the clock is the one this turn read — so what this second ask adds is
      // the deviation arm: what the captured swap REALLY traded at, against
      // what Pyth says the pair is worth.
      const priced = oracleConvertDecision({
        sol: solFeed,
        usdc: usdcFeed,
        nowUnixSeconds,
        routeWad: routeRateWad(observed),
      });
      if (!priced.convert) {
        // NOT A FAILURE, AND NOT THE END OF THE TURN. The wSOL stays wSOL, the
        // stranded-wSOL rescue at the top of this block picks it up on a later
        // sweep once the two agree again, and the USDC the vault already holds
        // is invested below exactly as it would have been.
        found.converted = `${held} wSOL was not converted, and waits for a later sweep: ${priced.detail}`;
      } else {
        // THE AMOUNT AND THE FLOOR WERE BOTH RE-DERIVED FROM THE
        // INSTRUCTION'S OWN BYTES, up in the try above. tightenMinOut is gone
        // from this path: it bounded a rate OBSERVED from a pool we read
        // ourselves, and under Jupiter the number that must hold is the one the
        // blob we are about to sign actually guarantees.
        const { amountToSend, minOut } = readyConvert;
        // The USDC account is created HERE when it is missing — inside the swap
        // that credits it, and only now that the route is in hand and the oracle
        // has agreed with it. A convert the oracle rested leaves no account
        // behind, which is the whole point.
        await sendWithBudget(program.provider as anchor.AnchorProvider, crank, [
          ...(await plan.createsFor(usdcAta)),
          // THE VENUE THE OWNER SIGNED, not a literal: convert.rs pins this
          // account against policy.venue_program. The gate above has already
          // refused a venue this keeper cannot route, so what is passed here is
          // both what the owner signed and something buildJupiterRoute built.
          await convertCall(
            program,
            { crank: crank.publicKey, vault, policy: policyPda, vaultWsol: wsolAta, vaultIn: usdcAta, venueProgram: policy.venueProgram },
            { amountIn: amountToSend, minOut, venueData: route.venueData },
          )
            .remainingAccounts(venueAccountsOf(route))
            .instruction(),
        ], route, await tables.tablesFor(lookupTablesOf(route)));
        if (toConvert < held) found.converted = `converted ${toConvert} of ${held} wSOL; ${held - toConvert} left for later sweeps`;
      }
      }
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
    //
    // AND NEVER MORE THAN THE DEPTH GATE TESTED. The gate above measured each
    // pool against this turn's ceiling; clamping here is what turns that from a
    // close estimate into a guarantee, whatever the convert brought in or
    // whoever deposited into the vault while this turn was running.
    const spend = basketBudget({ held: usdc, maxPerCall: policy.maxPerCall, headroom: rolling.headroom });
    const budget = spend > spendCeiling ? spendCeiling : spend;

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
    const shares = policy.legs.map((leg) => legShare(budget, leg.weightBps));
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
    for (const [index, leg] of policy.legs.entries()) {
      const weight = BigInt(leg.weightBps);
      const amountIn = legShare(budget, leg.weightBps);
      // A leg whose share rounds to nothing is skipped rather than sent: the
      // program refuses a zero min_out, and a zero-amount swap is a fee for
      // nothing.
      if (amountIn === 0n) continue;

      const mint = leg.mint;
      // DERIVED ABOVE THE GATE, NOT CREATED HERE. The address is arithmetic
      // over the mint and the vault, so it costs nothing and the route builder
      // already had it; whether the account EXISTS came out of the plan's one
      // batched read, and if it does not, the create rides the invest below
      // rather than a transaction of its own sent before the route was even
      // fetched.
      const targetAta = legAtas[index]!;

      // THE FINAL ROUTE, AT THE REAL amountIn, AND ITS OWN MEASUREMENT.
      //
      // WHY IT IS BUILT AGAIN. The first gate tested this turn's CEILING; the
      // budget can be smaller (the convert brought in less than the cap, or the
      // 30-day headroom bit), and a Jupiter route's instruction data carries
      // the in-amount it was quoted for — so the route that is SENT has to be
      // the route built for the amount that is sent.
      //
      // ── the second run, and what it is and is not ────────────────────────
      //
      // IT IS A SAFETY NET, NOT THE DOCTRINAL GATE. A refusal HERE leaves the
      // vault holding USDC it did not want — the wrap and the convert are
      // separate transactions and have already happened. That is the accepted
      // cost of them being separate, and it is strictly better than buying into
      // a drained venue. The refusal that protects the owner's SOL is the FIRST
      // one, before the wrap; whoever reads this second run as that one will
      // conclude the SOL is safe when it is not.
      let route: JupiterRoute;
      try {
        route = await remeasureForSend(connection, policy.inMint, {
          vault,
          vaultIn: usdcAta,
          vaultTarget: targetAta,
          inputMint: policy.inMint,
          targetMint: mint,
          spend: amountIn,
          // The worst case, for the same reason the gate above uses it.
          feeBps: admission.worstCaseFees.get(mint.toBase58())?.bps ?? 0n,
          maxAge: { maxAgeMs: ROUTE_MAX_AGE_MS },
          ownerFloorRateWad: leg.minOutRateWad,
        });
      } catch (error) {
        // THE FIRST REFUSED IN THIS FILE THAT CAN BE REACHED AFTER MONEY HAS
        // MOVED, AND IT CARRIES THE MONEY WITH IT. Every other REFUSED sits
        // above the wrap; this one can fire on leg 1 of a three-leg basket with
        // leg 0 already confirmed — a real signature, real USDC spent, real
        // stock in the vault's ATA. bin/keeper.mts iterates
        // `invest.purchases ?? []` and is the only thing that ever writes them,
        // so returning without them is not a delay, it is a loss: the dashboard
        // and the vault's history show a turn that bought nothing while the
        // chain shows a completed buy. The catch below says exactly that about
        // FAILED, and this return used to be the exception to it.
        //
        // BOTH REFUSAL TYPES LAND HERE. VenueMeasurementRefusal is now the
        // depth verdict's as well as the slippage check's, and either is a
        // reasoned refusal rather than a fault — so neither is reported as a
        // FAILED turn naming an exception.
        if (!(error instanceof VenueMeasurementRefusal)) throw error;
        return {
          outcome: "REFUSED",
          detail: noted(
            `${error.message} — measured again at this leg's real ${amountIn} raw, after the wrap and convert. ` +
              "The vault is holding in-asset it did not get to spend; the refusal that keeps the owner's SOL as SOL is " +
              "the one before the wrap, not this one",
          ),
          purchases: purchases.length > 0 ? purchases : undefined,
        };
      }

      // THE TWO NUMBERS THE PROGRAM WILL CHECK, BOTH RE-DERIVED FROM THE BLOB
      // ABOUT TO BE SIGNED.
      //
      // investAmountIn refuses a route whose instruction spends anything other
      // than the amount this turn asked for: amount_in is the CALLER's number,
      // never the API's, and invest.rs bounds the caller's number against
      // min_investment, max_per_call and the 30-day cap. investMinOut
      // recomputes the venue's own floor out of that same blob's tail, takes
      // this mint's Token-2022 transfer fee off it once, and refuses a result
      // under the owner's signed min_out_rate_wad — which invest.rs would
      // otherwise reject with FloorTooLow after the fee had been paid.
      //
      // tightenMinOut IS GONE FROM THIS PATH, deliberately. It bounded a rate
      // this keeper OBSERVED by reading a pool itself, which is a thing it can
      // no longer do and no longer needs to: the number that has to hold is the
      // one the instruction we are signing actually guarantees, and only the
      // instruction knows it.
      const amountToSend = investAmountIn(route);
      const minOut = investMinOut(route);

      // An account that does not exist yet holds nothing, which balanceOf already
      // reports as zero, so the delta below is the purchase either way.
      const before = await balanceOf(connection, targetAta);
      const signature = await sendWithBudget(program.provider as anchor.AnchorProvider, crank, [
        ...(await plan.createsFor(targetAta)),
        await investCall(
          program,
          {
            crank: crank.publicKey,
            vault,
            policy: policyPda,
            vaultIn: usdcAta,
            vaultTarget: targetAta,
            targetMint: mint,
            // The same venue, from the same policy, for the same reason: invest.rs
            // pins it byte for byte against policy.venue_program.
            venueProgram: policy.venueProgram,
          },
          { legIndex: index, amountIn: amountToSend, minOut, venueData: route.venueData },
        )
          .remainingAccounts(venueAccountsOf(route))
          .instruction(),
      ], route, await tables.tablesFor(lookupTablesOf(route)));
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
          // THE OLD SENTENCE HERE REPORTED WHICH OF TWO BOUNDS WON, and under
          // Jupiter there are no longer two. tightenMinOut compared a rate this
          // keeper observed off a pool against the owner's signed floor and
          // said which was tighter; investMinOut takes the floor the ROUTE'S
          // OWN BYTES guarantee, nets the transfer fee off it, and REFUSES
          // outright if the result is under the owner's floor. So by the time a
          // leg is bought, min_out is the venue's guaranteed floor and it has
          // already cleared the owner's — there is no "policy floor won" case
          // left to report, because that case is now a refusal.
          " (min_out is the route's own guaranteed floor, net of the leg's transfer fee, checked against the owner's)",
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

/**
 * How old a quote this turn will sign against. Jupiter's own /swap-instructions
 * round trip and the vault-account read already sit inside this window, so it
 * is the whole life of a price from quote to compile, not a network budget.
 */
export const ROUTE_MAX_AGE_MS = 30_000;

/**
 * THE SECOND MEASUREMENT, for the amount that will really be sent — the route
 * and the verdict on it, together, or a refusal.
 *
 * WHY IT IS ONE FUNCTION AND NOT TWO CALL SITES. It used to be two, and they
 * drifted: the leg loop measured and then judged, while the CONVERT measured,
 * kept `measured.route` and never read `measured.venue` at all. The census was
 * computed and thrown away — under a comment three lines above saying "AND IT
 * IS MEASURED AGAIN, not merely quoted again ... this re-build carries its own
 * census". Only the slippage refusal survived there, because that one throws
 * from inside measureLegVenue. Returning the route ALONE is what makes the
 * omission unrepresentable: there is no venue left over to forget.
 *
 * WHY THE SECOND MEASUREMENT IS NEEDED AT ALL, and what it is not. A route's
 * instruction data carries the in-amount it was quoted for, so the gate's
 * route — built at this turn's CEILING — cannot be sent for the smaller amount
 * the budget or convertAmount settles on. The rebuild is therefore a different
 * route through possibly different AMMs (measured 2026-09-21: a 25 USD quote
 * on Kipseli+Manifest, a 1 USD quote of the same instant on Byreal+Manifest),
 * which is exactly why it has to be measured rather than trusted. It is a
 * SAFETY NET, not the doctrinal gate: a refusal here comes after the wrap.
 *
 * IT THROWS RATHER THAN RETURNING A VERDICT so that a caller cannot spend the
 * route by ignoring one branch, and so that both callers can give the same
 * refusal the outcome their own position demands — a rest for the convert, a
 * REFUSED turn for a leg.
 */
export async function remeasureForSend(
  connection: Connection,
  /** The mint the spend is denominated in: the policy's in_mint for a leg, wSOL for the convert. */
  spendMint: PublicKey,
  params: Parameters<typeof measureLegVenue>[1],
): Promise<JupiterRoute> {
  const { route, venue } = await measureLegVenue(connection, params);
  const stillDeep = legDepthDecision({ inMint: spendMint, legs: [venue] });
  if (!stillDeep.deep) throw new VenueMeasurementRefusal(stillDeep.detail);
  return route;
}

/**
 * Every venue this basket would trade against, measured in one pass, BEFORE the
 * wrap — the convert included.
 *
 * THE ROUTES IT BUILDS ARE NOT THE ROUTES THAT ARE SIGNED, and saying so is the
 * point of this paragraph. It used to return them, under a comment arguing that
 * "what was measured and what is spent have to be the same object" — and
 * nothing read them: both money paths rebuilt. They cannot be reused, either.
 * A route's instruction data carries the in-amount it was quoted for, and the
 * amount this turn ends up spending is smaller than the ceiling whenever the
 * convert brought in less than the cap or the 30-day headroom bit, so the blob
 * and amount_in would disagree and the program would be handed a swap for money
 * the vault is not spending.
 *
 * SO WHAT THIS GATE IS: a refusal BEFORE THE WRAP, taken at the largest size
 * this turn could reach, on routes that are then thrown away. Both arms are
 * monotone in size, so passing at the ceiling is passing for anything smaller.
 * What binds the route actually SIGNED is remeasureForSend, which measures and
 * judges each rebuild — the legs' and the convert's alike.
 *
 * SEQUENTIAL, NOT PARALLEL. Each leg costs two quotes and two account reads
 * against keyless public endpoints, and lite-api.jup.ag rate-limits; an 8-leg
 * basket firing sixteen quotes at once is a basket that measures nothing and
 * refuses itself. The cost is latency on a path that has already decided not to
 * be in a hurry.
 */
async function measureBasketVenues(
  connection: Connection,
  params: {
    readonly vault: PublicKey;
    readonly policy: InvestmentPolicyState;
    readonly legAtas: readonly PublicKey[];
    readonly usdcAta: PublicKey;
    readonly wsolAta: PublicKey;
    readonly spendCeiling: bigint;
    readonly convertCeiling: bigint;
    /** Each leg's WORST-CASE fee: what the slippage is sized against. */
    readonly admissionFees: ReadonlyMap<string, TransferFeeTerms>;
  },
): Promise<{ readonly legs: LegVenue[] }> {
  const legs: LegVenue[] = [];

  for (const [index, leg] of params.policy.legs.entries()) {
    const spend = legShare(params.spendCeiling, leg.weightBps);
    const target = params.legAtas[index]!;
    if (spend <= 0n) {
      // A leg this turn sends no transaction for is a leg with no venue to
      // judge; legDepthDecision skips it for the same reason. Nothing is
      // quoted for it either, so the measurement costs nothing.
      legs.push({ mint: leg.mint, spend, venueLabels: [], hops: [], censusScope: "every-hop", impact: { compared: false, why: "this leg's share of the budget rounds to nothing, so this turn sends no swap for it" } });
      continue;
    }
    const { venue } = await measureLegVenue(connection, {
      vault: params.vault,
      vaultIn: params.usdcAta,
      vaultTarget: target,
      inputMint: params.policy.inMint,
      targetMint: leg.mint,
      spend,
      // THE FEE THE ADMISSION GATE ALREADY READ, off the mint's own bytes and
      // the clock this turn read — not a second read that could disagree with
      // it. legSlippageBps turns it into a slippage strictly above itself, and
      // measureLegVenue refuses if the route builder's own read disagrees.
      //
      // THE WORST CASE, NOT THE ACTIVE FEE, and that is what stops the two from
      // disagreeing: buildJupiterRoute models the destination mint against its
      // own `fee.worstCase`, so sizing against today's rate would refuse every
      // basket for the two epochs before any scheduled rise. See
      // worstCaseTransferFee.
      feeBps: params.admissionFees.get(leg.mint.toBase58())?.bps ?? 0n,
      maxAge: { maxAgeMs: ROUTE_MAX_AGE_MS },
      ownerFloorRateWad: leg.minOutRateWad,
    });
    legs.push(venue);
  }

  // THE CONVERT, AS ONE MORE LEG OF THE SAME BASKET. feeBps is 0 because wSOL
  // and USDC are classic SPL Token mints with no extensions, so legSlippageBps
  // returns the keeper's plain 200. It feeds the SAME legDepthDecision call, so
  // a shallow convert refuses the whole basket and a shallow leg refuses the
  // convert — one verdict, before the wrap.
  if (params.convertCeiling > 0n) {
    const { venue } = await measureLegVenue(connection, {
      vault: params.vault,
      vaultIn: params.wsolAta,
      vaultTarget: params.usdcAta,
      inputMint: NATIVE_MINT,
      targetMint: params.policy.inMint,
      spend: params.convertCeiling,
      feeBps: 0n,
      maxAge: { maxAgeMs: ROUTE_MAX_AGE_MS },
      // NO ownerFloorRateWad HERE, DELIBERATELY. This gate asks whether the
      // venue is DEEP, and its verdict refuses the whole basket. The owner's
      // min_convert_rate_wad is a PRICE floor, and a price below it is a
      // market that moved — a reason to leave the SOL as SOL this sweep, not a
      // reason to stop buying with the USDC the vault already holds. Passing it
      // here would turn every dip under the floor into a whole-basket refusal;
      // the floor is applied on the send path below, where missing it rests the
      // conversion and the legs are bought as usual.
    });
    legs.push(venue);
  }

  return { legs };
}

async function balanceOf(connection: Connection, ata: PublicKey): Promise<bigint> {
  try {
    const res = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(res.value.amount);
  } catch {
    return 0n;
  }
}

/**
 * One Pyth feed account as this turn read it, or null when it is not one this
 * keeper will price against.
 *
 * THE OWNER IS CHECKED HERE AND NOWHERE ELSE. pyth.ts refuses a wrong size, a
 * wrong discriminator, an unknown verification variant and a feed id it was not
 * asked for — but bytes cannot say who WROTE them, so an account at the right
 * address holding the right-looking bytes is only Pyth's if the Pyth RECEIVER
 * program owns it (not the push program the addresses derive under). Null is
 * the whole vocabulary: every reason a feed is unusable rests the SOL hop the
 * same way, and oracleConvertDecision says so in words.
 */
function readPythFeed(
  info: { readonly owner: PublicKey; readonly data: Buffer } | null | undefined,
  expectedFeedIdHex: string,
): PythPriceUpdate | null {
  if (info === null || info === undefined || !info.owner.equals(PYTH_RECEIVER_PROGRAM)) return null;
  try {
    return decodePythPriceUpdate(info.data, expectedFeedIdHex);
  } catch {
    return null;
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

/**
 * The compute budget every money transaction this tick sends carries.
 *
 * A LIMIT WITHOUT A PRICE IS NOT A BID. Setting only the unit limit told the
 * scheduler how much room to reserve and offered nothing for it, so under
 * congestion these transactions are deprioritised and dropped — and there is
 * no retry anywhere. The price is small in absolute terms (1.4M units at
 * 10_000 micro-lamports is 14_000 lamports, on top of the 5_000-lamport
 * signature fee) and buys inclusion when it matters.
 *
 * ── WHY 1_400_000 AND NOT THE 600_000 THIS WAS ──────────────────────────────
 *
 * THE OLD NUMBER WAS DERIVED FOR A SWAP THIS KEEPER NO LONGER BUILDS. Its
 * comment read "600_000 UNITS COVERS THE CREATE TOO ... nothing next to the
 * CLMM swap it rides with": one Raydium CLMM swap plus an idempotent ATA
 * create. The venue moved to Jupiter and the number did not move with it — the
 * species docs/TESTING_TRAPS.md calls prose that outruns its measurement, here
 * outliving the thing it was measured of. The routes actually observed are not
 * one swap: measured 2026-09-21 against lite-api.jup.ag, USDC -> ANTHROPIC is a
 * 2-hop chain at $5/$25/$250 and 3-to-5-hop routes appear at the same sizes
 * (Scorch + Raydium CLMM + Manifest; BisonFi + Byreal + Scorch + GoonFi V2 +
 * Manifest), each hop a CPI of its own out of JUP6..., under the sip_vault
 * invest wrapper, with an ATA create in front on a leg's first buy.
 *
 * WHAT 1_400_000 IS, AND WHAT IT IS NOT. It is Jupiter's own answer: every
 * /swap-instructions response for these routes carried
 * computeUnitLimit = 1_400_000, which is also the per-transaction maximum the
 * runtime allows. It is NOT a consumption measurement — nothing here has
 * metered what one of these transactions really burns, and this comment does
 * not pretend otherwise. It is the safe end of an asymmetry: too high costs
 * 8_000 lamports a transaction over the old bid, while too low reverts with
 * "exceeded CUs" on EVERY sweep, reporting a compute error for what is really
 * a route one hop longer than the budget from a retired venue.
 *
 * THE VALUES AND THE ORDER ARE THE CLAIM. They are named here, once, because
 * the same two instructions now have to be laid down by two different builders
 * — the legacy one and the v0 one — and a congested slot must price a Jupiter
 * transaction exactly as it prices a Raydium one. A test pins both builders to
 * this list rather than to two typed-out copies of it.
 */
export const COMPUTE_UNIT_LIMIT = 1_400_000;
export const COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 10_000;

/** The compute-budget pair, in order, in front of the instructions they pay for. */
export function budgetedInstructions(
  instructions: readonly TransactionInstruction[],
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS }),
    ...instructions,
  ];
}

/**
 * One turn's address lookup tables, fetched once each however many legs want them.
 *
 * WHY A CACHE AND NOT A FETCH PER LEG. Jupiter hands back its OWN tables, and
 * the same two or three serve most routes — so an 8-leg basket that fetched
 * per leg would ask the RPC for the same 32-byte account eight times inside
 * one turn. The cache is per turn and not per process on purpose: a table is a
 * mutable account whose addresses can be extended, and a process-lifetime cache
 * would compile a message against a list the chain no longer has.
 *
 * THE PROMISE IS WHAT IS CACHED, not the resolved table, so two legs asking at
 * the same moment share one round trip instead of racing to start two. A
 * rejection is evicted: a transient RPC blip must not be remembered as this
 * table's permanent answer for the rest of the turn.
 *
 * A TABLE THE CHAIN DOES NOT HAVE IS A REFUSAL, NOT AN OMISSION. Compiling a
 * v0 message against a missing table would silently produce a message whose
 * account indexes resolve to nothing on the validator, which is a transaction
 * that fails after it has been signed and sent. It throws here instead, before
 * any of that.
 */
export function lookupTableCache(connection: Connection) {
  const byAddress = new Map<string, Promise<AddressLookupTableAccount>>();
  return {
    async tablesFor(addresses: readonly PublicKey[]): Promise<AddressLookupTableAccount[]> {
      return Promise.all(
        addresses.map((address) => {
          const name = address.toBase58();
          const known = byAddress.get(name);
          if (known !== undefined) return known;
          const pending = connection.getAddressLookupTable(address).then(({ value }) => {
            if (value === null) {
              throw new Error(`address lookup table ${name} is not on chain; the route that named it cannot be compiled`);
            }
            return value;
          });
          byAddress.set(name, pending);
          pending.catch(() => byAddress.delete(name));
          return pending;
        }),
      );
    },
  };
}

/**
 * The accounts one swap's `remainingAccounts` carries.
 *
 * EVERY isSigner IS false, AND MUST STAY false. The vault PDA is in the list
 * and cannot sign the OUTER instruction; invest.rs and convert.rs re-mark
 * exactly that key as a signer for the inner CPI, which is the whole authority
 * the program lends. buildJupiterRoute already does this, and the re-map here
 * is belt and braces over a list that arrives from an HTTP response.
 *
 * ONE VENUE, SO ONE ARM. This used to take `LiveRoute | JupiterRoute` and
 * branch on which it had, because the Raydium arm's metas were built here from
 * a pool read (buildSwapV2AccountMetas) while Jupiter's arrived whole. Naming
 * the union was what made the branch a question TypeScript could answer. With
 * Raydium retired the union is gone and so is the branch — but NOT the naming:
 * the parameter is still the concrete JupiterRoute rather than a structural
 * `{ remainingAccounts }`, because a weak type with one member accepts any
 * object at all and would go on compiling if the field were renamed.
 */
export function venueAccountsOf(route: JupiterRoute): AccountMeta[] {
  return route.remainingAccounts.map((meta) => ({ ...meta, isSigner: false }));
}

/**
 * A route's own address lookup tables.
 *
 * WHY THIS IS NOT INLINED. A multi-hop Jupiter route does not fit a legacy
 * transaction — measured 2026-09-21, five live USDC->ANTHROPIC routes ran
 * 1,268 to 1,938 bytes against a 1,232 limit, and every one of them fit once
 * its tables were applied. An EMPTY list is still a legitimate answer (a route
 * that named no tables), which is why sendWithBudget treats empty as legacy
 * rather than as an error.
 */
export function lookupTablesOf(route: JupiterRoute): readonly PublicKey[] {
  return route.lookupTableAddresses;
}


/**
 * The v0 transaction this tick sends when the route carries lookup tables.
 *
 * PURE, AND THAT IS THE POINT: no clock, no network, no key. Everything that
 * decides the transaction's BYTES is an argument, so the size of a real route
 * can be measured off exactly the object production sends — see
 * scripts/measure-route-size.mts and the byte counts pinned in
 * test/invest-transaction.test.ts.
 *
 * ANCHOR SETS NEITHER FIELD ON THIS BRANCH. AnchorProvider.sendAndConfirm
 * (0.32.1, provider.js) fills in `feePayer` and `recentBlockhash` only when the
 * transaction is a legacy one; for a VersionedTransaction it signs and sends
 * what it is handed. Both are therefore supplied here, and a message compiled
 * without them would be rejected by the cluster as unsigned-for/expired rather
 * than caught by a type.
 */
export function buildV0Transaction(params: {
  readonly payer: PublicKey;
  readonly recentBlockhash: string;
  readonly instructions: readonly TransactionInstruction[];
  readonly lookupTables: readonly AddressLookupTableAccount[];
}): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: params.payer,
    recentBlockhash: params.recentBlockhash,
    instructions: [...params.instructions],
  }).compileToV0Message([...params.lookupTables]);
  return new VersionedTransaction(message);
}

/**
 * The exact wire size of a versioned transaction, INCLUDING one that does not fit.
 *
 * WHY NOT serialize().length. web3.js encodes a v0 MESSAGE into a buffer of
 * exactly PACKET_DATA_SIZE, so past a 1,232-byte message
 * `VersionedTransaction.serialize()` does not return a large number — it
 * throws "encoding overruns Uint8Array". `v0TransactionBytes()` in
 * jupiter-route.ts calls it and inherits that. So the one question worth
 * asking — HOW FAR over the limit is this route without its lookup tables —
 * is the one question those cannot answer, and "it threw" is not a byte count.
 * Three of the five ANTHROPIC routes sampled on 2026-09-21 were that big.
 *
 * AND THE CAP IS ON THE MESSAGE, NOT THE TRANSACTION, which is its own trap:
 * the captured route's message is 1,203 bytes, so serialize() succeeds and
 * returns 1,268 — a transaction already 36 bytes past what the wire accepts.
 * A serialize() that did not throw is therefore no evidence that a route
 * fits; only the comparison against PACKET_DATA_SIZE is.
 *
 * So the length is computed from the compiled message instead, by the wire
 * format's own arithmetic: a version prefix, a 3-byte header, the static keys,
 * the blockhash, the instructions and the address-table lookups, under
 * compact-u16 counts, plus the signatures. A test asserts this agrees with
 * `serialize().length` byte for byte on every transaction small enough for
 * web3.js to serialize at all, which is what keeps the arithmetic honest.
 */
export function versionedTransactionBytes(transaction: VersionedTransaction): number {
  const message = transaction.message;
  const compact = (count: number): number => (count < 0x80 ? 1 : count < 0x4000 ? 2 : 3);
  let bytes = 1 + 3; // the 0x80 version prefix, then the three header bytes
  bytes += compact(message.staticAccountKeys.length) + 32 * message.staticAccountKeys.length;
  bytes += 32; // recentBlockhash
  bytes += compact(message.compiledInstructions.length);
  for (const instruction of message.compiledInstructions) {
    bytes += 1; // programIdIndex
    bytes += compact(instruction.accountKeyIndexes.length) + instruction.accountKeyIndexes.length;
    bytes += compact(instruction.data.length) + instruction.data.length;
  }
  bytes += compact(message.addressTableLookups.length);
  for (const lookup of message.addressTableLookups) {
    bytes += 32; // the table's own address
    bytes += compact(lookup.writableIndexes.length) + lookup.writableIndexes.length;
    bytes += compact(lookup.readonlyIndexes.length) + lookup.readonlyIndexes.length;
  }
  const signatures = message.header.numRequiredSignatures;
  return compact(signatures) + 64 * signatures + bytes;
}

export async function sendWithBudget(
  provider: anchor.AnchorProvider,
  crank: Keypair,
  /**
   * The instructions of one transaction, in order. A list rather than a single
   * instruction because a missing token account is created INSIDE the
   * transaction that uses it (tokenAccountPlan) instead of in one of its own.
   */
  instructions: readonly anchor.web3.TransactionInstruction[],
  /**
   * THE ROUTE THESE INSTRUCTIONS SPEND, AGED HERE — the last thing that happens
   * before the signature.
   *
   * REQUIRED, AND NOT OPTIONAL, because this is the check jupiter-route.ts
   * prescribes in words ("a caller that holds a route for a while re-runs
   * verifyRouteFresh before it signs") and nothing ran. The only enforcement
   * was the one INSIDE verifySharedAccountsRoute at build time, and the keeper
   * does a great deal after the build: a probe quote, readRouteAccounts, a
   * second findVaultOwnedTokenAccounts, balanceOf, the lazy token-account read,
   * a getAddressLookupTable per table and getLatestBlockhash — none of them
   * inside any age bound. min_out was sized against the quote's own
   * otherAmountThreshold, so a slow RPC or a rate-limited lite-api means
   * signing a floor nobody re-aged, and paying for the revert instead of
   * refusing for free. An optional parameter would have let a new call site
   * skip it silently, which is how it came to be skipped everywhere.
   */
  route: JupiterRoute,
  /**
   * The route's own lookup tables, already fetched — empty for a venue that
   * needs none.
   *
   * EMPTY MEANS LEGACY, AND EMPTY IS STILL REACHABLE. It no longer means
   * "Raydium": every route this keeper builds is now Jupiter's, and a Jupiter
   * route that names no lookup tables is an ordinary one-hop answer. A v0
   * message with no tables would be two bytes LARGER than the legacy encoding
   * of the same instructions and otherwise identical (v0TransactionBytes in
   * jupiter-route.ts), so there is nothing to gain by compiling one — and the
   * legacy send is the path that has been confirming on mainnet since 09-19.
   *
   * THIS IS NOT A SIZE CHECK, AND MUST NOT BE READ AS ONE. A route that named
   * no tables can still be too big; what makes that safe is that the tables a
   * route DOES name are always applied, never dropped for being inconvenient.
   */
  lookupTables: readonly AddressLookupTableAccount[] = [],
): Promise<string> {
  // AND IT IS THE BUILDER'S OWN CHECK, not a second spelling of it: the same
  // pure function, the same ROUTE_MAX_AGE_MS the build used, so a refusal here
  // carries the builder's "route-age" message — which distinguishes a market
  // that moved from an RPC that stalled.
  verifyRouteFresh(route, { nowMs: Date.now() }, { maxAgeMs: ROUTE_MAX_AGE_MS });
  const budgeted = budgetedInstructions(instructions);
  if (lookupTables.length === 0) {
    return provider.sendAndConfirm(new Transaction().add(...budgeted), [crank]);
  }

  // THE CRANK PAYS, AND ON THIS BRANCH IT MUST ALSO BE THE PROVIDER'S WALLET.
  //
  // On the legacy branch Anchor defaults `feePayer` to the provider's wallet,
  // so the fee payer there is the WALLET and the crank is merely an extra
  // signer. Here the fee payer is stated, and it is the crank — which is what
  // the rest of the keeper already believes (`crank-low` stops investing when
  // the CRANK empties, not when the wallet does).
  //
  // The two readings agree today only because bin/keeper.mts passes the settle
  // keypair as the crank — "the attester and the crank are this one key during
  // the hackathon". That is exactly the N=1 coincidence docs/TESTING_TRAPS.md
  // warns about, and it bites here: Anchor signs with its wallet AFTER us, and
  // VersionedTransaction.sign throws on a key that is not a required signer. So
  // the day the two keys separate, this branch would die inside web3.js with
  // "Cannot sign with non signer key". It says so itself instead.
  const wallet = provider.wallet.publicKey;
  if (!wallet.equals(crank.publicKey)) {
    throw new Error(
      `this transaction is payable by the crank ${crank.publicKey.toBase58()} but the provider's wallet is ${wallet.toBase58()}: ` +
        "Anchor signs a VersionedTransaction with its own wallet, which is not a signer of this message",
    );
  }

  // FRESH, AND READ HERE. Anchor reads a blockhash itself on the legacy branch
  // and not on this one; reading it as late as possible is also what gives the
  // transaction its full expiry window rather than one already spent on the
  // route's own round trips.
  const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
  const transaction = buildV0Transaction({
    payer: crank.publicKey,
    recentBlockhash: blockhash,
    instructions: budgeted,
    lookupTables,
  });
  return provider.sendAndConfirm(transaction, [crank]);
}

/** One token account a turn may need, and what it would take to create it. */
interface TokenAccountNeed {
  readonly address: PublicKey;
  readonly mint: PublicKey;
  readonly programId: PublicKey;
}

/**
 * The token accounts an invest turn may have to create: read ONCE, in one
 * request, and created only inside the transactions that actually use them.
 *
 * THE READ IS LAZY ON PURPOSE. It happens at the first transaction this turn is
 * about to send, not at the top: a turn that refuses on depth, on admission or
 * on the per-leg minimum sends nothing, so it should ask the chain nothing
 * either. It happens exactly once per turn however many accounts are wanted —
 * one getMultipleAccountsInfo for the vault's wSOL account, its USDC account and
 * every leg's target.
 *
 * AN ACCOUNT NAMED IS AN ACCOUNT SPOKEN FOR. Once its create has been handed to
 * a transaction it is struck off, so two transactions in the same turn that want
 * the same account do not both carry a create for it.
 *
 * A read that says an account exists when it does not would cost this turn one
 * failed transaction, and the turn is retried next sweep. A read that says an
 * account is missing when it exists costs nothing at all: the instruction is the
 * IDEMPOTENT one, and that is also what makes a race — anyone creating the
 * account between this read and the send — a no-op rather than a broken basket.
 */
function tokenAccountPlan(connection: Connection, payer: PublicKey, owner: PublicKey, needs: readonly TokenAccountNeed[]) {
  const byAddress = new Map(needs.map((need) => [need.address.toBase58(), need] as const));
  let missing: Set<string> | null = null;
  return {
    /** The create instructions to put in front of the transaction about to use `addresses` — none, once the accounts exist. */
    async createsFor(...addresses: readonly PublicKey[]): Promise<TransactionInstruction[]> {
      if (missing === null) {
        const wanted = [...byAddress.values()];
        const infos = await connection.getMultipleAccountsInfo(wanted.map((need) => need.address), "confirmed");
        missing = new Set(
          wanted.filter((_, index) => infos[index] === null || infos[index] === undefined).map((need) => need.address.toBase58()),
        );
      }
      const creates: TransactionInstruction[] = [];
      for (const address of addresses) {
        const name = address.toBase58();
        if (!missing.has(name)) continue;
        const need = byAddress.get(name)!;
        creates.push(createAssociatedTokenAccountIdempotentInstruction(payer, need.address, owner, need.mint, need.programId));
        missing.delete(name);
      }
      return creates;
    },
  };
}
