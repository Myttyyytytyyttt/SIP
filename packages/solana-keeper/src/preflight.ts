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
// file at image build time. So the last four invariants build the four
// instructions the money paths send (settle_v2, wrap_sol, convert, invest) and
// compare their encoded bytes against fixed vectors.
//
// STILL NO NETWORK, NO KEY, NO ENVIRONMENT: the Connection behind the Program
// carries a `fetch` that throws, so a builder that ever needs an account
// resolved fails here loudly instead of reaching out of a build container.
// Measured cost of all four: 3 ms.

import type * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { GOLDEN_V2_HEX, GOLDEN_V2_INPUTS } from "./attestation-golden.js";
import { convertCall, investCall, wrapSolCall } from "./invest-tick.js";
import { isExternalFlowTx } from "./measure-window.js";
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
async function buildOffline(): Promise<{ readonly name: string; readonly hex: string }[]> {
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
  const swap = { payer: zero, inputTokenAccount: zero, outputTokenAccount: zero, amountIn: 100n, minAmountOut: 200n };

  const settle = await settleInstruction(program, { wallet: zero, vault: zero, linkAddress: zero }, GOLDEN_V2_INPUTS);
  const wrapSol = await wrapSolCall(program, { crank: zero, vault: zero, policy: zero, vaultWsol: zero }, 100n).instruction();
  const convert = await convertCall(
    program,
    { crank: zero, vault: zero, policy: zero, vaultWsol: zero, vaultIn: zero },
    { amountIn: 100n, minOut: 200n, swap },
  ).instruction();
  const invest = await investCall(
    program,
    { crank: zero, vault: zero, policy: zero, vaultIn: zero, vaultTarget: zero, targetMint: zero },
    { legIndex: 0, amountIn: 100n, minOut: 200n, swap },
  ).instruction();

  return [
    { name: "settle_v2", hex: settle.data.toString("hex") },
    { name: "wrap_sol", hex: wrapSol.data.toString("hex") },
    // The swap blob that follows the two amounts is pinned by
    // test/shared-modules.test.ts; here only the args the BNs produced matter.
    { name: "convert", hex: convert.data.subarray(0, 24).toString("hex") },
    { name: "invest", hex: invest.data.subarray(0, 25).toString("hex") },
  ];
}

/**
 * What each builder must encode, argument for argument.
 *
 * settle_v2 carries GOLDEN_V2_INPUTS' own numbers, so these bytes are the same
 * mode, start, end, base and deadline that appear inside GOLDEN_V2_HEX above:
 * mode 1, then 100, 200, 1_000_000_000 and 300 as little-endian u64s. If a BN
 * ever arrives from a different bn.js than anchor's coder expects, this is
 * where it shows up — as wrong bytes, not as a throw.
 */
const BUILDER_VECTORS: ReadonlyMap<string, string> = new Map([
  ["settle_v2", `${instructionDiscriminator("settle_v2").toString("hex")}016400000000000000c80000000000000000ca9a3b000000002c01000000000000`],
  ["wrap_sol", `${instructionDiscriminator("wrap_sol").toString("hex")}6400000000000000`],
  ["convert", `${instructionDiscriminator("convert").toString("hex")}6400000000000000c800000000000000`],
  ["invest", `${instructionDiscriminator("invest").toString("hex")}006400000000000000c800000000000000`],
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
  let built: { readonly name: string; readonly hex: string }[];
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
  for (const { name, hex } of built) {
    invariants.push([`${name} builds the bytes it has always built`, hex === BUILDER_VECTORS.get(name), true]);
  }

  for (const [name, got, want] of invariants) {
    if (got !== want) {
      return { ok: false, program: SIP, invariants: invariants.length, failure: `invariant "${name}" is ${got}, expected ${want}` };
    }
  }
  return { ok: true, program: SIP, invariants: invariants.length };
}
