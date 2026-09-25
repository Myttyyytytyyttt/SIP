// --preflight: prove the module graph, the exported IDL, the classification
// invariants AND the money path's instruction builders work in THIS image, with
// no network, no keys and no environment.
//
// Ported from the old supervisor's --preflight block. The Docker build runs it as
// the runtime user, so a broken image fails at build time, not at 3am on
// Railway. Beyond Nuvem's four classification invariants it pins what SIP's
// port depends on: the IDL is sip-vault's and not Nuvem's, it carries settle_v2
// and no V1 settle, its TradingLink discriminator is the one Anchor derives, and
// the shared attestation mirror loaded with its 171-byte message and encodes the
// program's golden vector byte for byte.
//
// AND SINCE 2026-09-18, THE BUILDERS THEMSELVES. Every invariant above is pure
// data, and every one of them passed while the keeper threw "anchor.BN is not a
// constructor" on the first settleable span it ever saw. Anchor is CommonJS and
// Node's ESM lexer does not carry its `BN` across; vitest's interop does, so
// ~25 settle tests drove the very same builder and passed. A lazily-read
// namespace property is invisible to any gate that does not RUN THE BUILDER IN
// A REAL NODE PROCESS — which is exactly what the Dockerfile does with this
// file at image build time. So the last seven invariants build the four
// instructions the money paths send (settle_v2, wrap_sol, convert, invest) and
// compare their encoded bytes against fixed vectors — settle_v2 and convert
// three times over, at a zero argument and past the 4-byte boundary as well as
// in the comfortable middle, because those are the values production carries.
//
// STILL NO NETWORK, NO KEY, NO ENVIRONMENT: the Connection behind the Program
// carries a `fetch` that throws, so a builder that ever needs an account
// resolved fails here loudly instead of reaching out of a build container.
// Measured cost of all four: 3 ms.

import { readFileSync } from "node:fs";
import type * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { GOLDEN_V2_HEX, GOLDEN_V2_INPUTS } from "./attestation-golden.js";
import { JUPITER_V6_PROGRAM } from "./invest-decision.js";
import { convertCall, investCall, wrapSolCall } from "./invest-tick.js";
import { tradeNotional } from "./measure-volume.js";
import { isExternalFlowTx, readTransaction } from "./measure-window.js";
import {
  OLD_NUVEM_PROGRAM_ID,
  SIP_PROGRAM_ID,
  accountDiscriminator,
  derivedDiscriminator,
  hasInstruction,
  idl,
  instructionDiscriminator,
} from "./idl.js";
import { ATTESTATION_MESSAGE_LEN, attestationMessage } from "./program-scripts.js";
import { settleInstruction } from "./settle-tick.js";

export interface PreflightResult {
  readonly ok: boolean;
  readonly program: string;
  readonly invariants: number;
  readonly failure?: string;
}

/**
 * HOW MANY CHECKS A WHOLE PREFLIGHT IS — asserted, not merely reported.
 *
 * runPreflight() used to return `invariants: invariants.length` and bin/keeper.mts
 * only ever tested `result.ok`, so the gate could SHRINK in silence. Measured:
 * delete the settle_v2 build and its entry from buildOffline — a plausible
 * refactor — and put the broken BN spelling back in settle-tick.ts, and the
 * preflight logs {"preflight":"ok","invariants":13} and exits 0. The exact
 * outage of 2026-09-18 walks back into an image with the whole automatic gate
 * green, because nothing anywhere said how much the gate was supposed to cover.
 *
 * So the number lives here, next to the thing it measures, and a preflight that
 * does not reach it FAILS. Adding or removing a check means changing this line
 * on purpose — which is the point. test/attestation-golden.test.ts holds the
 * second copy, under vitest.
 */
export const EXPECTED_INVARIANTS = 20;

/**
 * THE VOLUME RULE, IN THE IMAGE THAT WILL CHARGE ON IT. Two of the owner's real
 * mainnet transactions (test/fixtures/volume-mainnet.json), decoded by web3.js
 * through readTransaction exactly as a live walk decodes them, version 1 message
 * included: his first buy of 2026-09-23 must measure 1 010 000 000 lamports and our
 * settle of 2026-09-19 nothing. Under vitest a CommonJS interop fault is invisible
 * (see anchor-interop.ts); this runs under the image's own Node.
 */
