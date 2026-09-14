// Cross-checks the decoders against Anchor's own Borsh coders built from the
// same IDL: Anchor encodes, this package decodes (and the reverse for events).

import { createRequire } from "node:module";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { encodeStruct } from "../src/client/borsh";
import {
  SIP_ACCOUNT_SPACE,
  decodeInvestmentPolicy,
  decodeProtocolConfig,
  decodeSettledEvent,
  decodeTradingLink,
  decodeVault,
  snakeToCamel,
} from "../src/client/decoders";
import { base64Encode } from "../src/client/base64";
import { SIP_IDL, eventDiscriminator, idlTypeDef } from "../src/client/idl";
import { keypair } from "./helpers";

const require = createRequire(import.meta.url);
const rawIdl = require("@sip/solana-program/idl") as anchor.Idl;
const accounts = new anchor.BorshAccountsCoder(rawIdl);
const events = new anchor.BorshEventCoder(rawIdl);
const BN = anchor.BN;

const pk = (): PublicKey => keypair().publicKey;

/** Anchor values → this package's (BN → bigint, PublicKey → base58), keys camelCased, reserved dropped. */
function normalize(value: unknown): unknown {
  if (value instanceof BN) return BigInt(value.toString());
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, inner] of Object.entries(value)) {
      if (name.startsWith("_")) continue;
      out[snakeToCamel(name)] = normalize(inner);
    }
    return out;
  }
  return value;
}

async function anchorAccount(name: keyof typeof SIP_ACCOUNT_SPACE, value: Record<string, unknown>): Promise<Uint8Array> {
  const encoded = await accounts.encode(name, value);
  const bytes = new Uint8Array(SIP_ACCOUNT_SPACE[name]);
  bytes.set(encoded, 0);
  return bytes;
}

const fieldNames = (type: string): string[] =>
  (idlTypeDef(type).type.fields ?? []).filter((field) => !field.name.startsWith("_")).map((field) => snakeToCamel(field.name)).sort();

describe("decoders agree with Anchor's coder", () => {
  it("Vault", async () => {
    const value = {
      owner: pk(),
      bump: 255,
      version: 1,
      paused: false,
      skim_bps: 1_500,
      lifetime_saved: new BN("18446744073709551615"),
      created_at: new BN(-1_700_000_000),
      skim_mode: 0,
      volume_bps: 100,
      policy_nonce: new BN(3),
      max_contribution: new BN("250000000000"),
      wallet_reserve: new BN(0),
      _reserved: new Array(37).fill(0),
    };
    const decoded = decodeVault(await anchorAccount("Vault", value));
    expect(decoded).toEqual(normalize(value));
    expect(Object.keys(decoded).sort()).toEqual(fieldNames("Vault"));
  });

  it("TradingLink", async () => {
    const value = {
      wallet: pk(),
      vault: pk(),
      epoch: new BN(310_000_000),
      settlement_nonce: new BN(12),
      frontier_slot: new BN(310_100_000),
      bump: 251,
      _reserved: new Array(32).fill(0),
    };
    const decoded = decodeTradingLink(await anchorAccount("TradingLink", value));
    expect(decoded).toEqual(normalize(value));
    expect(Object.keys(decoded).sort()).toEqual(fieldNames("TradingLink"));
  });

  it("ProtocolConfig", async () => {
    const value = {
      authority: pk(),
      attester: pk(),
      bump: 254,
      keeper: PublicKey.default,
      pending_authority: pk(),
      paused: true,
      version: 2,
      _reserved: new Array(64).fill(0),
    };
    const decoded = decodeProtocolConfig(await anchorAccount("ProtocolConfig", value));
    expect(decoded).toEqual(normalize(value));
    expect(Object.keys(decoded).sort()).toEqual(fieldNames("ProtocolConfig"));
  });

  for (const legCount of [1, 3, 8]) {
    it(`InvestmentPolicy with ${legCount} legs (the tail moves with the leg count)`, async () => {
      const legs = Array.from({ length: legCount }, (_, i) => ({
        mint: pk(),
        weight_bps: i === 0 ? 10_000 - (legCount - 1) * 1_000 : 1_000,
        min_out_rate_wad: new BN(((1n << 100n) + BigInt(i)).toString()),
      }));
      const value = {
        vault: pk(),
        enabled: true,
        venue_program: pk(),
        in_mint: pk(),
        legs,
        min_convert_rate_wad: new BN("340282366920938463463374607431768211455"),
        min_investment: new BN(1_000_000),
        max_per_call: new BN(50_000_000),
        max_rolling_30d: new BN(500_000_000),
        bucket_days: Array.from({ length: 31 }, (_, i) => 20_000 + i),
        bucket_amounts: Array.from({ length: 31 }, (_, i) => new BN(i * 1_000)),
        lifetime_invested: new BN(99),
        policy_nonce: new BN(5),
        bump: 248,
        _reserved: new Array(32).fill(0),
      };
      const decoded = decodeInvestmentPolicy(await anchorAccount("InvestmentPolicy", value));
      expect(decoded).toEqual(normalize(value));
      expect(Object.keys(decoded).sort()).toEqual(fieldNames("InvestmentPolicy"));
      // Anchor's own camelCase is maxRolling30D; this package's is maxRolling30d.
      expect(decoded).toHaveProperty("maxRolling30d");
    });
  }

  it("Settled: bytes this package encodes are what Anchor's event coder reads from a log", () => {
    const vault = pk();
    const wallet = pk();
    const body = encodeStruct("Settled", {
      vault: vault.toBase58(),
      wallet: wallet.toBase58(),
      mode: 1,
      base_lamports: 4_000_000_000n,
      bps: 25,
      owed: 10_000_000n,
      paid: 9_000_000n,
      settlement_nonce: 8n,
      session_end_slot: 311_000_000n,
    });
    const line = new Uint8Array(8 + body.length);
    line.set(eventDiscriminator("Settled"), 0);
    line.set(body, 8);
    const read = events.decode(base64Encode(line));
    expect(read?.name).toBe("Settled");
    expect(decodeSettledEvent(line)).toEqual(normalize(read!.data));
    expect(Object.keys(decodeSettledEvent(line)).sort()).toEqual(fieldNames("Settled"));
  });

  it("covers every account the IDL declares", () => {
    expect(Object.keys(SIP_ACCOUNT_SPACE).sort()).toEqual(SIP_IDL.accounts.map((account) => account.name).sort());
  });
});
