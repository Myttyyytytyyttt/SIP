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
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { summarizeUpstreamError } from "@sip/solana-log";
import { decodeVault, readInvestmentPolicy } from "./accounts.js";
import {
  CRANK_WRAP_RESERVE_LAMPORTS,
  USDC_MINT,
  WRAP_DUST_LAMPORTS,
  basketBudget,
  chainDay,
  convertAmount,
  convertDecision,
  decodeTokenAccountAmount,
  inMintDecision,
  investPauseDecision,
  legAdmissionDecision,
  legDepthDecision,
  legShare,
  oracleConvertDecision,
  readPoolPair,
  rollingDecision,
  routeRateWad,
  shouldConvert,
  turnSpendCeiling,
  wrapPlan,
  type ConvertDecision,
  type WrapPlan,
  type WrapReport,
} from "./invest-decision.js";
import { method } from "./methods.js";
import { NO_TRANSFER_FEE, tightenMinOut } from "./min-out.js";
import { RAYDIUM_CLMM, buildSwapV2AccountMetas, buildSwapV2Data, fetchLiveRoute } from "./program-scripts.js";
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
const WSOL_USDC_POOL = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");

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
  /**
   * What became of the wSOL, once the turn got as far as deciding: a convert
   * that landed and left some behind, or a convert the oracle would not price,
   * saying in both cases how much waits for a later sweep.
   */
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

  // AND ON THE SAME LINE, FOR THE SAME REASON: a leg whose mint the program
  // cannot buy safely — not Token-2022, a real transfer hook, or a transfer fee
  // above MAX_LEG_FEE_BPS — refuses the whole basket here, before the wrap.
  // Every one of those is knowable from the mint's own bytes, and the fee in
  // particular is the issuer's to change: these mints have already gone from 0
  // to 50 bps, and the same key can schedule 10_000. The decision itself is pure
  // (legAdmissionDecision); this only fetches the bytes and the epoch to judge
  // them in — the epoch out of the Clock ALREADY READ above, so the fee is
  // resolved against the very clock Token-2022 charges by.
  //
  // AND THE POOLS RIDE THAT SAME REQUEST. The depth gate below needs each
  // pool's own account, and this read was being sent anyway, so the pool
  // addresses go in beside the mints: the pool states cost this turn NOTHING —
  // no extra round trip, the same rule the Pyth feeds follow at the vault read.
  const currentEpoch = clockInfo.data.readBigUInt64LE(16);
  const legPools = policy.legs.map((leg) => deps.pools.get(leg.mint.toBase58())!);
  const legInfos = await connection.getMultipleAccountsInfo([...policy.legs.map((leg) => leg.mint), ...legPools], "confirmed");
  const admission = legAdmissionDecision({
    legs: policy.legs.map((leg, index) => {
      const info = legInfos[index] ?? null;
      return { mint: leg.mint, account: info === null ? null : { owner: info.owner, data: info.data } };
    }),
    currentEpoch,
  });
  if (!admission.admit) return { outcome: admission.outcome, detail: admission.detail };

  // AND ON THE SAME LINE AGAIN: whether those pools can actually serve what
  // this turn would push into them, RIGHT NOW.
  //
  // A BUILD-TIME CHECK CANNOT PROTECT AGAINST A POOL DRAINING. check:legs
  // passed a leg holding 6,700 dollars; two days later the same pool held 51,
  // and any buy over about 11 reverts. Nothing about the leg changed — depth is
  // a property of the moment, so it is measured in the turn, from the pools'
  // own vaults, against the amount this turn would really spend on each leg.
  //
  // THE AMOUNT IS THE ONE THE SWAP LOOP WILL USE, not a default purchase:
  // max_per_call caps the whole basket and is then split by weight, so a
  // 1,000-dollar cap over three legs is about 333 dollars into ONE pool. The
  // convert has not happened yet, so a converting turn is tested at the most it
  // could reach — and the budget below is clamped to that same ceiling, so what
  // was tested is what is spent (turnSpendCeiling).
  //
  // ONE MORE REQUEST, FOR THE WHOLE BASKET. The reserves live in the pools' two
  // token vaults, whose addresses are inside the states just read, so they
  // cannot be fetched in the same request; every leg's vaults go in one
  // getMultipleAccountsInfo rather than one per leg.
  const spendCeiling = turnSpendCeiling({
    held: usdcHeld,
    converting: converts,
    maxPerCall: policy.maxPerCall,
    headroom: rolling.headroom,
  });
  const poolReads = policy.legs.map((_leg, index) => readPoolPair(legInfos[policy.legs.length + index]));
  const vaultAddresses = [
    ...new Set(poolReads.flatMap((read) => (read.ok ? [read.pair.vault0.toBase58(), read.pair.vault1.toBase58()] : []))),
  ];
  const vaultAmounts = new Map<string, bigint>();
  if (vaultAddresses.length > 0) {
    const vaultInfos = await connection.getMultipleAccountsInfo(vaultAddresses.map((address) => new PublicKey(address)), "confirmed");
    for (const [index, info] of vaultInfos.entries()) {
      if (info === null || info === undefined) continue;
      try {
        vaultAmounts.set(vaultAddresses[index]!, decodeTokenAccountAmount(info.data));
      } catch {
        // Left out of the map on purpose: the gate refuses a reserve it could
        // not read rather than treating unreadable bytes as depth.
      }
    }
  }
  const depth = legDepthDecision({
    inMint: policy.inMint,
    vaultAmounts,
    legs: policy.legs.map((leg, index) => ({
      mint: leg.mint,
      pool: legPools[index]!,
      spend: legShare(spendCeiling, leg.weightBps),
      read: poolReads[index]!,
    })),
  });
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
  const legAtas = policy.legs.map((leg) => getAssociatedTokenAddressSync(leg.mint, vault, true, TOKEN_2022_PROGRAM_ID));
  const plan = tokenAccountPlan(connection, crank.publicKey, vault, [
    { address: wsolAta, mint: NATIVE_MINT, programId: TOKEN_PROGRAM_ID },
    { address: usdcAta, mint: USDC, programId: TOKEN_PROGRAM_ID },
    ...policy.legs.map((leg, index) => ({ address: legAtas[index]!, mint: leg.mint, programId: TOKEN_2022_PROGRAM_ID })),
  ]);

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
        // account this turn certainly used.
        await method(program, "wrapSol")(new anchor.BN(wrap.amount.toString()))
          .accountsPartial({
            crank: crank.publicKey, vault, policy: policyPda, vaultWsol: wsolAta,
            tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          })
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

      const route = await fetchLiveRoute(connection, WSOL_USDC_POOL, NATIVE_MINT, USDC, TOKEN_PROGRAM_ID);
      // THE SAME DECISION, ASKED AGAIN NOW THAT THERE IS A ROUTE TO COMPARE.
      // Its freshness arms passed before the wrap and cannot newly fire here —
      // the clock is the one this turn read — so what this second ask adds is
      // the deviation arm: what the captured swap REALLY traded at, against
      // what Pyth says the pair is worth.
      const priced = oracleConvertDecision({
        sol: solFeed,
        usdc: usdcFeed,
        nowUnixSeconds,
        routeWad: routeRateWad(route.observed),
      });
      if (!priced.convert) {
        // NOT A FAILURE, AND NOT THE END OF THE TURN. The wSOL stays wSOL, the
        // stranded-wSOL rescue at the top of this block picks it up on a later
        // sweep once the two agree again, and the USDC the vault already holds
        // is invested below exactly as it would have been.
        found.converted = `${held} wSOL was not converted, and waits for a later sweep: ${priced.detail}`;
      } else {
        const convertFloor = (toConvert * policy.minConvertRateWad) / 10n ** 18n;
        // USDC is a classic SPL Token mint with no extensions, so the convert's
        // output is credited in full and the observed rate needs no fee taken off.
        const { minOut } = tightenMinOut(toConvert, convertFloor, route.observed, NO_TRANSFER_FEE);
        const args = { payer: vault, inputTokenAccount: wsolAta, outputTokenAccount: usdcAta, amountIn: toConvert, minAmountOut: minOut };
        // The USDC account is created HERE when it is missing — inside the swap
        // that credits it, and only now that the route is in hand and the oracle
        // has agreed with it. A convert the oracle rested leaves no account
        // behind, which is the whole point.
        await sendWithBudget(program.provider as anchor.AnchorProvider, crank, [
          ...(await plan.createsFor(usdcAta)),
          await method(program, "convert")(new anchor.BN(toConvert.toString()), new anchor.BN(minOut.toString()), buildSwapV2Data(args))
            .accountsPartial({ crank: crank.publicKey, vault, policy: policyPda, vaultWsol: wsolAta, vaultIn: usdcAta, venueProgram: RAYDIUM_CLMM })
            .remainingAccounts(buildSwapV2AccountMetas(route, args).map((m) => ({ ...m, isSigner: false })))
            .instruction(),
        ]);
        if (toConvert < held) found.converted = `converted ${toConvert} of ${held} wSOL; ${held - toConvert} left for later sweeps`;
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
    let anyLive = false;
    for (const [index, leg] of policy.legs.entries()) {
      const weight = BigInt(leg.weightBps);
      const amountIn = legShare(budget, leg.weightBps);
      // A leg whose share rounds to nothing is skipped rather than sent: the
      // program refuses a zero min_out, and a zero-amount swap is a fee for
      // nothing.
      if (amountIn === 0n) continue;

      const mint = leg.mint;
      const pool = deps.pools.get(mint.toBase58())!;
      // DERIVED, NOT CREATED. The address is arithmetic over the mint and the
      // vault, so it costs nothing; whether the account EXISTS came out of the
      // plan's one batched read, and if it does not, the create rides the invest
      // below rather than a transaction of its own sent before the route was
      // even fetched.
      const targetAta = legAtas[index]!;

      const route = await fetchLiveRoute(connection, pool, USDC, mint, TOKEN_2022_PROGRAM_ID);
      const investFloor = (amountIn * leg.minOutRateWad) / 10n ** 18n;
      // THE OBSERVED PRICE IS THE POOL VAULT'S GROSS OUTFLOW; the vault's ATA is
      // credited that less this mint's fee, and that net delta is what both
      // swap_v2 and invest check their thresholds against. The fee comes off
      // before the slippage bound, so the bound is 2% of what actually arrives.
      const { minOut, live } = tightenMinOut(amountIn, investFloor, route.observed, admission.fees.get(mint.toBase58())!);
      anyLive = anyLive || live;

      const args = { payer: vault, inputTokenAccount: usdcAta, outputTokenAccount: targetAta, amountIn, minAmountOut: minOut };
      // An account that does not exist yet holds nothing, which balanceOf already
      // reports as zero, so the delta below is the purchase either way.
      const before = await balanceOf(connection, targetAta);
      const signature = await sendWithBudget(program.provider as anchor.AnchorProvider, crank, [
        ...(await plan.createsFor(targetAta)),
        await method(program, "invest")(index, new anchor.BN(amountIn.toString()), new anchor.BN(minOut.toString()), buildSwapV2Data(args))
          .accountsPartial({ crank: crank.publicKey, vault, policy: policyPda, vaultIn: usdcAta, vaultTarget: targetAta, targetMint: mint, venueProgram: RAYDIUM_CLMM })
          .remainingAccounts(buildSwapV2AccountMetas(route, args).map((m) => ({ ...m, isSigner: false })))
          .instruction(),
      ]);
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

async function sendWithBudget(
  provider: anchor.AnchorProvider,
  crank: Keypair,
  /**
   * The instructions of one transaction, in order. A list rather than a single
   * instruction because a missing token account is created INSIDE the
   * transaction that uses it (tokenAccountPlan) instead of in one of its own.
   */
  instructions: readonly anchor.web3.TransactionInstruction[],
): Promise<string> {
  // A LIMIT WITHOUT A PRICE IS NOT A BID. Setting only the unit limit told the
  // scheduler how much room to reserve and offered nothing for it, so under
  // congestion these transactions are deprioritised and dropped — and there is
  // no retry anywhere. The price is small in absolute terms (600k units at
  // 10_000 micro-lamports is 6_000 lamports, on top of the 5_000-lamport
  // signature fee) and buys inclusion when it matters.
  //
  // 600_000 UNITS COVERS THE CREATE TOO. An idempotent associated-token-account
  // creation costs on the order of 25k units — under 5% of this budget, and
  // nothing next to the CLMM swap it rides with.
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }))
    .add(...instructions);
  return provider.sendAndConfirm(tx, [crank]);
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