async function volumeVector(): Promise<{ readonly buy: bigint | null; readonly settle: boolean }> {
  const file = JSON.parse(readFileSync(new URL("../test/fixtures/volume-mainnet.json", import.meta.url), "utf8")) as {
    readonly fixtures: Readonly<Record<string, { readonly signature: string; readonly wallet: string; readonly result: unknown }>>;
  };
  const answer = (name: string) => file.fixtures[name]!;
  const connection = new Connection("http://preflight.invalid", {
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { readonly id: unknown; readonly params: readonly unknown[] };
      const entry = Object.values(file.fixtures).find((candidate) => candidate.signature === request.params[0]);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: entry?.result ?? null }), { status: 200 });
    },
  });
  const measured = async (name: string) => {
    const tx = await readTransaction(connection, answer(name).signature, "finalized");
    if (tx === null) throw new Error(`the volume vector ${name} decoded to null`);
    return tradeNotional(tx, new PublicKey(answer(name).wallet), SIP_PROGRAM_ID);
  };
  const buy = await measured("owner-buy-1");
  const settle = await measured("owner-settle-2026-09-19");
  return { buy: buy.counted ? buy.lamports : null, settle: settle.counted };
}

const ED25519 = "Ed25519SigVerify111111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/**
 * The four instructions the money paths send, built offline from fixed inputs.
 *
 * EVERY ONE OF THEM IS THE KEEPER'S OWN BUILDER, not a copy: settleInstruction
 * is the exact function runSettleTick calls, and wrapSolCall, convertCall and
 * investCall are the exact ones runInvestTick calls. The three invest builders
 * were inline inside investTurn until 2026-09-18 and this file carried copies
 * of them — which is a gate that proves the copy works: measured, the same
 * `new anchor.BN` that took the keeper down could be put back at all three
 * invest sites with tsc and this preflight both green. A copy cannot fail the
 * way production fails, so there are no copies here any more.
 *
 * Everything is fabricated: the all-zero pubkey for every account, 100 and 200
 * for the invest amounts, and GOLDEN_V2_INPUTS' own slots for the settle. No
 * account is fetched — settle_v2's accounts all arrive through accountsPartial
 * or are fixed addresses in the IDL — and the Connection's fetch throws if that
 * ever stops being true.
 */
interface OfflineBuild {
  readonly vectors: readonly { readonly name: string; readonly hex: string }[];
  /**
   * Whether convert and invest BOTH carry, as an account, the venue program
   * they were handed.
   *
   * WHY THIS IS NOT COVERED BY THE VECTORS ABOVE. They compare instruction
   * DATA, and the venue is an ACCOUNT — so a builder that dropped
   * `venueProgram` from its accountsPartial would build byte-identical data and
   * pass every vector here. On chain it is the opposite of a silent failure and
   * the opposite of a cheap one: convert.rs:88-91 and invest.rs:119-122 both
   * `require!(venue_program.key() == policy.venue_program)`, so every convert
   * and every invest for every vault would revert with WrongVenue, on every
   * sweep, reported by this keeper as one more FAILED turn naming nothing.
   *
   * IT IS NEW BECAUSE THE DEFAULT IS GONE. Until 2026-09-21 both builders
   * defaulted the account to RAYDIUM_CLMM when a caller omitted it, so omitting
   * it produced a WRONG venue rather than a MISSING one. The default was
   * removed with the move to Jupiter — a default that names a venue this keeper
   * refuses is worse than none — and this invariant is what now stands where it
   * stood.
   */
  readonly venueAccountsPresent: boolean;
}

