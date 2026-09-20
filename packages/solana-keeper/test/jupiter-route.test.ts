// What the Jupiter route builder REFUSES, and the arithmetic of gross versus net.
//
// WHY THE REFUSALS ARE THE TEST. sip_vault's invest() forwards the route's
// accounts and data verbatim and lends the vault PDA's signature to them. Its
// own guards are three — no unmeasured vault account, spent <= amount_in,
// received >= min_out — and they all fire AFTER the CPI, on a transaction that
// has already been signed. Everything that has to be true BEFORE we sign is
// checked in jupiter-route.ts, so a check that quietly stops working is a
// signature lent to bytes nobody verified. Each refusal below therefore
// asserts its own condition name: delete the check it covers and this file
// goes red, either because the route is accepted or because a different guard
// answers.
//
// THE FIXTURE IS A REAL MAINNET BUILD, not a hand-written shape: the
// USDC -> SPYx single-hop sharedAccountsRoute that lite-api.jup.ag returned on
// 2026-09-20 for the owner's vault EFXK995… (25 USDC in, 32 accounts, 36 bytes
// of data, quote out 3,254,246 threshold 3,221,704 at 100 bps).
//
// This file lives in the keeper's suite because packages/solana-program has no
// vitest — its `test` script is `anchor test` — and a new file here merges
// cleanly and runs in a gate that already exists.

import { PublicKey, TransactionInstruction, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JupiterRouteRefusal,
  buildJupiterRoute,
  type JupiterQuote,
  type JupiterSwapInstructions,
  type RefusalCondition,
  type JupiterRoute,
  type RouteRequest,
  type TransferFeeRate,
  type VerifyContext,
  ROUTE_DISC,
  SHARED_ACCOUNTS_ROUTE_DISC,
  decodeRouteAmounts,
  findVaultOwnedTokenAccounts,
  fitsLegacyTransaction,
  investAmountIn,
  legacyTransactionBytes,
  netOfTransferFee,
  ownerFloorFor,
  pricedAtSlot,
  routeMints,
  transferFeeForEpoch,
  verifyQuoteAnswersRequest,
  verifyRouteFresh,
  transferFeeOn,
  v0TransactionBytes,
  venueThresholdFrom,
  verifySharedAccountsRoute,
} from "@sip/solana-program/jupiter-route";
import { venueFlags } from "@sip/solana-program/jupiter-fork-setup";
// TYPE-ONLY, AND ON PURPOSE. It is erased at runtime — phase 3 must not run
// because a unit test imported it — but tsc still pulls the module into this
// package's program, and the keeper's typecheck is the only gate either fork
// script is in. Nothing else in the repo imports them: they are run by
// jupiter-fork.sh through tsx, which typechecks nothing.
import type { RouteFile } from "@sip/solana-program/jupiter-fork-test";

const VAULT = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";
const VAULT_USDC = "46zCguSBbuStXvbJ3YdxVCVs72gXtDcKJEoseMFv7uof";
const VAULT_SPYX = "FNsKE5tXJU9CaBT5qt4TzuqNbK96ZfLPFJFwLndaRgrR";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPYX = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** An intermediate a multi-hop route threads through, and the vault's two ATAs for it. */
const WSOL = "So11111111111111111111111111111111111111112";
const VAULT_WSOL_LEGACY = "6uaqMU6exBZVVFj566NNAW7BWCVYP3J7EicYicerHrfb";
const VAULT_WSOL_2022 = "etvVTW7gDVXnmQ4t1r3hjLdtJpn2xgcoBcBxCLaZynD";

/** The captured instruction's account list: [pubkey, isSigner, isWritable]. */
const CAPTURED_ACCOUNTS: ReadonlyArray<readonly [string, boolean, boolean]> = [
  ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", false, false],
  ["CapuXNQoDviLvU1PxFiizLgPNQCxrsag1uMeyk6zLVps", false, false],
  [VAULT, true, false],
  [VAULT_USDC, false, true],
  ["Gjmjory7TWKJXD2Jc6hKzAG991wWutFhtbXudzJqgx3p", false, true],
  ["DVvjCHZbZz67Hh986mkFkV5mEaNumYTt5zahH75vhegL", false, true],
  [VAULT_SPYX, false, true],
  [USDC, false, false],
  [SPYX, false, false],
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", false, false],
  ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", false, false],
  ["D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf", false, false],
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", false, false],
  ["HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq", false, false],
  ["CapuXNQoDviLvU1PxFiizLgPNQCxrsag1uMeyk6zLVps", false, false],
  ["HZzqEWHEvSiqYt6PxxLs7zXETmqGuryqfmvggjAkqisp", false, false],
  ["Ph2aw6fSKja9MT39L27gwJcZi3F8hZL4xMnuVh36h8a", false, true],
  ["Gjmjory7TWKJXD2Jc6hKzAG991wWutFhtbXudzJqgx3p", false, true],
  ["DVvjCHZbZz67Hh986mkFkV5mEaNumYTt5zahH75vhegL", false, true],
  ["J1aAkLsEteJBu3uc1tXMg4aBz84zLkgxJpRifjXYb7YV", false, true],
  ["8gkg3zLZAvx49M5bPXoAup8v4iSppLCV4DckBhrVPCX5", false, true],
  ["2tQSmPJELH1HKHrxzFTqUibbo1R5po6LPor1TnoCAzJX", false, true],
  ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", false, false],
  ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", false, false],
  ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", false, false],
  [USDC, false, false],
  [SPYX, false, false],
  ["BKqmbK2DxZxU2Wu8r4GfSnpCPWCmeRBJqiqWg41Lk17", false, true],
  ["4AcHLfMfYNBw1wXC522QZSNNFPMbxtYRERZiR9UptvNB", false, true],
  ["GKWE6FoWaHm5drQzP6qPq4BMbQyiWJ8WBRwk24HsBHCj", false, true],
  ["EkrUndoZrtYgNTEcY85oNjjxDLRJc4CTiBNp6KAQ8n48", false, true],
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", false, false],
];
const CAPTURED_DATA = "wSCbM0HWnIEFAQAAAChkAAFAeH0BAAAAAOanMQAAAAAAZAAA";
const CAPTURED_LUT = "2XPxvU6FHBvq2VmQSRV3YbdJiRdGEvnY3fdafdXQBijN";

const NO_FEE: TransferFeeRate = { epoch: 0n, basisPoints: 0, maximumFee: 0n };
/** ANTHROPIC's and FIGUREAI's real config, read off mainnet on 2026-09-20. */
const FEE_50: TransferFeeRate = { epoch: 1032n, basisPoints: 50, maximumFee: 18446744073709551615n };
const FEE_100: TransferFeeRate = { epoch: 1039n, basisPoints: 100, maximumFee: 18446744073709551615n };

function quote(): JupiterQuote {
  return {
    inputMint: USDC,
    outputMint: SPYX,
    inAmount: "25000000",
    outAmount: "3254246",
    otherAmountThreshold: "3221704",
    swapMode: "ExactIn",
    slippageBps: 100,
    // The age fields the API really sends and this builder used to drop.
    // updateContextSlot is a STRING in Jupiter's JSON, as captured.
    contextSlot: 448_859_887,
    timeTaken: 0.017,
    routePlan: [{ swapInfo: { label: "PancakeSwap", updateContextSlot: "448859870" } }],
  };
}

