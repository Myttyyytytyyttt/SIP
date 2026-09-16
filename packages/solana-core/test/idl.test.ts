// Pins the codec to the IDL and the IDL to the program source.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { INSTRUCTIONS_SYSVAR, SYSTEM_PROGRAM } from "../src/client/addresses";
import { base58Encode } from "../src/client/base58";
import { fieldOffset, structMaxSize } from "../src/client/borsh";
import { DecodeError, SIP_ACCOUNT_SPACE, decodeInvestmentPolicy, decodeProtocolConfig, decodeTradingLink, decodeVault } from "../src/client/decoders";
import {
  FORBIDDEN_INSTRUCTIONS,
  IDL_VEC_MAX_LEN,
  OLD_NUVEM_PROGRAM_ID,
  OWNER_INSTRUCTIONS,
  SIP_IDL,
  SIP_PROGRAM_ID,
  accountDiscriminator,
  eventDiscriminator,
  idlErrorByCode,
  idlInstruction,
  idlPartitionProblems,
  instructionDiscriminator,
  isForbiddenInstruction,
  isOwnerInstruction,
  toHex,
} from "../src/client/idl";
import { CONFIG_SEED, INVEST_SEED, LINK_SEED, VAULT_SEED } from "../src/client/pda";
import { keypair } from "./helpers";

const require = createRequire(import.meta.url);
const PROGRAM_DIR = dirname(require.resolve("@sip/solana-program/package.json"));
const STATE_RS = readFileSync(join(PROGRAM_DIR, "programs/sip-vault/src/state.rs"), "utf8");
const ERRORS_RS = readFileSync(join(PROGRAM_DIR, "programs/sip-vault/src/errors.rs"), "utf8");

const sha8 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
const key = (): Uint8Array => keypair().publicKey.toBytes();

describe("the program id", () => {
  it("is the IDL's sip-vault address and never the refused one", () => {
    expect(SIP_PROGRAM_ID).toBe("6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J");
    expect(SIP_PROGRAM_ID).not.toBe(OLD_NUVEM_PROGRAM_ID);
    expect(SIP_IDL.address).toBe(SIP_PROGRAM_ID);
  });
});

describe("the instruction classification", () => {
  it("puts every IDL instruction in exactly one of OWNER_INSTRUCTIONS and FORBIDDEN_INSTRUCTIONS", () => {
    expect(idlPartitionProblems()).toEqual([]);
    const names = SIP_IDL.instructions.map((instruction) => instruction.name).sort();
    expect([...OWNER_INSTRUCTIONS, ...FORBIDDEN_INSTRUCTIONS].sort()).toEqual(names);
  });

  it("reports an instruction the program gains but nobody classified", () => {
    const grown = { ...SIP_IDL, instructions: [...SIP_IDL.instructions, { ...idlInstruction("withdraw"), name: "sweep_everything" }] };
    expect(idlPartitionProblems(grown).join("\n")).toContain("sweep_everything");
  });

  it("keeps the link pair an owner's, and the keeper's cranks forbidden", () => {
    for (const name of ["link_wallet", "unlink_wallet"]) expect([name, isOwnerInstruction(name), isForbiddenInstruction(name)]).toEqual([name, true, false]);
    for (const name of ["wrap_sol", "convert", "invest", "settle_v2"]) expect([name, isOwnerInstruction(name), isForbiddenInstruction(name)]).toEqual([name, false, true]);
  });

  it("lists link_wallet's and unlink_wallet's accounts under the names and addresses the verifier binds", () => {
    const link = idlInstruction("link_wallet").accounts;
    expect(link.map((account) => account.name)).toEqual(["owner", "wallet", "vault", "trading_link", "config", "instructions_sysvar", "system_program"]);
    expect(link.map((account) => [account.signer === true, account.writable === true])).toEqual([
      [true, true],
      [true, false],
      [false, false],
      [false, true],
      [false, false],
      [false, false],
      [false, false],
    ]);
    expect(link.find((account) => account.name === "instructions_sysvar")?.address).toBe(INSTRUCTIONS_SYSVAR);
    expect(link.find((account) => account.name === "system_program")?.address).toBe(SYSTEM_PROGRAM);
    const unlink = idlInstruction("unlink_wallet").accounts;
    expect(unlink.map((account) => [account.name, account.signer === true, account.writable === true])).toEqual([
      ["authority", true, false],
      ["owner", false, true],
      ["vault", false, false],
      ["trading_link", false, true],
    ]);
  });
});