async function buildOffline(): Promise<OfflineBuild> {
  const refuse = async (): Promise<never> => {
    throw new Error("the preflight builds instructions only: this provider signs nothing");
  };
  const connection = new Connection("http://127.0.0.1:1", {
    fetch: () => {
      throw new Error("the preflight tried to make an RPC call: an instruction builder now needs the chain");
    },
  });
  const provider = new AnchorProvider(
    connection,
    { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse },
    { commitment: "confirmed" },
  );
  const program = new Program(idl as anchor.Idl, provider);
  const zero = PublicKey.default;
  // THE VENUE BLOB, FIXED, AND NO LONGER BUILT HERE.
  //
  // This used to be a SwapV2Args that buildSwapV2Data turned into Raydium
  // swap_v2 bytes, because the venue was always Raydium. convert and invest
  // take `venue_data: Vec<u8>` and hand it to invoke_signed VERBATIM — they
  // never look at a byte — so under Jupiter the blob is `route.venueData`,
  // built by Jupiter's /swap-instructions and verified by
  // verifySharedAccountsRoute. None of that can happen here: this process has
  // no network, and it must not get one.
  //
  // SO THE BLOB IS A FIXTURE, AND THE VECTOR NOW COVERS IT. The old vectors
  // stopped at 24 and 25 bytes and let the tail go unchecked, on the grounds
  // that buildSwapV2Data had its own test. The tail is now the caller's
  // argument, which means the thing worth proving in THIS process is that
  // Anchor's coder still writes a Vec<u8> as a 4-byte little-endian length
  // followed by the bytes: get that wrong and every CPI this keeper makes is
  // handed a malformed instruction by a builder that threw no error. The
  // vectors below therefore pin the WHOLE data, blob included.
  //
  // The first eight bytes are Jupiter's real shared_accounts_route
  // discriminator (c1209b3341d69c81), so a reader meets a recognisable value
  // rather than filler; the four after it are deliberately not a valid route
  // tail, because nothing here may look like a route that could be sent.
  const venueData = Buffer.from("c1209b3341d69c81deadbeef", "hex");

  const link = { wallet: zero, vault: zero, linkAddress: zero };

  const settle = await settleInstruction(program, link, GOLDEN_V2_INPUTS);
  // THE TWO EDGES PRODUCTION ACTUALLY HITS, which GOLDEN_V2_INPUTS does not:
  // every one of its numbers is non-zero and below 2^32.
  //
  // A ZERO BASE IS A SUPPORTED OUTCOME, not an edge case — settle-tick settles
  // one for a flat span, and for a losing PROFIT prefix whose carry is recorded.
  // And in VOLUME mode baseLamports is session notional, which passes 2^32
  // lamports at 4.29 SOL of volume: ordinary for the wallet this keeper watches.
  // The wide vector also carries 2^53+1 as the deadline, the first integer a
  // float64 cannot hold, so a builder that ever routes a u64 through Number
  // encodes 2^53 here and is caught.
  const settleZero = await settleInstruction(program, link, { ...GOLDEN_V2_INPUTS, baseLamports: 0n });
  const settleWide = await settleInstruction(program, link, {
    ...GOLDEN_V2_INPUTS,
    sessionStartSlot: 4_294_967_295n,
    sessionEndSlot: 4_294_967_296n,
    baseLamports: 18_446_744_073_709_551_615n,
    validUntilSlot: 9_007_199_254_740_993n,
  });
  const wrapSol = await wrapSolCall(program, { crank: zero, vault: zero, policy: zero, vaultWsol: zero }, 100n).instruction();
  const convert = await convertCall(
    program,
    { crank: zero, vault: zero, policy: zero, vaultWsol: zero, vaultIn: zero, venueProgram: JUPITER_V6_PROGRAM },
    { amountIn: 100n, minOut: 200n, venueData },
  ).instruction();
  // The same range on the invest path's u64s: convert carries session-sized
  // amounts too, and its two arguments sit either side of a width mistake.
  const convertWide = await convertCall(
    program,
    { crank: zero, vault: zero, policy: zero, vaultWsol: zero, vaultIn: zero, venueProgram: JUPITER_V6_PROGRAM },
    { amountIn: 9_007_199_254_740_993n, minOut: 18_446_744_073_709_551_615n, venueData },
  ).instruction();
  const invest = await investCall(
    program,
    { crank: zero, vault: zero, policy: zero, vaultIn: zero, vaultTarget: zero, targetMint: zero, venueProgram: JUPITER_V6_PROGRAM },
    { legIndex: 0, amountIn: 100n, minOut: 200n, venueData },
  ).instruction();

  const carriesVenue = (instruction: { readonly keys: readonly { readonly pubkey: PublicKey }[] }): boolean =>
    instruction.keys.some((key) => key.pubkey.equals(JUPITER_V6_PROGRAM));

  return {
    venueAccountsPresent: carriesVenue(convert) && carriesVenue(convertWide) && carriesVenue(invest),
    vectors: [
    { name: "settle_v2", hex: settle.data.toString("hex") },
    { name: "settle_v2 zero base", hex: settleZero.data.toString("hex") },
    { name: "settle_v2 wide u64s", hex: settleWide.data.toString("hex") },
    { name: "wrap_sol", hex: wrapSol.data.toString("hex") },
    // WHOLE, NOT TRUNCATED: the tail is the venue blob this keeper now passes
    // through, and its length prefix is the thing worth checking here.
    { name: "convert", hex: convert.data.toString("hex") },
    { name: "convert wide u64s", hex: convertWide.data.toString("hex") },
    { name: "invest", hex: invest.data.toString("hex") },
    ],
  };
}