function response(): JupiterSwapInstructions {
  return {
    swapInstruction: {
      programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      accounts: CAPTURED_ACCOUNTS.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })),
      data: CAPTURED_DATA,
    },
    setupInstructions: [{ programId: ATA_PROGRAM, accounts: [], data: "" }],
    cleanupInstruction: null,
    tokenLedgerInstruction: null,
    otherInstructions: [],
    addressLookupTableAddresses: [CAPTURED_LUT],
  };
}

/** Exactly what the captured quote was asked for: 25 USDC of SPYx at 100 bps. */
function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    inputMint: new PublicKey(USDC),
    targetMint: new PublicKey(SPYX),
    amountIn: 25_000_000n,
    slippageBps: 100,
    ...overrides,
  };
}

/** A fixed clock, so nothing in this file depends on when it runs. */
const QUOTED_AT_MS = 1_758_400_000_000;

function context(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    request: request(),
    quotedAtMs: QUOTED_AT_MS,
    // A verification a second after the quote landed, inside a tolerance wide
    // enough that the shape tests below are never about the clock.
    observed: { nowMs: QUOTED_AT_MS + 1_000 },
    maxAge: { maxAgeMs: 30_000 },
    vault: new PublicKey(VAULT),
    vaultIn: new PublicKey(VAULT_USDC),
    vaultTarget: new PublicKey(VAULT_SPYX),
    // Both of the vault's own token accounts in this route, as an on-chain
    // owner read would report them. SPYx carries no transfer fee.
    vaultOwnedTokenAccounts: new Set([VAULT_USDC, VAULT_SPYX]),
    transferFee: NO_FEE,
    ...overrides,
  };
}

/** Runs the verifier and returns the refusal's condition, or fails loudly. */
function refusal(
  q: JupiterQuote,
  r: JupiterSwapInstructions,
  c: VerifyContext = context(),
): { condition: RefusalCondition; message: string } {
  try {
    verifySharedAccountsRoute(q, r, c);
  } catch (error) {
    if (error instanceof JupiterRouteRefusal) return { condition: error.condition, message: error.message };
    throw error;
  }
  throw new Error("the route was ACCEPTED — the refusal this test covers is gone");
}

/**
 * The same capture with slot 5 set to the vault's own target account — the
 * shape EVERY fee-bearing build has had (FIGUREAI, ANTHROPIC), as against
 * SPYx's, where slot 5 is Jupiter's own. The fee tests below need this one,
 * because a fee mint delivered through Jupiter's account is refused.
 */
function responseDeliveringToVault(): JupiterSwapInstructions {
  const r = response();
  return {
    ...r,
    swapInstruction: {
      ...r.swapInstruction,
      accounts: r.swapInstruction.accounts.map((a, i) => (i === 5 ? { ...a, pubkey: VAULT_SPYX } : a)),
    },
  };
}

/** The captured data with one byte replaced, for the tail-field mutations. */
function dataWith(mutate: (bytes: Buffer) => void): string {
  const bytes = Buffer.from(CAPTURED_DATA, "base64");
  mutate(bytes);
  return bytes.toString("base64");
}

