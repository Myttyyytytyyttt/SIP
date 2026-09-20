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

import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  JupiterRouteRefusal,
  type JupiterQuote,
  type JupiterSwapInstructions,
  type RefusalCondition,
  type RouteRequest,
  type TransferFeeRate,
  type VerifyContext,
  ROUTE_DISC,
  SHARED_ACCOUNTS_ROUTE_DISC,
  decodeRouteAmounts,
  findVaultOwnedTokenAccounts,
  netOfTransferFee,
  transferFeeForEpoch,
  verifyQuoteAnswersRequest,
  transferFeeOn,
  venueThresholdFrom,
  verifySharedAccountsRoute,
} from "@sip/solana-program/jupiter-route";

const VAULT = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";
const VAULT_USDC = "46zCguSBbuStXvbJ3YdxVCVs72gXtDcKJEoseMFv7uof";
const VAULT_SPYX = "FNsKE5tXJU9CaBT5qt4TzuqNbK96ZfLPFJFwLndaRgrR";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPYX = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

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
    routePlan: [{ swapInfo: { label: "PancakeSwap" } }],
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

function context(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return {
    request: request(),
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
    // One hop is ~1,130 B wrapped in our invest and fits a legacy transaction;
    // two hops are ~1,308-1,400 B against a 1,232 B limit.
    expect(route.requiresVersionedTransaction).toBe(false);

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
    expect(route.amountIn).toBe(25_000_000n);
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

describe("the Token-2022 transfer fee, which is why a gross min_out reverts", () => {
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

  it("puts the NET of the venue's own threshold one raw unit BELOW the threshold at 100 bps", () => {
    // The measured quote this whole task exists for: out 1,376,918,399,
    // threshold 1,363,149,216 at slippageBps 100.
    const quotedOut = 1_376_918_399n;
    const threshold = venueThresholdFrom({ inAmount: 0n, quotedOutAmount: quotedOut, slippageBps: 100, platformFeeBps: 0 });
    expect(threshold).toBe(1_363_149_216n);

    // Jupiter FLOORS its slippage deduction; Token-2022 CEILS its fee. Same
    // 100 bps, opposite rounding — so min_out = otherAmountThreshold does not
    // merely have zero margin, it reverts with FillTooSmall at ZERO slippage.
    const netOfQuote = netOfTransferFee(quotedOut, FEE_100);
    expect(netOfQuote).toBe(1_363_149_215n);
    expect(netOfQuote).toBe(threshold - 1n);

    // The safe number: the net of the venue's own worst case. This is the
    // largest min_out the venue's guarantee actually covers.
    expect(netOfTransferFee(threshold, FEE_100)).toBe(1_349_517_723n);
    expect(netOfTransferFee(threshold, FEE_100)).toBeLessThan(threshold);
  });

  it("carries the fee into the route's output numbers, gross and net side by side", () => {
    const route = verifySharedAccountsRoute(quote(), response(), context({ transferFee: FEE_100 }));
    expect(route.output.quotedOut).toBe(3_254_246n);
    expect(route.output.venueThreshold).toBe(3_221_704n);
    // ceil(3,254,246 * 100/10_000) = 32,543, so the net of the QUOTE already
    // lands a raw unit under the venue's own threshold.
    expect(route.output.netOfQuotedOut).toBe(3_221_703n);
    expect(route.output.netOfQuotedOut).toBe(route.output.venueThreshold - 1n);
    // 3,221,704 - ceil(3,221,704 * 100/10_000) = 3,221,704 - 32,218.
    expect(route.output.netOfVenueThreshold).toBe(3_189_486n);
    // A min_out taken from the GROSS threshold is above what the vault will be
    // credited: that is the FillTooSmall this builder exists to prevent.
    expect(route.output.venueThreshold).toBeGreaterThan(route.output.netOfVenueThreshold);
  });

  it("leaves a fee-free mint alone, so callers never branch on 'is this a fee leg'", () => {
    const route = verifySharedAccountsRoute(quote(), response(), context({ transferFee: NO_FEE }));
    expect(route.output.netOfQuotedOut).toBe(route.output.quotedOut);
    expect(route.output.netOfVenueThreshold).toBe(route.output.venueThreshold);
  });
});