describe("the program's errors", () => {
  it("are errors.rs, variant by variant from 6000, each with its #[msg]", () => {
    const declared = [...ERRORS_RS.matchAll(/#\[msg\("((?:[^"\\]|\\.)*)"\)\]\s*(\w+),/g)].map((match, index) => ({ code: 6000 + index, name: match[2]!, msg: match[1]! }));
    expect(declared.length).toBeGreaterThanOrEqual(39);
    expect(SIP_IDL.errors.map((error) => ({ code: error.code, name: error.name, msg: error.msg }))).toEqual(declared);
  });

  it("explain the refusals the program review appended, and the owner-only unlink", () => {
    expect(idlErrorByCode(6002)).toEqual({ name: "UnlinkUnauthorized", msg: "only the vault owner may unlink a wallet" });
    expect(idlErrorByCode(6034)).toEqual({ name: "DisallowedVaultAccount", msg: "the venue route lists a vault token account this instruction does not measure" });
    expect(idlErrorByCode(6035)).toEqual({ name: "WalletIsOwner", msg: "a trading wallet cannot be linked to a vault it owns" });
    expect(idlErrorByCode(6036)).toEqual({ name: "LinkConsentMissing", msg: "no Ed25519 verification of the wallet's link consent precedes link_wallet" });
    expect(idlErrorByCode(6037)).toEqual({ name: "LinkConsentWrongSigner", msg: "the link consent is signed by a key that is not the wallet being linked" });
    expect(idlErrorByCode(6038)).toEqual({ name: "LinkConsentMismatch", msg: "the verified link consent does not name this program, wallet, vault and owner" });
    expect(idlErrorByCode(6039)).toBeNull();
  });
});

describe("discriminators", () => {
  it("equal Anchor's sha256 derivation for every instruction, account and event", () => {
    for (const instruction of SIP_IDL.instructions) expect(toHex(instructionDiscriminator(instruction.name))).toBe(sha8(`global:${instruction.name}`));
    for (const account of SIP_IDL.accounts) expect(toHex(accountDiscriminator(account.name))).toBe(sha8(`account:${account.name}`));
    for (const event of SIP_IDL.events) expect(toHex(eventDiscriminator(event.name))).toBe(sha8(`event:${event.name}`));
  });

  it("are the V2 values the web relies on", () => {
    expect(toHex(instructionDiscriminator("create_vault_v2"))).toBe("95e05a32579f1fdd");
    expect(toHex(instructionDiscriminator("set_policy_v2"))).toBe("07aad030ac9e49df");
    expect(toHex(instructionDiscriminator("link_wallet"))).toBe("565c1f92e433d1e6");
    expect(toHex(instructionDiscriminator("unlink_wallet"))).toBe("dc79610dc189d19f");
    expect(toHex(instructionDiscriminator("withdraw"))).toBe("b712469c946da122");
    expect(toHex(instructionDiscriminator("withdraw_token"))).toBe("88ebb505656d3951");
    expect(toHex(instructionDiscriminator("set_invest_policy"))).toBe("3dbdfb587f676d1c");
    expect(toHex(accountDiscriminator("ProtocolConfig"))).toBe("cf5bfa1c98b3d7d1");
  });
});

describe("account sizes and bounds", () => {
  it("pins the vec bound to state.rs MAX_LEGS and its #[max_len]", () => {
    const declared = /pub const MAX_LEGS: usize = (\d+);/.exec(STATE_RS);
    expect(declared?.[1]).toBeDefined();
    expect(IDL_VEC_MAX_LEN.InvestmentPolicy?.legs).toBe(Number(declared![1]));
    expect(STATE_RS).toMatch(/#\[max_len\(MAX_LEGS\)\]\s*pub legs: Vec<InvestmentLeg>/);
  });

  it("computes the space Anchor allocates from the IDL", () => {
    expect(SIP_ACCOUNT_SPACE.Vault).toBe(125);
    expect(SIP_ACCOUNT_SPACE.TradingLink).toBe(129);
    expect(SIP_ACCOUNT_SPACE.ProtocolConfig).toBe(203);
    // 8 + vault 32 + enabled 1 + venue 32 + in_mint 32 + vec 4 + 8×50 + tail 471
    expect(SIP_ACCOUNT_SPACE.InvestmentPolicy).toBe(970);
    expect(structMaxSize("InvestmentLeg")).toBe(50);
  });

  it("puts the TradingLink vault field at byte 40, the memcmp offset link listing filters on", () => {
    expect(8 + fieldOffset("TradingLink", "vault")).toBe(40);
  });

  it("keeps the PDA seeds equal to the constant seeds the IDL records", () => {
    const seedOf = (instruction: string, account: string): string => {
      const found = idlInstruction(instruction).accounts.find((candidate) => candidate.name === account) as { pda?: { seeds: { kind: string; value?: number[] }[] } };
      const constant = found.pda!.seeds.find((seed) => seed.kind === "const")!;
      return new TextDecoder().decode(Uint8Array.from(constant.value!));
    };
    expect(seedOf("create_vault_v2", "vault")).toBe(VAULT_SEED);
    expect(seedOf("link_wallet", "trading_link")).toBe(LINK_SEED);
    expect(seedOf("link_wallet", "vault")).toBe(VAULT_SEED);
    expect(seedOf("link_wallet", "config")).toBe(CONFIG_SEED);
    expect(seedOf("set_invest_policy", "policy")).toBe(INVEST_SEED);
    expect(seedOf("accept_authority", "config")).toBe(CONFIG_SEED);
  });
});

// Synthetic accounts built FIELD BY FIELD at hand-written offsets, independent
// of the codec, so an offset drift in either the IDL walk or the program shows.
describe("synthetic accounts decode at the V2 offsets", () => {
  it("Vault: skim_mode@61, volume_bps@62, policy_nonce@64, max_contribution@72, wallet_reserve@80", () => {
    const bytes = new Uint8Array(125);
    const view = new DataView(bytes.buffer);
    bytes.set(accountDiscriminator("Vault"), 0);
    const owner = key();
    bytes.set(owner, 8);
    bytes[40] = 254;
    bytes[41] = 1;
    bytes[42] = 1;
    view.setUint16(43, 2_500, true);
    view.setBigUint64(45, 123_456_789n, true);
    view.setBigInt64(53, -42n, true);
    bytes[61] = 1;
    view.setUint16(62, 37, true);
    view.setBigUint64(64, 9n, true);
    view.setBigUint64(72, 5_000_000_000n, true);
    view.setBigUint64(80, 10_000_000n, true);
    bytes.fill(0xee, 88);
    expect(decodeVault(bytes)).toEqual({
      owner: base58Encode(owner),
      bump: 254,
      version: 1,
      paused: true,
      skimBps: 2_500,
      lifetimeSaved: 123_456_789n,
      createdAt: -42n,
      skimMode: 1,
      volumeBps: 37,
      policyNonce: 9n,
      maxContribution: 5_000_000_000n,
      walletReserve: 10_000_000n,
    });
  });

  it("TradingLink: wallet, vault@40, epoch@72, settlement_nonce@80, frontier_slot@88, bump@96", () => {
    const bytes = new Uint8Array(129);
    const view = new DataView(bytes.buffer);
    bytes.set(accountDiscriminator("TradingLink"), 0);
    const wallet = key();
    const vault = key();
    bytes.set(wallet, 8);
    bytes.set(vault, 40);
    view.setBigUint64(72, 300_000_000n, true);
    view.setBigUint64(80, 7n, true);
    view.setBigUint64(88, 300_000_500n, true);
    bytes[96] = 253;
    expect(decodeTradingLink(bytes)).toEqual({
      wallet: base58Encode(wallet),
      vault: base58Encode(vault),
      epoch: 300_000_000n,
      settlementNonce: 7n,
      frontierSlot: 300_000_500n,
      bump: 253,
    });
  });

  it("ProtocolConfig: authority, attester@40, bump@72, keeper@73, pending@105, paused@137, version@138", () => {
    const bytes = new Uint8Array(203);
    bytes.set(accountDiscriminator("ProtocolConfig"), 0);
    const [authority, attester, keeper, pending] = [key(), key(), key(), key()];
    bytes.set(authority, 8);
    bytes.set(attester, 40);
    bytes[72] = 250;
    bytes.set(keeper, 73);
    bytes.set(pending, 105);
    bytes[137] = 1;
    bytes[138] = 2;
    expect(decodeProtocolConfig(bytes)).toEqual({
      authority: base58Encode(authority),
      attester: base58Encode(attester),
      bump: 250,
      keeper: base58Encode(keeper),
      pendingAuthority: base58Encode(pending),
      paused: true,
      version: 2,
    });
  });

  function policyBytes(legCount: number): { bytes: Uint8Array; legs: { mint: Uint8Array }[]; tailAt: number } {
    const bytes = new Uint8Array(970);
    const view = new DataView(bytes.buffer);
    bytes.set(accountDiscriminator("InvestmentPolicy"), 0);
    bytes.set(key(), 8);
    bytes[40] = 1;
    bytes.set(key(), 41);
    bytes.set(key(), 73);
    view.setUint32(105, legCount, true);
    const legs: { mint: Uint8Array }[] = [];
    for (let i = 0; i < legCount; i++) {
      const at = 109 + 50 * i;
      const mint = key();
      bytes.set(mint, at);
      view.setUint16(at + 32, 10_000 / legCount, true);
      view.setBigUint64(at + 34, BigInt(i + 1), true);
      legs.push({ mint });
    }
    const tailAt = 109 + 50 * legCount;
    view.setBigUint64(tailAt, 777n, true); // min_convert_rate_wad low half
    view.setBigUint64(tailAt + 8, 1n, true); // high half
    view.setBigUint64(tailAt + 16, 1_000_000n, true);
    view.setBigUint64(tailAt + 24, 50_000_000n, true);
    view.setBigUint64(tailAt + 32, 500_000_000n, true);
    view.setUint32(tailAt + 40, 20_000, true); // bucket_days[0]
    view.setBigUint64(tailAt + 40 + 124, 3_000_000n, true); // bucket_amounts[0]
    view.setBigUint64(tailAt + 40 + 124 + 248, 12_345n, true); // lifetime_invested
    view.setBigUint64(tailAt + 40 + 124 + 256, 4n, true); // policy_nonce
    bytes[tailAt + 40 + 124 + 264] = 249; // bump
    return { bytes, legs, tailAt };
  }

  for (const [legCount, tailAt] of [
    [1, 159],
    [8, 509],
  ] as const) {
    it(`InvestmentPolicy with ${legCount} leg(s): count@105, first leg@109, min_convert_rate_wad@${tailAt}`, () => {
      const built = policyBytes(legCount);
      expect(built.tailAt).toBe(tailAt);
      const policy = decodeInvestmentPolicy(built.bytes);
      expect(policy.legs).toHaveLength(legCount);
      expect(policy.legs[0]!.mint).toBe(base58Encode(built.legs[0]!.mint));
      expect(policy.legs[legCount - 1]!.minOutRateWad).toBe(BigInt(legCount));
      expect(policy.minConvertRateWad).toBe(777n + (1n << 64n));
      expect(policy.minInvestment).toBe(1_000_000n);
      expect(policy.maxPerCall).toBe(50_000_000n);
      expect(policy.maxRolling30d).toBe(500_000_000n);
      expect(policy.bucketDays[0]).toBe(20_000);
      expect(policy.bucketAmounts[0]).toBe(3_000_000n);
      expect(policy.lifetimeInvested).toBe(12_345n);
      expect(policy.policyNonce).toBe(4n);
      expect(policy.bump).toBe(249);
    });
  }

  it("refuses a wrong discriminator, a wrong size and more than MAX_LEGS legs", () => {
    const vault = new Uint8Array(125);
    vault.set(accountDiscriminator("TradingLink"), 0);
    expect(() => decodeVault(vault)).toThrow(DecodeError);
    expect(() => decodeVault(new Uint8Array(124))).toThrow(/124 bytes, expected 125/);
    const nine = policyBytes(1).bytes;
    new DataView(nine.buffer).setUint32(105, 9, true);
    expect(() => decodeInvestmentPolicy(nine)).toThrow(/caps it at 8/);
  });
});
