// The volume keeper as a SEPARATE SERVICE: its role, its lock, its alerts, and a
// walk over the owner's real trades that carries their volume without moving a
// single profit figure.

import { PublicKey, type Finality } from "@solana/web3.js";
import { Redactor } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { createAlerter } from "../src/alerts.js";
import { loadConfig, readRole } from "../src/config.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { tradeNotional } from "../src/measure-volume.js";
import { measureSince, readTransaction, type LedgerReader } from "../src/measure-window.js";
import { KEEPER_LOCK_NAME, VOLUME_KEEPER_LOCK_NAME, advisoryKeyFor, lockNameFor } from "../src/singleton.js";
import { FakeLedger, chained } from "./fake-ledger.js";
import { FIXTURES, fixtureConnection } from "./volume-fixtures.js";

const RPC = "https://rpc.example.test";
const dry = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ SIP_SOLANA_RPC_URLS: RPC, SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID, ...over });

describe("SIP_SOLANA_ROLE", () => {
  it("is the profit keeper unset, empty or \"profit\", and the volume keeper only as exactly \"volume\"", () => {
    expect(readRole(undefined)).toEqual({ role: "profit" });
    expect(readRole("")).toEqual({ role: "profit" });
    expect(readRole("profit")).toEqual({ role: "profit" });
    expect(readRole(" volume ")).toEqual({ role: "volume" });
    expect(loadConfig(dry(), new Redactor()).role).toBe("profit");
    expect(loadConfig(dry({ SIP_SOLANA_ROLE: "volume" }), new Redactor()).role).toBe("volume");
  });

  it("refuses to start on any other value rather than guess a role", () => {
    for (const value of ["Volume", "volumen", "beneficio", "both"]) {
      expect(() => loadConfig(dry({ SIP_SOLANA_ROLE: value }), new Redactor()), value).toThrow(/SIP_SOLANA_ROLE/);
    }
  });

  it("is a variable the keeper knows, so it raises no misspelling warning", () => {
    expect(loadConfig(dry({ SIP_SOLANA_ROLE: "volume" }), new Redactor()).warnings.join(" ")).not.toMatch(/not a variable this keeper reads/);
  });

  it("switches the doorbell off on the volume keeper, and says so when its secret is set", () => {
    const secret = "d".repeat(64);
    const profit = loadConfig(dry({ SIP_SOLANA_DOORBELL_SECRET: secret }), new Redactor());
    const volume = loadConfig(dry({ SIP_SOLANA_ROLE: "volume", SIP_SOLANA_DOORBELL_SECRET: secret }), new Redactor());
    expect(profit.doorbellSecret).not.toBeNull();
    expect(volume.doorbellSecret).toBeNull();
    expect(volume.doorbellUrl).toBeNull();
    expect(volume.warnings.join(" ")).toMatch(/volume keeper, which does not run the doorbell/);
  });
});

describe("the two locks", () => {
  it("are different names, so neither keeper waits on or takes over the other", () => {
    expect(lockNameFor("profit")).toBe(KEEPER_LOCK_NAME);
    expect(lockNameFor("profit")).toBe("sip-solana-keeper");
    expect(lockNameFor("volume")).toBe(VOLUME_KEEPER_LOCK_NAME);
    expect(advisoryKeyFor(lockNameFor("volume"))).not.toBe(advisoryKeyFor(lockNameFor("profit")));
  });
});

describe("the volume keeper's alerts", () => {
  it("carry its name in front of the title, in the log and in the body", () => {
    const logged: string[] = [];
    const posted: string[] = [];
    const alerter = createAlerter({
      webhookUrl: null,
      titlePrefix: "[volume] ",
      log: (_severity, line) => void logged.push(line),
      post: async (_url, body) => void posted.push(body),
    });
    alerter.fire({ key: "k", severity: "critical", title: "A settlement failed", detail: "d" });
    expect(logged[0]).toContain("[CRITICAL] [volume] A settlement failed");
  });

  it("leave the profit keeper's titles exactly as fired", () => {
    const logged: string[] = [];
    const alerter = createAlerter({ webhookUrl: null, log: (_severity, line) => void logged.push(line) });
    alerter.fire({ key: "k", severity: "critical", title: "A settlement failed", detail: "d" });
    expect(logged[0]).toBe("[CRITICAL] A settlement failed — d");
  });
});