/**
 * What each builder must encode, argument for argument.
 *
 * settle_v2 carries GOLDEN_V2_INPUTS' own numbers, so these bytes are the same
 * mode, start, end, base and deadline that appear inside GOLDEN_V2_HEX above:
 * mode 1, then 100, 200, 1_000_000_000 and 300 as little-endian u64s. If a BN
 * ever arrives from a different bn.js than anchor's coder expects, this is
 * where it shows up — as wrong bytes, not as a throw.
 *
 * AND THE RANGE, NOT ONLY ONE POINT IN IT. Every number in that vector is
 * non-zero and below 2^32, so a u64 that misencodes only at zero or only past
 * the 4-byte boundary would build byte-identical bytes for it and ship. A
 * settle whose args disagree with the signed attestation is rejected by the
 * program, which looks like a settle that silently never lands, sweep after
 * sweep — the outage of 2026-09-18 with a different cause. Hence the zero and
 * wide vectors: 0, 2^32-1, 2^32, 2^53+1 and u64::MAX, on both money paths.
 */
const BUILDER_VECTORS: ReadonlyMap<string, string> = new Map([
  ["settle_v2", `${instructionDiscriminator("settle_v2").toString("hex")}016400000000000000c80000000000000000ca9a3b000000002c01000000000000`],
  // Eight zero bytes where the base goes, and nothing else moved.
  ["settle_v2 zero base", `${instructionDiscriminator("settle_v2").toString("hex")}016400000000000000c800000000000000${"00".repeat(8)}2c01000000000000`],
  // 2^32-1, 2^32, u64::MAX, 2^53+1 — computed with Python's int.to_bytes, not
  // by asking the builder what it produces.
  ["settle_v2 wide u64s", `${instructionDiscriminator("settle_v2").toString("hex")}01ffffffff000000000000000001000000ffffffffffffffff0100000000002000`],
  ["wrap_sol", `${instructionDiscriminator("wrap_sol").toString("hex")}6400000000000000`],
  // 0c000000 is 12 as a little-endian u32: the Vec<u8> length that must precede
  // the blob. Written out rather than computed from `venueData.length`, so that
  // a coder which stopped emitting the prefix — or emitted it at a different
  // width — is caught instead of being described.
  ["convert", `${instructionDiscriminator("convert").toString("hex")}6400000000000000c8000000000000000c000000c1209b3341d69c81deadbeef`],
  ["convert wide u64s", `${instructionDiscriminator("convert").toString("hex")}0100000000002000ffffffffffffffff0c000000c1209b3341d69c81deadbeef`],
  ["invest", `${instructionDiscriminator("invest").toString("hex")}006400000000000000c8000000000000000c000000c1209b3341d69c81deadbeef`],
]);

