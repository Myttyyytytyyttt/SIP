// TypeScript mirror of programs/sip-vault/src/link_consent.rs.
//
// THE WALLET'S CONSENT TO BE LINKED, AS BYTES. link_wallet no longer takes a
// signature on the transaction as consent, because a Privy seat can give one of
// those. It reads back an Ed25519SigVerify instruction, immediately before it,
// in which the wallet signed exactly these 140 bytes. A drifted mirror produces
// consents that never verify and nobody can link, so this file and the .rs are
// pinned to one golden vector computed with Python: tests/link-consent-v1.ts
// and the unit test in link_consent.rs.
//
// IN PRODUCTION NO SECRET KEY IS EVER HERE. The user's own session signs
// linkConsentMessage() with the embedded wallet's signMessage, which the seat's
// policy denies, and wraps the 64-byte signature with
// Ed25519Program.createInstructionWithPublicKey. linkConsentInstruction() takes
// a secret key for the tests, the drills and anything else that holds one.

import { Ed25519Program, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";

/** 0xFF, then "SIP_LINK_V1": a lead byte no transaction message can start with. */
export const LINK_CONSENT_DOMAIN = Buffer.concat([Buffer.from([0xff]), Buffer.from("SIP_LINK_V1", "latin1")]);

/** domain 12 · program, wallet, vault, owner 32×4 */
export const LINK_CONSENT_MESSAGE_LEN = 140;

export interface LinkConsentInputs {
  readonly programId: PublicKey;
  readonly wallet: PublicKey;
  /** The vault link_wallet derives from `owner`: ["vault", owner]. */
  readonly vault: PublicKey;
  readonly owner: PublicKey;
}

export function linkConsentMessage(inputs: LinkConsentInputs): Buffer {
  const message = Buffer.concat([
    LINK_CONSENT_DOMAIN,
    inputs.programId.toBuffer(),
    inputs.wallet.toBuffer(),
    inputs.vault.toBuffer(),
    inputs.owner.toBuffer(),
  ]);
  if (message.length !== LINK_CONSENT_MESSAGE_LEN) throw new Error("link consent message drifted");
  return message;
}

/** The Ed25519SigVerify instruction link_wallet expects immediately before it, signed by the wallet. */
export function linkConsentInstruction(walletSecretKey: Uint8Array, inputs: LinkConsentInputs): TransactionInstruction {
  return Ed25519Program.createInstructionWithPrivateKey({
    privateKey: walletSecretKey,
    message: linkConsentMessage(inputs),
  });
}

/**
 * link_wallet with the wallet's consent immediately before it: the one way the
 * tests and scripts link a wallet. Returns the method builder, so the caller
 * adds `.signers([...])` and sends it.
 *
 * `consent` replaces the genuine consent instructions, which is how the tests
 * prove that a missing, forged or misdirected consent is refused.
 */
export function linkWalletWithConsent(
  // Typed by shape, as tests/config-fixture.ts does: pinning the Program type
  // would drag the IDL types into a file the web and the keeper can import.
  program: { readonly programId: PublicKey; readonly methods: any },
  args: {
    readonly owner: PublicKey;
    readonly wallet: Keypair;
    readonly consent?: readonly TransactionInstruction[];
  },
) {
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), args.owner.toBuffer()], program.programId);
  const consent = args.consent ?? [
    linkConsentInstruction(args.wallet.secretKey, {
      programId: program.programId,
      wallet: args.wallet.publicKey,
      vault,
      owner: args.owner,
    }),
  ];
  return program.methods
    .linkWallet()
    .accounts({ owner: args.owner, wallet: args.wallet.publicKey })
    .preInstructions([...consent]);
}
