// Phantom's Lighthouse checks: the shared rule (client/lighthouse.ts) and the
// relay's rule 8c, with transactions exactly as the builders make them,
// rewritten the way Phantom rewrites them on mainnet, signed by throwaway keys.

import { ComputeBudgetProgram, Ed25519Program, Keypair, Message, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { LIGHTHOUSE_PROGRAM, MEMO_PROGRAM, SPYX_MINT, TOKEN_2022_PROGRAM } from "../src/client/addresses";
import { SIP_PROGRAM_ID } from "../src/client/idl";
import { MAX_GUARD_ASSERTIONS, MAX_WALLET_GUARDS, WALLET_GUARD_REFUSALS, checkWalletGuards, readLighthouseGuard } from "../src/client/lighthouse";
import { buildWithdrawToken } from "../src/server/builders";
import { deriveAta } from "../src/server/pda";
import { MAX_TX_BYTES } from "../src/server/relay-policy";
import { VERIFY_REFUSALS, verifySignedTransaction, type VerifyRefusal } from "../src/server/verify-tx";
import { FIRST_POLICY_VAULT_TOKEN_ACCOUNTS, FIXTURE_BLOCKHASH, FIXTURE_OWNER, FIXTURE_WALLET, buildOwnerFixtures, type OwnerFixtureName } from "./fixtures/owner-transactions";
import { GUARD_DATA, LIGHTHOUSE, concat, guard, rewriteAsPhantom, signedAsPhantom, type PhantomRewrite } from "./phantom-rewrite";
import { fromB64, keypair } from "./helpers";

const fixtures = buildOwnerFixtures();
const owner = FIXTURE_OWNER;
const wallet = FIXTURE_WALLET;
const unsigned = (name: OwnerFixtureName): Uint8Array => fromB64(fixtures[name].built.txBase64);
const account = (name: OwnerFixtureName, idlName: string): string => fixtures[name].built.accounts[idlName]!;
const signersOf = (name: OwnerFixtureName): Keypair[] => (name === "LINK_WALLET" ? [owner, wallet] : [owner]);

/** `name` as built, rewritten by Phantom, signed by everyone it needs. */
const phantom = (name: OwnerFixtureName, rewrite: PhantomRewrite): Uint8Array => signedAsPhantom(unsigned(name), rewrite, ...signersOf(name));

/** Phantom's usual check: the pension key's lamports, owner and data length after the transaction. */
const payerCheck = (): TransactionInstruction => guard(GUARD_DATA.payer(1_000_000_000n), owner.publicKey);

function expectRefusal(bytes: Uint8Array, reason: VerifyRefusal, detail?: RegExp): void {
  const result = verifySignedTransaction(bytes);
  expect(result.ok, result.ok ? "accepted" : result.detail).toBe(false);
  if (result.ok) return;
  expect(result.reason, result.detail).toBe(reason);
  if (detail !== undefined) expect(result.detail).toMatch(detail);
}

function expectVerified(bytes: Uint8Array): Extract<ReturnType<typeof verifySignedTransaction>, { ok: true }> {
  const result = verifySignedTransaction(bytes);
  expect(result.ok, result.ok ? "" : `${result.reason}: ${result.detail}`).toBe(true);
  if (!result.ok) throw new Error("refused");
  return result;
}

const u64 = (value: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};

describe("readLighthouseGuard", () => {
  it.each<[string, string, string, number]>([
    // Byte for byte from successful mainnet transactions (signatures in phantom-rewrite.ts).
    ["the pension key's lamports, owner and data length", "060403003ffc2e24040000000403000001000000000000000000", "AssertAccountInfoMulti", 3],
    ["a system account's owner and data length", "06040203000001000000000000000000", "AssertAccountInfoMulti", 2],
    ["a token account's amount, delegate, delegated amount and derivation", "0a0404023e81330000000000040300000600000000000000000508", "AssertTokenAccountMulti", 4],
    ["a token account's delegate, delegated amount and derivation", "0a04030300000600000000000000000508", "AssertTokenAccountMulti", 3],
    ["a program-owned account's owner", "0604010297b9457d8bbefa5f1562efbf3db07d84cdc0ef3cab00ccafc499c4411c05da9800", "AssertAccountInfoMulti", 1],
    ["a token account's owner and mint, as 4ZE2LMw9…", "0a04040300000600000000000000000501c5b057ab45a92c6088bf5ee002180a75dee9f7468279e80ad28428ac4f5ad3ab0000d6f4cb70e5e68dcccdd719d4502f42bb8113a2b60ce9b4cf61bec675f0b38d3300", "AssertTokenAccountMulti", 4],
  ])("reads Phantom's mainnet check on %s", (_, hex, kind, assertions) => {
    expect(readLighthouseGuard(Uint8Array.from(Buffer.from(hex, "hex")))).toEqual({ ok: true, kind, logLevel: 4, assertions });
  });

  it("reads every assertion of both kinds, and every log level that calls no program", () => {
    const key = keypair().publicKey.toBytes();
    const accountInfo = [
      concat(0, u64(5n), 7), // Lamports, DoesNotContain
      concat(1, u64(0n), 0), // DataLength ==
      concat(2, key, 1), // Owner !=
      concat(3, 8, 0), // KnownOwner SysvarConfig
      concat(4, u64(1n), 2), // RentEpoch >
      concat(5, 1, 0), // IsSigner true
      concat(6, 0, 1), // IsWritable false
      concat(7, 0, 0), // Executable false
    ];
    const datahash = concat(8, new Uint8Array(32), 0x80, 0x01, 0xac, 0x02); // VerifyDatahash start 128, length 300
    const tokenAccount = [
      concat(0, key, 0), // Mint
      concat(1, key, 0), // Owner
      concat(2, u64(9n), 4), // Amount >=
      concat(3, 1, key, 1), // Delegate Some, !=
      concat(4, 2, 0), // State
      concat(5, 1, u64(2_039_280n), 0), // IsNative Some
      concat(6, u64(0n), 5), // DelegatedAmount <=
      concat(7, 0, 0), // CloseAuthority None
    ];
    for (const logLevel of [0, 1, 2, 4, 5]) {
      expect(readLighthouseGuard(concat(6, logLevel, accountInfo.length, ...accountInfo))).toEqual({ ok: true, kind: "AssertAccountInfoMulti", logLevel, assertions: 8 });
      expect(readLighthouseGuard(concat(6, logLevel, 1, datahash))).toMatchObject({ ok: true, assertions: 1 });
      expect(readLighthouseGuard(concat(10, logLevel, tokenAccount.length, ...tokenAccount))).toEqual({ ok: true, kind: "AssertTokenAccountMulti", logLevel, assertions: 8 });
      expect(readLighthouseGuard(concat(10, logLevel, 1, 8))).toMatchObject({ ok: true, assertions: 1 });
    }
  });

  it.each<[string, Uint8Array, RegExp]>([
    ["MemoryWrite", concat(0, 0, 254, 0, 1, 1), /MemoryWrite \(0\), which creates or grows a Lighthouse memory account and pays its rent/],
    ["MemoryClose", concat(1, 0, 254), /MemoryClose \(1\), which moves a Lighthouse memory account's lamports/],
    ["the old test fixture: MemoryClose's tag alone", concat(1), /MemoryClose \(1\)/],
    ["AssertAccountDelta", concat(4, 4, 0, 0, u64(0n), 0), /AssertAccountDelta \(4\), which compares against a MemoryWrite snapshot/],
    ["AssertMerkleTreeAccount", concat(16, 4, 0), /AssertMerkleTreeAccount \(16\), which calls the account-compression program/],
    ["the single AssertAccountInfo, never seen from Phantom", concat(5, 4, 0, u64(1n), 4), /AssertAccountInfo \(5\), which Phantom has not been seen adding/],
    ["AssertAccountData", concat(2, 4, 0, 0), /AssertAccountData \(2\)/],
    ["AssertSysvarClock", concat(15, 0, 0, u64(1n), 4), /AssertSysvarClock \(15\)/],
    ["an instruction the program does not have", concat(18, 4, 1), /instruction 18, which the Lighthouse program does not have/],
    ["no data", new Uint8Array(0), /empty/],
    ["log level EncodedNoop", concat(6, 3, 1, 5, 1, 0), /log level EncodedNoop, which calls the SPL Noop program/],
    ["log level FailedEncodedNoop", concat(10, 6, 1, 8), /log level FailedEncodedNoop, which calls the SPL Noop program/],
    ["a log level that does not exist", concat(6, 7, 1, 5, 1, 0), /log level 7 does not exist/],
    ["no assertion", concat(6, 4, 0), /with 0 assertions; 1 to 8 are relayed/],
    [`${MAX_GUARD_ASSERTIONS + 1} assertions`, concat(10, 4, 9, ...new Array<number>(9).fill(8)), /with 9 assertions/],
    ["a byte after its last assertion", concat(10, 4, 1, 8, 0), /with 1 bytes after its last assertion/],
    ["a u64 cut short", concat(6, 4, 1, 0, 1, 2, 3), /runs past the end/],
    ["a count in a longer encoding than it needs", concat(10, 4, 0x81, 0x00, 8), /not in its shortest encoding/],
    ["a bool that is neither 0 nor 1", concat(6, 4, 1, 5, 2, 0), /a bool 2 does not exist/],
    ["an option tag that is neither 0 nor 1", concat(10, 4, 1, 7, 2, 0), /option tag 2 does not exist/],
    ["an integer operator past DoesNotContain", concat(6, 4, 1, 0, u64(1n), 8), /an integer operator 8 does not exist/],
    ["an equality operator past NotEqual", concat(6, 4, 1, 5, 1, 2), /an equality operator 2 does not exist/],
    ["a known program past SysvarConfig", concat(6, 4, 1, 3, 9, 0), /a known program 9 does not exist/],
    ["an account-info assertion past VerifyDatahash", concat(6, 4, 1, 9), /an account-info assertion variant 9 does not exist/],
    ["a token-account assertion past TokenAccountOwnerIsDerived", concat(10, 4, 1, 9), /a token-account assertion variant 9 does not exist/],
  ])("refuses %s, in words", (_, data, detail) => {
    const read = readLighthouseGuard(data);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.detail).toMatch(detail);
  });
});

describe("checkWalletGuards", () => {
  it("with no Lighthouse instruction answers ok and reads nothing else: every other rule stays the caller's", () => {
    const message = { keys: ["a", "b"], privileges: [], instructions: [{ programId: "x", accountKeys: ["zzz"], data: new Uint8Array(0) }] };
    expect(checkWalletGuards(message, new Map())).toEqual({ ok: true, ownCount: 1, guards: [] });
  });

  it("names its refusals as the verifier does", () => {
    for (const reason of WALLET_GUARD_REFUSALS) expect(VERIFY_REFUSALS).toContain(reason);
  });
});

describe("rule 8c accepts Phantom's checks on what SaverFi builds", () => {
  it.each(Object.keys(fixtures) as OwnerFixtureName[])("%s with Phantom's check on the pension key, legacy and v0", (name) => {
    for (const version of ["legacy", 0] as const) {
      const result = expectVerified(phantom(name, { guards: [payerCheck()], version }));
      expect(result.version).toBe(version);
      expect(result.instruction.name).toBe(fixtures[name].built.instruction);
      expect(result.feePayer).toBe(owner.publicKey.toBase58());
      expect(result.instructions.at(-1)).toEqual({ program: LIGHTHOUSE_PROGRAM, name: "AssertAccountInfoMulti" });
    }
  });

  it("create_vault_v2: the pension key's check appended, the vault's accounts reordered by the new key, still the same instruction", () => {
    const built = rewriteAsPhantom(unsigned("CREATE_VAULT_V2_PROFIT_DEFAULTS"), { guards: [] });
    const rewritten = rewriteAsPhantom(unsigned("CREATE_VAULT_V2_PROFIT_DEFAULTS"), { guards: [payerCheck()] });
    // Lighthouse joins the read-only keys, so indexes after it move: only a decompiled comparison holds.
    expect(rewritten.message.staticAccountKeys.map(String)).not.toEqual(built.message.staticAccountKeys.map(String));
    const result = expectVerified(phantom("CREATE_VAULT_V2_PROFIT_DEFAULTS", { guards: [payerCheck()] }));
    expect(result.instruction.accounts).toEqual(fixtures.CREATE_VAULT_V2_PROFIT_DEFAULTS.built.accounts);
  });

  it("link_wallet: checks on the pension key, the new trading link and the trading wallet after link_wallet, the consent still right before it, both signatures over Phantom's message", () => {
    const guards = [payerCheck(), guard(GUARD_DATA.owner(SIP_PROGRAM_ID), account("LINK_WALLET", "trading_link")), guard(GUARD_DATA.system(), wallet.publicKey)];
    for (const version of ["legacy", 0] as const) {
      const signed = phantom("LINK_WALLET", { guards, version });
      expect(signed.length).toBeLessThanOrEqual(MAX_TX_BYTES);
      const result = expectVerified(signed);
      expect(result.signers).toEqual([owner.publicKey.toBase58(), wallet.publicKey.toBase58()]);
      expect(result.instructions.map((instruction) => instruction.name)).toEqual([
        "SetComputeUnitLimit",
        "SetComputeUnitPrice",
        "Ed25519SigVerify",
        "link_wallet",
        "AssertAccountInfoMulti",
        "AssertAccountInfoMulti",
        "AssertAccountInfoMulti",
      ]);
    }
  });

  it(`set_invest_policy: its three token-account creations, then checks on the pension key, the policy and each new account — ${MAX_WALLET_GUARDS} in all`, () => {
    const vault = account("SET_INVEST_POLICY_GOLDEN_FLOORS", "vault");
    const created = FIRST_POLICY_VAULT_TOKEN_ACCOUNTS.map((entry) => deriveAta(vault, entry.mint, entry.tokenProgram));
    const guards = [
      payerCheck(),
      ...created.map((address) => guard(GUARD_DATA.token(0n), address)),
      guard(GUARD_DATA.owner(SIP_PROGRAM_ID), account("SET_INVEST_POLICY_GOLDEN_FLOORS", "policy")),
      guard(GUARD_DATA.owner(SIP_PROGRAM_ID), vault),
    ];
    expect(guards).toHaveLength(MAX_WALLET_GUARDS);
    const result = expectVerified(phantom("SET_INVEST_POLICY_GOLDEN_FLOORS", { guards }));
    expect(result.instructions.map((instruction) => instruction.name)).toEqual([
      "SetComputeUnitLimit",
      "SetComputeUnitPrice",
      "CreateIdempotent",
      "CreateIdempotent",
      "CreateIdempotent",
      "set_invest_policy",
      "AssertAccountInfoMulti",
      "AssertTokenAccountMulti",
      "AssertTokenAccountMulti",
      "AssertTokenAccountMulti",
      "AssertAccountInfoMulti",
      "AssertAccountInfoMulti",
    ]);
  });

  it("withdraw and withdraw_token: the pension key's check, and the token account the tokens arrive in", () => {
    expectVerified(phantom("WITHDRAW_150000000", { guards: [payerCheck()] }));
    const result = expectVerified(phantom("WITHDRAW_TOKEN_12345678", { guards: [payerCheck(), guard(GUARD_DATA.token(12_345_678n), account("WITHDRAW_TOKEN_12345678", "owner_token"))] }));
    expect(result.instruction.name).toBe("withdraw_token");
  });
});

describe("rule 8c refuses everything else", () => {
  it("a check before SaverFi's first instruction, between the compute-budget pair, or after it and before create_vault_v2 (where Phantom sometimes puts one): lighthouse_misplaced", () => {
    for (const at of [0, 1, 2]) {
      expectRefusal(phantom("CREATE_VAULT_V2_PROFIT_DEFAULTS", { guards: [payerCheck()], at }), "lighthouse_misplaced", /relayed only after all of SaverFi's instructions|stands first/);
    }
    // A leading block and a trailing check together.
    const signed = signedAsPhantom(unsigned("WITHDRAW_150000000"), { guards: [guard(GUARD_DATA.owner(SIP_PROGRAM_ID), account("WITHDRAW_150000000", "vault"))], at: 2, edit: (message) => message.instructions.push(payerCheck()) }, owner);
    expectRefusal(signed, "lighthouse_misplaced", /at position 3 stands before SaverFi's own instruction at position 4/);
  });

  it("a check between the consent's Ed25519SigVerify and link_wallet, or ahead of the consent: lighthouse_misplaced, before the consent rules read positions", () => {
    expectRefusal(phantom("LINK_WALLET", { guards: [payerCheck()], at: 3 }), "lighthouse_misplaced", /position 4 stands before SaverFi's own instruction at position 5/);
    expectRefusal(phantom("LINK_WALLET", { guards: [payerCheck()], at: 2 }), "lighthouse_misplaced");
  });

  it("a check among the vault's token-account creations, or between them and set_invest_policy: lighthouse_misplaced", () => {
    for (const at of [3, 5]) expectRefusal(phantom("SET_INVEST_POLICY_GOLDEN_FLOORS", { guards: [payerCheck()], at }), "lighthouse_misplaced");
  });

  it("MemoryWrite and MemoryClose with the accounts they take, the old fixture's bare MemoryClose, a Noop log level, and trailing bytes: lighthouse_instruction", () => {
    const [memory, bump] = PublicKey.findProgramAddressSync([Buffer.from("memory"), owner.publicKey.toBuffer(), Buffer.from([0])], LIGHTHOUSE);
    const memoryWrite = new TransactionInstruction({
      programId: LIGHTHOUSE,
      keys: [
        { pubkey: LIGHTHOUSE, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: memory, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([0, 0, bump, 0, 1, 1]),
    });
    expectRefusal(phantom("WITHDRAW_150000000", { guards: [memoryWrite, payerCheck()] }), "lighthouse_instruction", /MemoryWrite \(0\), which creates or grows a Lighthouse memory account and pays its rent/);
    const memoryClose = new TransactionInstruction({
      programId: LIGHTHOUSE,
      keys: [
        { pubkey: LIGHTHOUSE, isSigner: false, isWritable: false },
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: memory, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([1, 0, bump]),
    });
    expectRefusal(phantom("WITHDRAW_150000000", { guards: [payerCheck(), memoryClose] }), "lighthouse_instruction", /position 5 is MemoryClose \(1\), which moves/);
    const bare = new TransactionInstruction({ programId: LIGHTHOUSE, keys: [], data: Buffer.from([1]) });
    expectRefusal(phantom("CREATE_VAULT_V2_PROFIT_DEFAULTS", { guards: [bare] }), "lighthouse_instruction", /MemoryClose/);
    const noop = GUARD_DATA.payer(1n);
    noop[1] = 6;
    expectRefusal(phantom("CREATE_VAULT_V2_PROFIT_DEFAULTS", { guards: [guard(noop, owner.publicKey)] }), "lighthouse_instruction", /FailedEncodedNoop/);
    expectRefusal(phantom("CREATE_VAULT_V2_PROFIT_DEFAULTS", { guards: [guard(concat(GUARD_DATA.payer(1n), 0), owner.publicKey)] }), "lighthouse_instruction", /1 bytes after its last assertion/);
  });

  it("a check naming two accounts: lighthouse_instruction", () => {
    const two = new TransactionInstruction({
      programId: LIGHTHOUSE,
      keys: [
        { pubkey: owner.publicKey, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(account("WITHDRAW_150000000", "vault")), isSigner: false, isWritable: false },
      ],
      data: Buffer.from(GUARD_DATA.payer(1n)),
    });
    expectRefusal(phantom("WITHDRAW_150000000", { guards: [two] }), "lighthouse_instruction", /names 2 accounts; an assertion names exactly one/);
  });

  it(`${MAX_WALLET_GUARDS + 1} checks: lighthouse_count`, () => {
    const guards = Array.from({ length: MAX_WALLET_GUARDS + 1 }, () => payerCheck());
    expectRefusal(phantom("WITHDRAW_150000000", { guards }), "lighthouse_count", new RegExp(`${MAX_WALLET_GUARDS + 1} Lighthouse instructions; at most ${MAX_WALLET_GUARDS}`));
  });

  it("the same bytes for a program one byte away from Lighthouse's id: program_not_allowed", () => {
    const bytes = LIGHTHOUSE.toBytes();
    bytes[31] = bytes[31]! ^ 1;
    const lookalike = new PublicKey(bytes);
    expect(lookalike.toBase58().slice(0, 12)).toBe(LIGHTHOUSE_PROGRAM.slice(0, 12));
    expectRefusal(phantom("CREATE_VAULT_V2_PROFIT_DEFAULTS", { guards: [guard(GUARD_DATA.payer(1n), owner.publicKey, { programId: lookalike })] }), "program_not_allowed", new RegExp(lookalike.toBase58()));
  });

  it("a check on an account SaverFi's instructions do not name: lighthouse_accounts", () => {
    expectRefusal(phantom("WITHDRAW_150000000", { guards: [guard(GUARD_DATA.system(), keypair().publicKey)] }), "lighthouse_accounts", /which SaverFi's own instructions do not name/);
  });

  it("a check that makes a read-only account writable — link_wallet's config, withdraw_token's vault, the trading wallet: lighthouse_accounts", () => {
    expectRefusal(phantom("LINK_WALLET", { guards: [guard(GUARD_DATA.owner(SIP_PROGRAM_ID), account("LINK_WALLET", "config"), { isWritable: true })] }), "lighthouse_accounts", /is writable in the message, and read-only in SaverFi's own instructions/);
    expectRefusal(phantom("WITHDRAW_TOKEN_12345678", { guards: [guard(GUARD_DATA.owner(SIP_PROGRAM_ID), account("WITHDRAW_TOKEN_12345678", "vault"), { isWritable: true })] }), "lighthouse_accounts");
    // The trading wallet signs link_wallet read-only; a check cannot make it writable either.
    expectRefusal(phantom("LINK_WALLET", { guards: [guard(GUARD_DATA.system(), wallet.publicKey, { isWritable: true })] }), "lighthouse_accounts", /a writable signer in the message, and a read-only signer/);
  });

  it("a message that carries one more key than its instructions name, beside Phantom's check: lighthouse_accounts", () => {
    const stranger = keypair().publicKey;
    const rewritten = rewriteAsPhantom(unsigned("WITHDRAW_150000000"), { guards: [payerCheck()] }).message as Message;
    // Appended last, read-only and unsigned: every instruction's index still holds.
    const widened = new Message({
      header: { ...rewritten.header, numReadonlyUnsignedAccounts: rewritten.header.numReadonlyUnsignedAccounts + 1 },
      accountKeys: [...rewritten.accountKeys, stranger],
      recentBlockhash: rewritten.recentBlockhash,
      instructions: rewritten.instructions,
    });
    const tx = new VersionedTransaction(widened);
    tx.sign([owner]);
    expectRefusal(tx.serialize(), "lighthouse_accounts", new RegExp(`the message adds ${stranger.toBase58()}, which SaverFi's own instructions do not name`));
  });

  it("a check that brings in a new signer who signs too: lighthouse_accounts; one naming the vault as a signer cannot even be signed: missing_signature", () => {
    const stranger = keypair();
    const withStranger = signedAsPhantom(unsigned("CREATE_VAULT_V2_PROFIT_DEFAULTS"), { guards: [guard(GUARD_DATA.system(), stranger.publicKey, { isSigner: true })] }, owner, stranger);
    expectRefusal(withStranger, "lighthouse_accounts", new RegExp(`checks ${stranger.publicKey.toBase58()}, which SaverFi's own instructions do not name`));
    const vault = account("WITHDRAW_150000000", "vault");
    const tx = rewriteAsPhantom(unsigned("WITHDRAW_150000000"), { guards: [guard(GUARD_DATA.owner(SIP_PROGRAM_ID), vault, { isSigner: true })] });
    tx.sign([owner]);
    expectRefusal(tx.serialize(), "missing_signature");
  });

  it("another fee payer beside Phantom's checks: signature_count, as without them", () => {
    const payer = keypair();
    const signed = signedAsPhantom(unsigned("CREATE_VAULT_V2_PROFIT_DEFAULTS"), { guards: [payerCheck()], edit: (message) => (message.payerKey = payer.publicKey) }, payer, owner);
    expectRefusal(signed, "signature_count");
  });

  it("a non-Lighthouse instruction after the checks: Memo is program_not_allowed, a second price compute_budget_invalid, an Ed25519SigVerify after them lighthouse_misplaced", () => {
    const memo = new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from("x") });
    expectRefusal(phantom("WITHDRAW_150000000", { guards: [payerCheck(), memo] }), "program_not_allowed", new RegExp(`instructions for ${MEMO_PROGRAM} are not relayed`));
    // link_wallet already holds four instructions of its own: a fifth is refused by the count, checks or not.
    expectRefusal(phantom("LINK_WALLET", { guards: [payerCheck(), memo] }), "instruction_count");
    expectRefusal(phantom("WITHDRAW_150000000", { guards: [payerCheck(), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })] }), "compute_budget_invalid");
    const consent = Ed25519Program.createInstructionWithPublicKey({ publicKey: wallet.publicKey.toBytes(), message: new Uint8Array(140), signature: new Uint8Array(64) });
    expectRefusal(phantom("WITHDRAW_150000000", { guards: [payerCheck(), consent] }), "lighthouse_misplaced", /position 4 stands before SaverFi's own instruction at position 5/);
  });
});

describe("sizes", () => {
  it("withdraw_token under Token-2022 with two checks stays well under Solana's limit", () => {
    const built = buildWithdrawToken({ owner: owner.publicKey, mint: SPYX_MINT, tokenProgram: TOKEN_2022_PROGRAM, amountRaw: 1n, blockhash: FIXTURE_BLOCKHASH });
    const ownerToken = deriveAta(owner.publicKey, SPYX_MINT, TOKEN_2022_PROGRAM);
    const signed = signedAsPhantom(fromB64(built.txBase64), { guards: [payerCheck(), guard(GUARD_DATA.token(1n), ownerToken)] }, owner);
    expect(signed.length).toBeLessThan(MAX_TX_BYTES);
    expectVerified(signed);
  });
});