describe("the Jupiter route builder accepts a real mainnet sharedAccountsRoute", () => {
  it("returns exactly what invest() and convert() need, and nothing the vault must sign", () => {
    const route = verifySharedAccountsRoute(quote(), response(), context());

    expect(route.venueProgram.toBase58()).toBe("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    expect(route.venueData.subarray(0, 8).toString("hex")).toBe("c1209b3341d69c81");
    expect(route.remainingAccounts).toHaveLength(32);
    expect(route.lookupTableAddresses.map((key) => key.toBase58())).toEqual([CAPTURED_LUT]);
    expect(route.hops).toBe(1);
    expect(route.labels).toEqual(["PancakeSwap"]);
    // A MEASURED SIZE, NOT A HOP COUNT. This field used to be the boolean
    // `hops > 1`; the number below is what web3.js's own compiler serializes
    // for this exact instruction and one signature.
    expect(route.legacyBytes).toBe(941);
    expect(fitsLegacyTransaction(route.legacyBytes)).toBe(true);

    // THE VAULT PDA CANNOT SIGN THE OUTER TRANSACTION. Jupiter marks slot 2 a
    // signer; if that flag survived into remainingAccounts the transaction
    // would demand a signature no key can produce. invest.rs re-marks exactly
    // that key for the inner CPI, which is the whole authority it lends.
    expect(route.remainingAccounts.some((meta) => meta.isSigner)).toBe(false);
    expect(route.remainingAccounts[2]!.pubkey.toBase58()).toBe(VAULT);
    // Writability is mirrored verbatim, because the program mirrors it too.
    expect(route.remainingAccounts.map((meta) => meta.isWritable)).toEqual(
      CAPTURED_ACCOUNTS.map(([, , isWritable]) => isWritable),
    );
  });

  it("reads the money out of the instruction's own bytes, not out of the API's JSON", () => {
    const route = verifySharedAccountsRoute(quote(), response(), context());
    expect(route.amounts).toEqual({
      inAmount: 25_000_000n,
      quotedOutAmount: 3_254_246n,
      slippageBps: 100,
      platformFeeBps: 0,
    });
    // THE AMOUNT THE VAULT SPENDS IS OURS. There is no route.amountIn to
    // forward by mistake: what the route carries is the request we made, and
    // Jupiter's own in-amount stays in `amounts`, next to it, for comparison.
    expect(route.request.amountIn).toBe(25_000_000n);
    expect(investAmountIn(route)).toBe(25_000_000n);
    expect(route.output.quotedOut).toBe(3_254_246n);
    expect(route.output.venueThreshold).toBe(3_221_704n);
    // SPYx has no transfer fee, so for this leg alone net and gross agree.
    expect(route.output.netOfQuotedOut).toBe(3_254_246n);
    expect(route.output.netOfVenueThreshold).toBe(3_221_704n);
  });

  it("recomputes the venue's own floor from the bytes and finds Jupiter's number", () => {
    expect(venueThresholdFrom({ inAmount: 25_000_000n, quotedOutAmount: 3_254_246n, slippageBps: 100, platformFeeBps: 0 })).toBe(
      3_221_704n,
    );
  });
});

describe("the Jupiter route builder refuses", () => {
  it("a quote that is not exact-in [quote-mode]", () => {
    expect(refusal({ ...quote(), swapMode: "ExactOut" }, response()).condition).toBe("quote-mode");
  });

  it("an instruction aimed at any program but Jupiter [venue-program]", () => {
    const r = response();
    const wrong = { ...r, swapInstruction: { ...r.swapInstruction, programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" } };
    expect(refusal(quote(), wrong).condition).toBe("venue-program");
  });

  it("the PLAIN route instruction, whose user-owned intermediates guard (1) would refuse [discriminator]", () => {
    // The whole reason shared accounts are forced: `route` threads the USER's
    // intermediate ATAs, every one of them a vault token account the deltas
    // never see. Catching it by discriminator is how we know the flag took.
    const r = response();
    const plain = {
      ...r,
      swapInstruction: {
        ...r.swapInstruction,
        data: dataWith((bytes) => ROUTE_DISC.copy(bytes, 0)),
      },
    };
    const said = refusal(quote(), plain);
    expect(said.condition).toBe("discriminator");
    expect(said.message).toContain("plain `route`");
    expect(ROUTE_DISC.equals(SHARED_ACCOUNTS_ROUTE_DISC)).toBe(false);
  });

  it("an account list shorter than the fixed prefix [account-count]", () => {
    const r = response();
    const short = { ...r, swapInstruction: { ...r.swapInstruction, accounts: r.swapInstruction.accounts.slice(0, 12) } };
    expect(refusal(quote(), short).condition).toBe("account-count");
  });

  it("data too short to carry the amount tail [data-length]", () => {
    const r = response();
    const stub = {
      ...r,
      swapInstruction: { ...r.swapInstruction, data: SHARED_ACCOUNTS_ROUTE_DISC.toString("base64") },
    };
    expect(refusal(quote(), stub).condition).toBe("data-length");
    expect(() => decodeRouteAmounts(Buffer.alloc(8))).toThrow(JupiterRouteRefusal);
  });

  it("a signer slot that is not the vault PDA [user-transfer-authority]", () => {
    const r = response();
    const accounts = r.swapInstruction.accounts.map((a, i) => (i === 2 ? { ...a, pubkey: SPYX } : a));
    expect(refusal(quote(), { ...r, swapInstruction: { ...r.swapInstruction, accounts } }).condition).toBe(
      "user-transfer-authority",
    );
  });

  it("a layout where the authority slot is not even a signer [user-transfer-authority]", () => {
    const r = response();
    const accounts = r.swapInstruction.accounts.map((a, i) => (i === 2 ? { ...a, isSigner: false } : a));
    const said = refusal(quote(), { ...r, swapInstruction: { ...r.swapInstruction, accounts } });
    expect(said.condition).toBe("user-transfer-authority");
    expect(said.message).toContain("not marked a signer");
  });

  it("a route that spends something other than the measured vault_in [source-account]", () => {
    // The spend guard reads vault_in's delta. A route spending elsewhere
    // measures zero spent and passes `spent <= amount_in` for free.
    const other = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    expect(refusal(quote(), response(), context({ vaultIn: new PublicKey(other) })).condition).toBe("source-account");
  });

  it("a route that delivers anywhere but the measured vault_target [destination-account]", () => {
    // The fill guard reads vault_target's delta AROUND the CPI: a route that
    // delivers to an intermediate and sweeps later measures zero and reverts
    // with FillTooSmall — after the money has left.
    const other = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    expect(refusal(quote(), response(), context({ vaultTarget: new PublicKey(other) })).condition).toBe(
      "destination-account",
    );
  });

  it("a vault-owned token account the program's deltas cannot see [unmeasured-vault-account]", () => {
    // refuse_unmeasured_vault_accounts would abort this on chain; refusing it
    // here means we never signed it. The stand-in is slot 4, Jupiter's own
    // program source account — as it would read if the vault owned it.
    const jupiterSource = "Gjmjory7TWKJXD2Jc6hKzAG991wWutFhtbXudzJqgx3p";
    const said = refusal(
      quote(),
      response(),
      context({ vaultOwnedTokenAccounts: new Set([VAULT_USDC, VAULT_SPYX, jupiterSource]) }),
    );
    expect(said.condition).toBe("unmeasured-vault-account");
    expect(said.message).toContain(jupiterSource);
  });

  it("an instruction whose bytes do not carry the amounts we quoted [amounts-drift]", () => {
    // THE DRIFT IS PUT IN THE INSTRUCTION, NOT IN THE QUOTE. Moving the quote
    // instead would now be caught one check earlier, by [request-drift], and
    // this test would silently stop covering the thing it is named after.
    // What it covers is the other half: the JSON we verified and the bytes we
    // are about to sign disagreeing with each other.
    const drifted = (mutate: (bytes: Buffer) => void): JupiterSwapInstructions => {
      const r = response();
      return { ...r, swapInstruction: { ...r.swapInstruction, data: dataWith(mutate) } };
    };
    // The tail is in(u64) out(u64) slippage(u16) platformFee(u8), read backward.
    expect(refusal(quote(), drifted((b) => b.writeBigUInt64LE(3_254_247n, b.length - 11))).condition).toBe("amounts-drift");
    expect(refusal(quote(), drifted((b) => b.writeBigUInt64LE(24_000_000n, b.length - 19))).condition).toBe("amounts-drift");
    expect(refusal(quote(), drifted((b) => b.writeUInt16LE(50, b.length - 3))).condition).toBe("amounts-drift");
  });

  it("a route that skims a platform fee out of the vault's fill [platform-fee]", () => {
    // The tail's last byte. A platform fee comes out of the OUTPUT, so every
    // number derived from outAmount would overstate what the vault receives.
    const r = response();
    const skimming = {
      ...r,
      swapInstruction: { ...r.swapInstruction, data: dataWith((bytes) => bytes.writeUInt8(10, bytes.length - 1)) },
    };
    expect(refusal(quote(), skimming).condition).toBe("platform-fee");
  });

  it("a threshold that is not the venue's own floor [venue-threshold]", () => {
    // If otherAmountThreshold stops being out - floor(out*bps/1e4), we do not
    // know what the venue guarantees, and min_out would be derived from a
    // guarantee we cannot state.
    expect(refusal({ ...quote(), otherAmountThreshold: "3221705" }, response()).condition).toBe("venue-threshold");
  });

  it("a route that needs instructions invest() cannot forward [extra-instructions]", () => {
    // invest() forwards ONE CPI. A wSOL wrap, a token-ledger read or a cleanup
    // close would simply never run, and the route would half-execute.
    const wrap = { programId: "11111111111111111111111111111111", accounts: [], data: "" };
    expect(refusal(quote(), { ...response(), setupInstructions: [wrap] }).condition).toBe("extra-instructions");
    expect(refusal(quote(), { ...response(), cleanupInstruction: wrap }).condition).toBe("extra-instructions");
    expect(refusal(quote(), { ...response(), tokenLedgerInstruction: wrap }).condition).toBe("extra-instructions");
    expect(refusal(quote(), { ...response(), otherInstructions: [wrap] }).condition).toBe("extra-instructions");
    // The idempotent ATA create Jupiter always emits under
    // skipUserAccountsRpcCalls is the one thing that is not a refusal.
    expect(verifySharedAccountsRoute(quote(), response(), context()).hops).toBe(1);
  });
});

describe("the net model subtracts one fee, and the route's shape has to earn that", () => {
  // WHAT SLOT 5 MEANS. It is Jupiter's programDestinationTokenAccount. When it
  // is the vault's target, the AMM pays straight into the account invest()
  // measures: one Token-2022 transfer, one fee, and netOfVenueThreshold is
  // right. When it is Jupiter's OWN account, the output lands there and is
  // forwarded to us — two transfers, two fees on a fee-bearing mint — and a
  // min_out modelling one would sit ABOVE the credit, so invest() would revert
  // with FillTooSmall after the spend.
  //
  // That second shape has never been observed on a fee mint: every fee-bearing
  // build measured on 2026-09-20 put the vault target in slot 5, across one to
  // three hops and with the venue pinned and unpinned, and the only route with
  // Jupiter's own account there was SPYx, which has no fee. So it is refused,
  // not modelled — the arithmetic for it has never been checked against a fill.

  it("refuses a fee mint whose output goes through Jupiter's own account [unmodelled-fee-path]", () => {
    // The captured SPYx route has Jupiter's account in slot 5. Give that same
    // shape a mint that charges 100 bps and it is exactly the unmeasured case.
    const said = refusal(quote(), response(), context({ transferFee: FEE_100 }));
    expect(said.condition).toBe("unmodelled-fee-path");
    expect(said.message).toContain("charged twice");
    expect(response().swapInstruction.accounts[5]!.pubkey).not.toBe(VAULT_SPYX);
  });

  it("accepts that same route when the mint charges nothing, which is why slot 5 is not pinned", () => {
    // SPYx really is delivered through Jupiter's account, and really has no
    // fee. Pinning slot 5 outright would refuse this honest route.
    const route = verifySharedAccountsRoute(quote(), response(), context({ transferFee: NO_FEE }));
    expect(route.output.netOfVenueThreshold).toBe(route.output.venueThreshold);
  });

  it("accepts a fee mint delivered straight into the account invest() measures", () => {
    const route = verifySharedAccountsRoute(quote(), responseDeliveringToVault(), context({ transferFee: FEE_100 }));
    expect(route.remainingAccounts[5]!.pubkey.toBase58()).toBe(VAULT_SPYX);
    // One fee, subtracted once: 3,221,704 - ceil(3,221,704 * 100/10_000).
    expect(route.output.netOfVenueThreshold).toBe(3_189_486n);
  });
});

describe("how big the route really is, measured rather than inferred from hops", () => {
  it("counts the bytes web3.js serializes, deduplicating repeated keys", () => {
    const route = verifySharedAccountsRoute(quote(), response(), context());
    // The captured route lists 32 accounts but only 23 DISTINCT ones — Jupiter
    // repeats its own program id three times, and both mints, both token
    // programs and three pool accounts twice. Counting 32 keys at 32 bytes
    // would be 288 bytes out; the compiler is not, because it is the same
    // compiler that builds the real message.
    expect(route.remainingAccounts).toHaveLength(32);
    expect(new Set(route.remainingAccounts.map((m) => m.pubkey.toBase58())).size).toBe(23);
    expect(route.legacyBytes).toBe(941);
  });

  it("does not let a hop count stand in for a size", () => {
    // THE CLAIM THIS REPLACES: "one hop fits, two hops do not". Here is a
    // ONE-hop route made too big to send, by nothing but its account list —
    // padded to 60 keys, which is inside the range Jupiter's own builds reach
    // on a busy venue.
    const r = response();
    const padded = {
      ...r,
      swapInstruction: {
        ...r.swapInstruction,
        accounts: [
          ...r.swapInstruction.accounts,
          ...Array.from({ length: 28 }, () => ({ pubkey: PublicKey.unique().toBase58(), isSigner: false, isWritable: false })),
        ],
      },
    };
    const route = verifySharedAccountsRoute(quote(), padded, context());
    expect(route.hops).toBe(1);
    expect(route.legacyBytes).toBeGreaterThan(1_232);
    expect(fitsLegacyTransaction(route.legacyBytes)).toBe(false);
  });

  it("measures the v0 form the caller really sends, two bytes above the legacy one", () => {
    // THE HARNESS PREDICTED ONE FORM AND SENT ANOTHER. jupiter-fork-setup.ts
    // checked the fit with legacyTransactionBytes while phase 3 compiles a v0
    // message — the version prefix plus an empty address-table-lookup count,
    // two bytes it never counted. Measured on the runs themselves: 951 B
    // predicted against 953 B sent, and 1,016 against 1,018 on the re-run.
    // A payer that is NOT in the route, exactly as the builder's own
    // measurement uses, so these numbers are the 941 this file already pins.
    const payer = PublicKey.unique();
    const ix = new TransactionInstruction({
      programId: new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
      keys: CAPTURED_ACCOUNTS.map(([pubkey, , isWritable]) => ({
        pubkey: new PublicKey(pubkey),
        isSigner: false,
        isWritable,
      })),
      data: Buffer.from(CAPTURED_DATA, "base64"),
    });
    expect(v0TransactionBytes(payer, [ix])).toBe(legacyTransactionBytes(payer, [ix]) + 2);
    // And on the captured route, whose legacy size this file already pins.
    expect(legacyTransactionBytes(payer, [ix])).toBe(941);
    expect(v0TransactionBytes(payer, [ix])).toBe(943);
  });

  it("leaves the caller to measure its own wrapper, because only the caller knows it", () => {
    // The route alone is not the transaction that gets sent. invest() adds its
    // program id, its named accounts and its data; a second instruction adds
    // more. legacyTransactionBytes is the same measurement over whatever the
    // caller actually intends to send.
    const route = verifySharedAccountsRoute(quote(), response(), context());
    const alone = legacyTransactionBytes(PublicKey.unique(), [
      { programId: new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"), keys: [...route.remainingAccounts], data: route.venueData },
    ]);
    expect(alone).toBe(route.legacyBytes);
    // A compute-budget instruction on top is 40 more bytes — its program id,
    // its own compiled entry and its data — and the caller sees that number
    // instead of guessing it.
    const wrapped = legacyTransactionBytes(PublicKey.unique(), [
      { programId: new PublicKey("ComputeBudget111111111111111111111111111111"), keys: [], data: Buffer.from([2, 0, 0, 0, 0]) },
      { programId: new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"), keys: [...route.remainingAccounts], data: route.venueData },
    ]);
    expect(wrapped - alone).toBe(40);
  });
});

describe("a route says when it was priced, and is refused once it is too old", () => {
  const route = () => verifySharedAccountsRoute(quote(), response(), context());

  it("carries the slot and the timing the API sent, which used to be dropped at the type boundary", () => {
    expect(route().age).toEqual({
      quotedAtMs: QUOTED_AT_MS,
      quotedAtSlot: 448_859_887,
      // Parsed from the string Jupiter sends per hop.
      oldestHopSlot: 448_859_870,
      oldestHopLabel: "PancakeSwap",
      quoteTimeTakenMs: 17,
    });
  });

  it("prices the route at its OLDEST hop, not at the quote's own slot", () => {
    // Measured on 2026-09-20: one live route's Raydium CLMM hop was priced
    // 2,176 slots behind the contextSlot next to it. Reading contextSlot alone
    // would call that route a few seconds old when its price was a quarter of
    // an hour old.
    expect(pricedAtSlot(route().age)).toBe(448_859_870);
    expect(pricedAtSlot(route().age)).toBeLessThan(route().age.quotedAtSlot!);
  });

  it("refuses a quote older than the caller's millisecond tolerance [route-age]", () => {
    const r = route();
    expect(() => verifyRouteFresh(r, { nowMs: QUOTED_AT_MS + 5_000 }, { maxAgeMs: 5_000 })).not.toThrow();
    try {
      verifyRouteFresh(r, { nowMs: QUOTED_AT_MS + 5_001 }, { maxAgeMs: 5_000 });
      throw new Error("a quote 5,001 ms old passed a 5,000 ms tolerance");
    } catch (error) {
      expect(error).toBeInstanceOf(JupiterRouteRefusal);
      expect((error as JupiterRouteRefusal).condition).toBe("route-age");
      expect((error as JupiterRouteRefusal).message).toContain("5001 ms old");
    }
  });

  it("refuses a route priced too many slots back, and names the hop [route-age]", () => {
    const r = route();
    const now = { nowMs: QUOTED_AT_MS, slot: 448_859_890 };
    expect(() => verifyRouteFresh(r, now, { maxAgeSlots: 20 })).not.toThrow();
    try {
      verifyRouteFresh(r, now, { maxAgeSlots: 19 });
      throw new Error("a route priced 20 slots back passed a 19-slot tolerance");
    } catch (error) {
      expect((error as JupiterRouteRefusal).condition).toBe("route-age");
      expect((error as JupiterRouteRefusal).message).toContain("PancakeSwap");
      expect((error as JupiterRouteRefusal).message).toContain("20 slots behind");
    }
  });

  it("refuses to pretend a missing slot is slot zero [route-age]", () => {
    // A quote with no contextSlot and no hop slot has an age nobody can state.
    // Treating that as fresh is exactly the silence this task is closing.
    const ageless = verifySharedAccountsRoute(
      { ...quote(), contextSlot: undefined, routePlan: [{ swapInfo: { label: "PancakeSwap" } }] },
      response(),
      context(),
    );
    expect(ageless.age.quotedAtSlot).toBeNull();
    expect(pricedAtSlot(ageless.age)).toBeNull();
    expect(() => verifyRouteFresh(ageless, { nowMs: QUOTED_AT_MS, slot: 1 }, { maxAgeSlots: 10 })).toThrow(
      /cannot be stated/,
    );
    // And a slot bound asked for with no slot to check it against.
    expect(() => verifyRouteFresh(route(), { nowMs: QUOTED_AT_MS }, { maxAgeSlots: 10 })).toThrow(
      /no current slot was supplied/,
    );
  });

  it("refuses a tolerance that states nothing at all [route-age]", () => {
    // The state this whole type exists to end: a route nobody decided the
    // freshness of, whose quote sets min_out anyway.
    try {
      verifyRouteFresh(route(), { nowMs: QUOTED_AT_MS }, {});
      throw new Error("a route with no stated tolerance was called fresh");
    } catch (error) {
      expect((error as JupiterRouteRefusal).condition).toBe("route-age");
      expect((error as JupiterRouteRefusal).message).toContain("a min_out nobody sized");
    }
  });

  it("does not refuse a slot reading that trails Jupiter's own", () => {
    // getSlot("confirmed") can legitimately sit behind the commitment Jupiter
    // priced at. A negative age is not staleness, and refusing it would refuse
    // honest routes.
    expect(() => verifyRouteFresh(route(), { nowMs: QUOTED_AT_MS, slot: 448_859_800 }, { maxAgeSlots: 0 })).not.toThrow();
  });
});

describe("amount_in is the caller's number, and is re-checked where it becomes one", () => {
  it("returns the requested amount, not the one read out of the instruction", () => {
    const route = verifySharedAccountsRoute(quote(), response(), context());
    expect(investAmountIn(route)).toBe(route.request.amountIn);
    expect(investAmountIn(route)).toBe(25_000_000n);
  });

  it("refuses a route whose bytes spend something else [request-drift]", () => {
    // A JupiterRoute assembled by any path other than verifySharedAccountsRoute
    // — a cached artifact, a hand-built object, a future builder — can still
    // hold an in-amount that is not the one asked for. This is the last place
    // it can be caught: the next thing that happens to these two values is
    // that they are signed together.
    const route = verifySharedAccountsRoute(quote(), response(), context());
    const drifted: JupiterRoute = { ...route, amounts: { ...route.amounts, inAmount: 250_000_000n } };
    try {
      investAmountIn(drifted);
      throw new Error("a route spending 250 USDC answered a request for 25 and was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(JupiterRouteRefusal);
      expect((error as JupiterRouteRefusal).condition).toBe("request-drift");
      expect((error as JupiterRouteRefusal).message).toContain("never the route's");
    }
  });
});

describe("the quote is refused unless it answers the question we asked", () => {
  // WHY THESE ARE NOT COVERED BY [amounts-drift]. That check agrees the
  // instruction's tail with the quote JSON — two numbers Jupiter supplied, and
  // both of them move together when the API answers a different question. Each
  // case below is therefore built INTERNALLY CONSISTENT: the instruction's own
  // bytes and the threshold are edited to match the drifted quote, so every
  // other guard passes and only this one can say no. Delete the check and each
  // of these routes is ACCEPTED, which is what refusal() reports.

  it("a wider slippage than we asked for, because min_out comes off that number [request-drift]", () => {
    // 900 bps where 50 was asked: the vault would accept a fill nine tenths of
    // a percent worse than the floor it chose, and the whole route would still
    // verify, because the instruction says 900 too.
    const r = response();
    const wide = {
      ...r,
      swapInstruction: { ...r.swapInstruction, data: dataWith((bytes) => bytes.writeUInt16LE(900, bytes.length - 3)) },
    };
    // out - floor(out * 900 / 1e4) = 3,254,246 - 292,882.
    const q = { ...quote(), slippageBps: 900, otherAmountThreshold: "2961364" };
    const said = refusal(q, wide, context({ request: request({ slippageBps: 50 }) }));
    expect(said.condition).toBe("request-drift");
    expect(said.message).toContain("min_out is derived from this number");

    // And the proof that nothing else would have caught it: with the request
    // restated as 900, the very same route verifies and its floor IS the loose
    // one — 292,882 raw units below the quote instead of 32,542.
    const accepted = verifySharedAccountsRoute(q, wide, context({ request: request({ slippageBps: 900 }) }));
    expect(accepted.output.venueThreshold).toBe(2_961_364n);
    expect(accepted.amounts.slippageBps).toBe(900);
  });

  it("a different amount than we asked for [request-drift]", () => {
    // The instruction's in-amount is edited to agree, so [amounts-drift] is
    // silent; only the request knows 25 USDC was asked for.
    const r = response();
    const smaller = {
      ...r,
      swapInstruction: { ...r.swapInstruction, data: dataWith((bytes) => bytes.writeBigUInt64LE(24_000_000n, bytes.length - 19)) },
    };
    const said = refusal({ ...quote(), inAmount: "24000000" }, smaller);
    expect(said.condition).toBe("request-drift");
    expect(said.message).toContain("24000000");
  });

  it("a quote about other mints entirely [request-drift]", () => {
    // Nothing else in this file reads the quote's mints at all.
    expect(refusal({ ...quote(), inputMint: SPYX }, response()).condition).toBe("request-drift");
    expect(refusal({ ...quote(), outputMint: USDC }, response()).condition).toBe("request-drift");
  });

  it("is a pure check a caller can run the moment a quote lands", () => {
    // buildJupiterRoute calls exactly this before the quote is posted back to
    // /swap-instructions — before an instruction exists to verify against it.
    expect(() => verifyQuoteAnswersRequest(quote(), request())).not.toThrow();
    expect(() => verifyQuoteAnswersRequest({ ...quote(), slippageBps: 900 }, request())).toThrow(JupiterRouteRefusal);
    try {
      verifyQuoteAnswersRequest({ ...quote(), inAmount: "1" }, request());
      throw new Error("a quote for 1 raw unit answered a request for 25,000,000 and was accepted");
    } catch (error) {
      expect((error as JupiterRouteRefusal).condition).toBe("request-drift");
    }
  });
});

describe("vault-owned-ness is derived, not taken from the API's labels", () => {
  /** A Connection stand-in that reports every account as not existing. */
  const noAccounts = {
    getMultipleAccountsInfo: async (keys: readonly PublicKey[]) => keys.map(() => null),
  } as unknown as Parameters<typeof findVaultOwnedTokenAccounts>[0];

  /** A two-hop quote: USDC -> wSOL -> SPYx, the shape that has intermediates. */
  const twoHop = (): JupiterQuote => ({
    ...quote(),
    routePlan: [
      { swapInfo: { label: "Whirlpool", inputMint: USDC, outputMint: WSOL, updateContextSlot: "448859870" } },
      { swapInfo: { label: "Meteora DLMM", inputMint: WSOL, outputMint: SPYX, updateContextSlot: "448859880" } },
    ],
  });

  it("reads the intermediate mints out of the route plan, which is the only place they are named", () => {
    expect(routeMints(twoHop(), new PublicKey(USDC), new PublicKey(SPYX)).map((m) => m.toBase58())).toEqual([
      USDC,
      SPYX,
      WSOL,
    ]);
    // A single-hop route adds nothing, and never repeats the two ends.
    expect(routeMints(quote(), new PublicKey(USDC), new PublicKey(SPYX)).map((m) => m.toBase58())).toEqual([USDC, SPYX]);
  });

  it("derives the vault's ATA for an INTERMEDIATE mint that does not exist yet", async () => {
    // THE HOLE THIS CLOSES. The on-chain pass only sees accounts that already
    // exist, and the derivation used to be handed the two end mints alone — so
    // a vault ATA for an intermediate, not yet created, was invisible to both
    // passes. That is precisely the account a route could create and then
    // spend with nothing measuring it.
    const found = await findVaultOwnedTokenAccounts(
      noAccounts,
      new PublicKey(VAULT),
      [VAULT_USDC, VAULT_WSOL_LEGACY, VAULT_WSOL_2022, "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
      routeMints(twoHop(), new PublicKey(USDC), new PublicKey(SPYX)),
    );
    expect([...found].sort()).toEqual([VAULT_USDC, VAULT_WSOL_LEGACY, VAULT_WSOL_2022].sort());
  });

  it("and such an account is then refused by name [unmeasured-vault-account]", () => {
    // The derivation is only half of it: what it buys is that the refusal can
    // fire at all. A route listing the vault's wSOL ATA is a balance the two
    // deltas cannot see.
    const r = response();
    const withIntermediate = {
      ...r,
      swapInstruction: {
        ...r.swapInstruction,
        accounts: [...r.swapInstruction.accounts, { pubkey: VAULT_WSOL_LEGACY, isSigner: false, isWritable: true }],
      },
    };
    const said = refusal(
      quote(),
      withIntermediate,
      context({ vaultOwnedTokenAccounts: new Set([VAULT_USDC, VAULT_SPYX, VAULT_WSOL_LEGACY]) }),
    );
    expect(said.condition).toBe("unmeasured-vault-account");
    expect(said.message).toContain(VAULT_WSOL_LEGACY);
  });

  it("finds the vault's ATA under both token programs even when it does not exist yet", async () => {
    const vault = new PublicKey(VAULT);
    const found = await findVaultOwnedTokenAccounts(
      noAccounts,
      vault,
      // SPYx's ATA is a Token-2022 derivation and USDC's a classic one: a
      // single-program derivation would miss one of the two.
      [VAULT_USDC, VAULT_SPYX, "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
      [new PublicKey(USDC), new PublicKey(SPYX)],
    );
    expect([...found].sort()).toEqual([VAULT_USDC, VAULT_SPYX].sort());
  });
});

describe("the Token-2022 transfer fee, and where each min_out actually lands", () => {
  const config = { olderTransferFee: FEE_50, newerTransferFee: FEE_100 };

  it("picks the epoch's rate the way Token-2022 does, so 50 and 100 are never hardcoded", () => {
    expect(transferFeeForEpoch(config, 1038n).basisPoints).toBe(50);
    // Epoch 1039 is when both PreStocks legs step to 100 bps.
    expect(transferFeeForEpoch(config, 1039n).basisPoints).toBe(100);
    expect(transferFeeForEpoch(config, 2000n).basisPoints).toBe(100);
    expect(transferFeeForEpoch(config, 1000n).basisPoints).toBe(50);
  });

  it("rounds the fee UP, the way calculate_fee does", () => {
    expect(transferFeeOn(3_254_246n, NO_FEE)).toBe(0n);
    expect(transferFeeOn(0n, FEE_100)).toBe(0n);
    // 1,376,918,399 * 100 / 10_000 = 13,769,183.99 -> 13,769,184.
    expect(transferFeeOn(1_376_918_399n, FEE_100)).toBe(13_769_184n);
    expect(transferFeeOn(1_376_918_399n, FEE_50)).toBe(6_884_592n);
    // maximumFee caps it; the PreStocks legs set u64::MAX, so nothing caps them.
    expect(transferFeeOn(1_000_000n, { epoch: 0n, basisPoints: 100, maximumFee: 5n })).toBe(5n);
  });

  it("puts the NET of the quote one raw unit BELOW the threshold once the rates match", () => {
    // The measured quote this whole task exists for: out 1,376,918,399,
    // threshold 1,363,149,216 at slippageBps 100.
    const quotedOut = 1_376_918_399n;
    const threshold = venueThresholdFrom({ inAmount: 0n, quotedOutAmount: quotedOut, slippageBps: 100, platformFeeBps: 0 });
    expect(threshold).toBe(1_363_149_216n);

    // Jupiter FLOORS its slippage deduction; Token-2022 CEILS its fee. Same
    // 100 bps, opposite rounding — so on a GROSS-quoting venue the credit
    // lands a single raw unit under the venue's own threshold. That gap is
    // where JUPITER refuses, not where our FillTooSmall does: measured on a
    // cloned Manifest route at slippage 50 against a 50 bps fee, the CPI
    // reverted with 0x1771 and invest()'s fill guard was never reached.
    const netOfQuote = netOfTransferFee(quotedOut, FEE_100);
    expect(netOfQuote).toBe(1_363_149_215n);
    expect(netOfQuote).toBe(threshold - 1n);

    // The safe number: the net of the venue's own worst case. This is the
    // largest min_out the venue's guarantee actually covers.
    expect(netOfTransferFee(threshold, FEE_100)).toBe(1_349_517_723n);
    expect(netOfTransferFee(threshold, FEE_100)).toBeLessThan(threshold);
  });

  it("carries the fee into the route's output numbers, gross and net side by side", () => {
    const route = verifySharedAccountsRoute(quote(), responseDeliveringToVault(), context({ transferFee: FEE_100 }));
    expect(route.output.quotedOut).toBe(3_254_246n);
    expect(route.output.venueThreshold).toBe(3_221_704n);
    // ceil(3,254,246 * 100/10_000) = 32,543, so the net of the QUOTE already
    // lands a raw unit under the venue's own threshold.
    expect(route.output.netOfQuotedOut).toBe(3_221_703n);
    expect(route.output.netOfQuotedOut).toBe(route.output.venueThreshold - 1n);
    // 3,221,704 - ceil(3,221,704 * 100/10_000) = 3,221,704 - 32,218.
    expect(route.output.netOfVenueThreshold).toBe(3_189_486n);
    // The min_out that was MEASURED reverting with FillTooSmall 6020 is the
    // one taken from the quote's OUTPUT on a gross-quoting venue — it is a
    // whole fee above the credit. netOfVenueThreshold is below both, by our
    // own arithmetic rather than by Jupiter's internal check.
    expect(route.output.netOfQuotedOut).toBeLessThan(route.output.quotedOut);
    expect(route.output.venueThreshold).toBeGreaterThan(route.output.netOfVenueThreshold);
  });

  it("leaves a fee-free mint alone, so callers never branch on 'is this a fee leg'", () => {
    const route = verifySharedAccountsRoute(quote(), response(), context({ transferFee: NO_FEE }));
    expect(route.output.netOfQuotedOut).toBe(route.output.quotedOut);
    expect(route.output.netOfVenueThreshold).toBe(route.output.venueThreshold);
  });
});

describe("the verification ages the route itself, because signing happens after building", () => {
  // THE HOLE THIS CLOSES. VerifyContext carried quotedAtMs and no tolerance:
  // verifySharedAccountsRoute assembled the age, put it on the route and
  // returned without ever comparing it to anything. Only buildJupiterRoute
  // aged a route — and a route is verified AGAIN just before it is signed,
  // which is later, by whatever the caller spent holding it.

  it("refuses a quote older than the tolerance, through the verification itself [route-age]", () => {
    const { condition, message } = refusal(
      quote(),
      response(),
      context({ observed: { nowMs: QUOTED_AT_MS + 30_001 }, maxAge: { maxAgeMs: 30_000 } }),
    );
    expect(condition).toBe("route-age");
    expect(message).toContain("30001 ms old");
  });

  it("refuses a verification that states no tolerance at all [route-age]", () => {
    // Same rule verifyRouteFresh applies, now unskippable: a route nobody aged
    // is a min_out nobody sized.
    const { condition, message } = refusal(quote(), response(), context({ maxAge: {} }));
    expect(condition).toBe("route-age");
    expect(message).toContain("no freshness tolerance was stated");
  });

  it("refuses on slots too, and needs the caller's slot to do it [route-age]", () => {
    expect(
      refusal(
        quote(),
        response(),
        context({ observed: { nowMs: QUOTED_AT_MS, slot: 448_859_890 }, maxAge: { maxAgeSlots: 19 } }),
      ).message,
    ).toContain("PancakeSwap");
    expect(refusal(quote(), response(), context({ maxAge: { maxAgeSlots: 19 } })).message).toContain(
      "no current slot was supplied",
    );
  });

  it("accepts inside the tolerance, and hands back the age it just checked", () => {
    const route = verifySharedAccountsRoute(
      quote(),
      response(),
      context({ observed: { nowMs: QUOTED_AT_MS + 30_000 }, maxAge: { maxAgeMs: 30_000 } }),
    );
    expect(route.age.quotedAtMs).toBe(QUOTED_AT_MS);
    // And the same check re-run a millisecond later is the one a caller owes
    // itself before signing; it is the same function, on the same route.
    expect(() => verifyRouteFresh(route, { nowMs: QUOTED_AT_MS + 30_001 }, { maxAgeMs: 30_000 })).toThrow(
      JupiterRouteRefusal,
    );
  });
});

describe("the price is bounded by the OWNER's floor, and by nothing else in this file", () => {
  // WHAT THE REQUEST DOES NOT BOUND. verifyQuoteAnswersRequest pins the mints,
  // the amount in and the slippage. It does not pin outAmount, and
  // netOfVenueThreshold is computed straight from it — so a quote answering
  // our exact question at a terrible price still sets the vault's minimum, and
  // every other check in this file passes it. The bound is the vault owner's
  // signed min_out_rate_wad, which invest() turns into
  //   floor = amount_in * min_out_rate_wad / 1e18
  // and enforces as FloorTooLow BEFORE the CPI. This file can check that same
  // number when the caller has it, and promises nothing about the price when
  // it does not.

  /** The rate that makes the captured route land EXACTLY on the owner's floor. */
  const EXACT_WAD = 128_868_160_000_000_000n; // 3,221,704 out per 25,000,000 in

  it("computes the floor the way invest() does, truncating", () => {
    expect(ownerFloorFor(25_000_000n, EXACT_WAD)).toBe(3_221_704n);
    // Rust's u128 division truncates, and 25e6 raw units cannot lift the
    // quotient by one: the rate has to move by 4e10 wad before the floor does.
    expect(ownerFloorFor(25_000_000n, EXACT_WAD + 1n)).toBe(3_221_704n);
    expect(ownerFloorFor(25_000_000n, 128_868_200_000_000_000n)).toBe(3_221_705n);
  });

  it("accepts a route whose min_out lands exactly on the floor, as invest() does", () => {
    // invest() requires min_out >= floor, so equality is acceptance there and
    // must be acceptance here.
    const route = verifySharedAccountsRoute(quote(), response(), context({ ownerFloorRateWad: EXACT_WAD }));
    expect(route.output.netOfVenueThreshold).toBe(3_221_704n);
    expect(route.output.ownerFloor).toBe(3_221_704n);
  });

  it("refuses a route the owner's own floor would not have [below-owner-floor]", () => {
    // One raw unit of floor above what this route can promise. On chain this
    // is FloorTooLow 6019 — after a transaction has been spent.
    const { condition, message } = refusal(
      quote(),
      response(),
      context({ ownerFloorRateWad: 128_868_200_000_000_000n }),
    );
    expect(condition).toBe("below-owner-floor");
    expect(message).toContain("min_out would be 3221704, under the owner's own floor of 3221705");
    expect(message).toContain("FloorTooLow");
  });

  it("measures the floor against a WORSE price, which is the case the request cannot see", () => {
    // The same request — same mints, same 25 USDC, same 100 bps — answered at
    // half the output. verifyQuoteAnswersRequest is satisfied by it; the
    // owner's floor is not.
    const halved = { ...quote(), outAmount: "1627123", otherAmountThreshold: "1610852" };
    const bytes = Buffer.from(CAPTURED_DATA, "base64");
    bytes.writeBigUInt64LE(1_627_123n, bytes.length - 19 + 8);
    const cheap = { ...response(), swapInstruction: { ...response().swapInstruction, data: bytes.toString("base64") } };
    // Nothing about the question drifted...
    expect(() => verifyQuoteAnswersRequest(halved, request())).not.toThrow();
    // ...and without a floor the builder accepts it and hands back a minimum
    // half the size, saying plainly that it bounded no price.
    const unbounded = verifySharedAccountsRoute(halved, cheap, context());
    expect(unbounded.output.netOfVenueThreshold).toBe(1_610_852n);
    expect(unbounded.output.ownerFloor).toBeNull();
    // With the owner's floor, it is refused.
    expect(refusal(halved, cheap, context({ ownerFloorRateWad: EXACT_WAD })).condition).toBe("below-owner-floor");
  });

  it("refuses a policy rate that overflows the u64 invest() converts to [below-owner-floor]", () => {
    const { condition, message } = refusal(
      quote(),
      response(),
      context({ ownerFloorRateWad: 10n ** 30n }),
    );
    expect(condition).toBe("below-owner-floor");
    expect(message).toContain("past u64");
  });

  it("says out loud that it bounded no price when the caller stated no floor", () => {
    expect(verifySharedAccountsRoute(quote(), response(), context()).output.ownerFloor).toBeNull();
  });
});

describe("the builder does not spend the freshness budget on its own round trips", () => {
  // WHAT maxAgeMs IS FOR. It bounds how stale a PRICE the vault will size a
  // min_out against. It used to be charged for four round trips: the
  // /swap-instructions POST and the vault-account read, which genuinely need
  // the quote, and the mint read and the epoch read, which need only the
  // target mint and were issued after the quote had already landed. On a slow
  // RPC the builder refused its own route over two reads it could have made
  // while the quote was still in flight.
  //
  // The whole builder runs here against a stubbed clock and a stubbed RPC, so
  // "which round trip fell inside the window" is a measurement, not a reading
  // of the code.

  /** An 82-byte SPL mint with no extensions: decimals 6, initialized. */
  const mintAccount = () => {
    const data = Buffer.alloc(82);
    data.writeUInt8(6, 44);
    data.writeUInt8(1, 45); // isInitialized
    return { owner: TOKEN_PROGRAM_ID, data, executable: false, lamports: 1, rentEpoch: 0 };
  };

  /**
   * A clock that only moves when a round trip says it did, and a log of the
   * order those round trips were ISSUED in.
   */
  function harness(costMs: { mint: number; quote: number; swap: number; vaultAccounts: number }) {
    let clock = QUOTED_AT_MS;
    const issued: string[] = [];
    const charge = (what: string, ms: number) => {
      issued.push(what);
      clock += ms;
    };
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = String(input);
      const isQuote = url.includes("/quote?");
      charge(isQuote ? "quote" : "swap-instructions", isQuote ? costMs.quote : costMs.swap);
      return new Response(JSON.stringify(isQuote ? quote() : response()), { status: 200 });
    });
    const connection = {
      getAccountInfo: async () => {
        charge("mint", costMs.mint);
        return mintAccount();
      },
      getEpochInfo: async () => ({ epoch: 1039 }),
      getMultipleAccountsInfo: async (keys: readonly PublicKey[]) => {
        charge("vault-accounts", costMs.vaultAccounts);
        return keys.map(() => null);
      },
      getSlot: async () => 448_859_890,
    } as unknown as Connection;
    return { connection, issued, now: () => clock };
  }

  const params = {
    vault: new PublicKey(VAULT),
    vaultIn: new PublicKey(VAULT_USDC),
    vaultTarget: new PublicKey(VAULT_SPYX),
    inputMint: new PublicKey(USDC),
    targetMint: new PublicKey(SPYX),
    amountIn: 25_000_000n,
    slippageBps: 100,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("issues the reads that do not need the quote BEFORE it, so a slow mint read costs no budget", async () => {
    // 40 s of mint read against a 1 s tolerance. Inside the window it is a
    // refusal; outside it, it is not even measured.
    const { connection, issued } = harness({ mint: 40_000, quote: 10, swap: 10, vaultAccounts: 10 });
    const route = await buildJupiterRoute(connection, { ...params, maxAge: { maxAgeMs: 1_000 } });
    expect(route.hops).toBe(1);
    // The mint read is issued first — before the quote it does not depend on.
    expect(issued).toEqual(["mint", "quote", "swap-instructions", "vault-accounts"]);
    // And only the two round trips that need the quote are charged to the age.
    expect(route.age.quotedAtMs).toBe(QUOTED_AT_MS + 40_010);
  });

  it("still refuses when the age is real, and says how much of it was its own", async () => {
    // Now the POST is the slow one. That age is genuine — the price really is
    // 40 s older — so the refusal stands; what it must not do is read as a
    // market that moved.
    const { connection } = harness({ mint: 10, quote: 10, swap: 40_000, vaultAccounts: 10 });
    // Here every millisecond of the age WAS the builder's, which is precisely
    // the case a caller could not tell from a market that moved.
    await expect(buildJupiterRoute(connection, { ...params, maxAge: { maxAgeMs: 1_000 } })).rejects.toThrow(
      /the quote is 40010 ms old, past the 1000 ms this caller allows; 40010 ms of that age is this builder's own post-quote round trips/,
    );
  });

  it("leaves a refusal that is not about age alone", async () => {
    const { connection } = harness({ mint: 10, quote: 10, swap: 10, vaultAccounts: 10 });
    // A request for 1 USDC against a quote that answers 25: request-drift, and
    // no freshness commentary bolted onto it.
    const error = await buildJupiterRoute(connection, {
      ...params,
      amountIn: 1_000_000n,
      maxAge: { maxAgeMs: 1_000 },
    }).catch((e: unknown) => e as JupiterRouteRefusal);
    expect(error).toBeInstanceOf(JupiterRouteRefusal);
    expect((error as JupiterRouteRefusal).condition).toBe("request-drift");
    expect((error as JupiterRouteRefusal).message).not.toContain("post-quote round trips");
  });
});

describe("the fork harness's venue flags, because the documented command has to still run", () => {
  // jupiter-fork.sh's header documents the command that produced the measured
  // gross-venue finding: `--dexes Manifest --slippage 50`. A later commit gave
  // --exclude a default of Hadron and applied it to every run, so that command
  // started sending BOTH lists — and Jupiter answers HTTP 400,
  // {"error":"Cannot set dexes and exclude dexes at the same time"}, measured
  // against lite-api.jup.ag. The documented proof could no longer be re-run at
  // all, which is worse than never having taken it.
  const argv = (...flags: string[]): string[] => ["node", "scripts/jupiter-fork-setup.ts", ...flags];

  it("adds NO default exclusion to a run that pinned its venue", () => {
    expect(venueFlags(argv("--dexes", "Manifest", "--slippage", "50"))).toEqual({
      slippageBps: 50,
      dexes: ["Manifest"],
      excludeDexes: [],
    });
  });

  it("still keeps Hadron out of a run that pinned nothing, which is what the default is for", () => {
    expect(venueFlags(argv())).toEqual({ slippageBps: 200, dexes: [], excludeDexes: ["Hadron"] });
    expect(venueFlags(argv("--slippage", "100"))).toEqual({ slippageBps: 100, dexes: [], excludeDexes: ["Hadron"] });
  });

  it("refuses the two lists together here, with Jupiter's own reason", () => {
    expect(() => venueFlags(argv("--dexes", "Manifest", "--exclude", "Hadron"))).toThrow(
      /Cannot set dexes and exclude dexes at the same time/,
    );
  });

  it("takes an explicit --exclude when nothing is pinned, and trims it", () => {
    expect(venueFlags(argv("--exclude", " Hadron , Obric "))).toEqual({
      slippageBps: 200,
      dexes: [],
      excludeDexes: ["Hadron", "Obric"],
    });
  });

  it("refuses a slippage that is not whole basis points", () => {
    expect(() => venueFlags(argv("--slippage", "12.5"))).toThrow(/whole number of bps/);
    expect(() => venueFlags(argv("--slippage", "-1"))).toThrow(/whole number of bps/);
  });

  it("keeps phase 3 inside a typecheck gate, which nothing else put it in", () => {
    // The assertion that matters here is the `import type { RouteFile }` at
    // the top of this file: it is erased at runtime, so phase 3 never runs,
    // but it puts the module into tsc's program and the keeper's typecheck
    // becomes the gate neither fork script had. It found four real errors the
    // first time it ran. This test exists so the import is USED, and so the
    // fields phase 1 writes into jupiter-route.json are the fields phase 3
    // declares it will read.
    const written: Pick<RouteFile, "requestedAmountIn" | "instructionInAmount" | "venueData" | "slippageBps"> = {
      requestedAmountIn: "5000000",
      instructionInAmount: "5000000",
      venueData: "wSCbM0HWnIE=",
      slippageBps: 200,
    };
    expect(written.requestedAmountIn).toBe(written.instructionInAmount);
  });
});