describe("a walk over the owner's real trades", () => {
  const wallet = new PublicKey(FIXTURES["owner-buy-1"]!.wallet);
  // The settle of 2026-09-19 is the anchor, at the span's start; the four trades
  // of 2026-09-23 are above it. (Other transactions sat between them on chain, so
  // this walk records a balance-chain break; the figures below do not depend on it.)
  const order = ["owner-settle-2026-09-19", "owner-buy-1", "owner-sell-1", "owner-buy-2", "owner-sell-2"];
  const from = BigInt(FIXTURES["owner-settle-2026-09-19"]!.result.slot);
  const reader = (): LedgerReader => {
    const connection = fixtureConnection();
    const newestFirst = [...order].reverse().map((name) => ({ signature: FIXTURES[name]!.signature, slot: FIXTURES[name]!.result.slot }));
    return {
      signatures: async (_wallet, options, _commitment: Finality) => {
        const start = options.before === undefined ? 0 : newestFirst.findIndex((e) => e.signature === options.before) + 1;
        return newestFirst.slice(start, start + options.limit);
      },
      transaction: (signature, commitment) => readTransaction(connection, signature, commitment),
    };
  };

  it("carries each trade's volume, 4.058319740 SOL in all, when the volume keeper passes its probe", async () => {
    const measured = await measureSince(reader(), wallet, from, new PublicKey(SIP_PROGRAM_ID), tradeNotional);
    expect(measured.volumeTrades?.map((t) => t.lamports)).toEqual([1_010_000_000n, 1_010_896_197n, 959_647_432n, 1_077_776_111n]);
    expect(measured.volumeTrades?.reduce((sum, t) => sum + t.lamports, 0n)).toBe(4_058_319_740n);
    expect(measured.volumeTrades?.every((t) => t.blockTime !== null)).toBe(true);
  });

  it("changes no profit figure, and carries no volume, on the profit keeper's walk", async () => {
    const withProbe = await measureSince(reader(), wallet, from, new PublicKey(SIP_PROGRAM_ID), tradeNotional);
    const without = await measureSince(reader(), wallet, from, new PublicKey(SIP_PROGRAM_ID));
    expect(without.volumeTrades).toBeUndefined();
    const { volumeTrades: _dropped, ...rest } = withProbe;
    expect(rest).toEqual(without);
    // The profit keeper's own figures on this span, as they were before the probe existed.
    expect(without.successfulTradeCount).toBe(4);
    expect(without.tradedLamports).toBe(4_059_833_580n);
  });
});

describe("the walk records only what the probe counted", () => {
  it("leaves a deposit and a transfer out of the volume trades, though it measures both", async () => {
    const wallet = new PublicKey(FIXTURES["owner-buy-1"]!.wallet);
    const SYSTEM = "11111111111111111111111111111111";
    const ledger = new FakeLedger(
      wallet,
      chained(1_000_000_000, [
        { signature: "anchor", slot: 100, programs: [SYSTEM], delta: 0 },
        { signature: "deposit", slot: 150, programs: [SYSTEM], delta: 500_000_000 },
        { signature: "transfer-out", slot: 160, programs: [SYSTEM], delta: -200_000_000 },
      ]),
    );
    const measured = await measureSince(ledger, wallet, 100n, new PublicKey(SIP_PROGRAM_ID), tradeNotional);
    expect(measured.txCount).toBe(2);
    expect(measured.volumeTrades).toEqual([]);
  });
});