export async function runPreflight(): Promise<PreflightResult> {
  const SIP = SIP_PROGRAM_ID;
  const invariants: [string, boolean, boolean][] = [
    // The anti-laundering invariant: a transaction that carries any trading
    // program is trading, even bundled with a settle.
    ["real settle is flow", isExternalFlowTx([ED25519, SIP, SYSTEM], SIP), true],
    ["pure deposit is flow", isExternalFlowTx([SYSTEM], SIP), true],
    ["clean trade is trading", isExternalFlowTx([JUPITER, SYSTEM], SIP), false],
    ["settle+trade bundle is trading", isExternalFlowTx([SIP, JUPITER, SYSTEM], SIP), false],
    ["the IDL is not the retired program", SIP !== OLD_NUVEM_PROGRAM_ID, true],
    ["the IDL has settle_v2", hasInstruction("settle_v2"), true],
    ["the IDL has no V1 settle", hasInstruction("settle"), false],
    ["TradingLink discriminator is Anchor's", accountDiscriminator("TradingLink").equals(derivedDiscriminator("TradingLink")), true],
    ["the attestation message is 171 bytes", ATTESTATION_MESSAGE_LEN === 171, true],
    // THE BYTES, NOT ONLY THEIR COUNT. A mirror that swapped two fields of one
    // width keeps its length and signs attestations settle_v2 never verifies.
    // Checked in the image that will sign, against the vector attestation.rs's
    // own unit test pins; the image has no attestation.rs, hence the copy.
    [
      "the attestation mirror matches the program golden vector",
      attestationMessage(GOLDEN_V2_INPUTS).toString("hex") === GOLDEN_V2_HEX,
      true,
    ],
  ];

  // THE BUILDERS RUN IN THIS PROCESS. A builder that throws is the failure —
  // caught here so the image build ends on one readable line rather than a
  // stack — and a builder that returns the wrong bytes is a failure too.
  let built: OfflineBuild;
  try {
    built = await buildOffline();
  } catch (error) {
    return {
      ok: false,
      program: SIP,
      invariants: invariants.length + BUILDER_VECTORS.size,
      failure: `an instruction builder threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // A BUILDER SILENTLY DROPPED FROM THE RETURNED ARRAY is a vector that is
  // never compared: `hex === BUILDER_VECTORS.get(name)` is only ever evaluated
  // for what buildOffline handed back. Counting the two sides against each
  // other is what makes a missing build a failure instead of a smaller gate.
  if (built.vectors.length !== BUILDER_VECTORS.size) {
    return {
      ok: false,
      program: SIP,
      invariants: invariants.length + built.vectors.length,
      failure: `the preflight built ${built.vectors.length} instructions for ${BUILDER_VECTORS.size} vectors: a money-path builder is not being checked`,
    };
  }
  for (const { name, hex } of built.vectors) {
    invariants.push([`${name} builds the bytes it has always built`, hex === BUILDER_VECTORS.get(name), true]);
  }
  invariants.push(["convert and invest carry the venue account they were given", built.venueAccountsPresent, true]);
  let volume: Awaited<ReturnType<typeof volumeVector>>;
  try {
    volume = await volumeVector();
  } catch (error) {
    return { ok: false, program: SIP, invariants: invariants.length, failure: `the volume vector threw: ${error instanceof Error ? error.message : String(error)}` };
  }
  invariants.push(["the volume rule measures the owner's first buy at 1 010 000 000 lamports", volume.buy === 1_010_000_000n, true]);
  invariants.push(["the volume rule does not count our own settle", volume.settle, false]);

  for (const [name, got, want] of invariants) {
    if (got !== want) {
      return { ok: false, program: SIP, invariants: invariants.length, failure: `invariant "${name}" is ${got}, expected ${want}` };
    }
  }
  // EVERY CHECK PASSED — BUT WERE THEY ALL HERE? A gate nobody counts is a gate
  // that can be refactored down to nothing while still printing "ok".
  if (invariants.length !== EXPECTED_INVARIANTS) {
    return {
      ok: false,
      program: SIP,
      invariants: invariants.length,
      failure: `the preflight checked ${invariants.length} invariants, not ${EXPECTED_INVARIANTS}: the gate itself changed size`,
    };
  }
  return { ok: true, program: SIP, invariants: invariants.length };
}
