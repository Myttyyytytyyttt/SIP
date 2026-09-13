// --preflight: prove the module graph, the exported IDL and the classification
// invariants load in THIS image, with no network, no keys and no environment.
//
// Ported from the old supervisor's --preflight block. The Docker build runs it as
// the runtime user, so a broken image fails at build time, not at 3am on
// Railway. Beyond Nuvem's four classification invariants it pins what SIP's
// port depends on: the IDL is sip-vault's and not Nuvem's, it carries settle_v2
// and no V1 settle, its TradingLink discriminator is the one Anchor derives, and
// the shared attestation mirror loaded with its 171-byte message.

import { isExternalFlowTx } from "./measure-window.js";
import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID, accountDiscriminator, derivedDiscriminator, hasInstruction } from "./idl.js";
import { ATTESTATION_MESSAGE_LEN } from "./program-scripts.js";

export interface PreflightResult {
  readonly ok: boolean;
  readonly program: string;
  readonly invariants: number;
  readonly failure?: string;
}

const ED25519 = "Ed25519SigVerify111111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

export function runPreflight(): PreflightResult {
  const SIP = SIP_PROGRAM_ID;
  const invariants: [string, boolean, boolean][] = [
    // The anti-laundering invariant: a transaction that carries any trading
    // program is trading, even bundled with a settle.
    ["real settle is flow", isExternalFlowTx([ED25519, SIP, SYSTEM], SIP), true],
    ["pure deposit is flow", isExternalFlowTx([SYSTEM], SIP), true],
    ["clean trade is trading", isExternalFlowTx([JUPITER, SYSTEM], SIP), false],
    ["settle+trade bundle is trading", isExternalFlowTx([SIP, JUPITER, SYSTEM], SIP), false],
    ["the IDL is not Nuvem's program", SIP !== OLD_NUVEM_PROGRAM_ID, true],
    ["the IDL has settle_v2", hasInstruction("settle_v2"), true],
    ["the IDL has no V1 settle", hasInstruction("settle"), false],
    ["TradingLink discriminator is Anchor's", accountDiscriminator("TradingLink").equals(derivedDiscriminator("TradingLink")), true],
    ["the attestation message is 171 bytes", ATTESTATION_MESSAGE_LEN === 171, true],
  ];
  for (const [name, got, want] of invariants) {
    if (got !== want) {
      return { ok: false, program: SIP, invariants: invariants.length, failure: `invariant "${name}" is ${got}, expected ${want}` };
    }
  }
  return { ok: true, program: SIP, invariants: invariants.length };
}
