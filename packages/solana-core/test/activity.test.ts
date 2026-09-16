// classifyVaultEntry: what a vault's transaction did, named from its instructions
// and the vault's own balances — and never from a lamport delta alone.

import { describe, expect, it } from "vitest";

import { SPYX_MINT, USDC_MINT, WSOL_MINT } from "../src/client/addresses";
import { classifyVaultEntry, subtractDecimals, type ClassifiableEntry, type SipInstructionCall, type VaultTokenDelta } from "../src/client/activity";
import type { SettledEvent } from "../src/client/decoders";
import { keypair } from "./helpers";

const key = (): string => keypair().publicKey.toBase58();

const VAULT = key();
const WALLET = key();

function call(name: string, args: Record<string, unknown> | null = {}, accounts: Record<string, string> = {}): SipInstructionCall {
  return { name, args, accounts };
}

function delta(mint: string, pre: [string, string], post: [string, string], decimals = 6): VaultTokenDelta {
  return { account: key(), mint, decimals, preRaw: pre[0], preUi: pre[1], postRaw: post[0], postUi: post[1] };
}

function settled(fields: Partial<SettledEvent> = {}): SettledEvent {
  return {
    vault: VAULT,
    wallet: WALLET,
    mode: 0,
    baseLamports: 500_000_000n,
    bps: 2_000,
    owed: 100_000_000n,
    paid: 100_000_000n,
    settlementNonce: 0n,
    sessionEndSlot: 220n,
    linkEpoch: 200n,
    sessionStartSlot: 200n,
    policyNonce: 0n,
    ...fields,
  };
}

function entry(overrides: Partial<ClassifiableEntry> = {}): ClassifiableEntry {
  return {
    signature: "s".repeat(64),
    slot: 1_000,
    blockTime: 1_789_500_000,
    ok: true,
    readable: true,
    instructions: [],
    vaultLamportsDelta: 0n,
    vaultTokenDeltas: [],
    settled: [],
    ...overrides,
  };
}

describe("settlements", () => {
  it("one Settled event per settle_v2, with what was owed and what actually moved", () => {
    const events = classifyVaultEntry(entry({ instructions: [call("settle_v2")], settled: [settled()], vaultLamportsDelta: 100_000_000n }));
    expect(events).toEqual([
      {
        kind: "settled",
        wallet: WALLET,
        mode: 0,
        baseLamports: 500_000_000n,
        bps: 2_000,
        owed: 100_000_000n,
        paid: 100_000_000n,
        capped: false,
        settlementNonce: 0n,
        linkEpoch: 200n,
        sessionStartSlot: 200n,
        sessionEndSlot: 220n,
      },
    ]);
  });

  it("paid under owed is capped; a zero settlement is still a settlement", () => {
    const capped = classifyVaultEntry(entry({ instructions: [call("settle_v2")], settled: [settled({ owed: 100_000_000n, paid: 60_000_000n })] }));
    expect(capped[0]).toMatchObject({ kind: "settled", capped: true, owed: 100_000_000n, paid: 60_000_000n });

    const zero = classifyVaultEntry(entry({ instructions: [call("settle_v2")], settled: [settled({ owed: 0n, paid: 0n })] }));
    expect(zero[0]).toMatchObject({ kind: "settled", capped: false, paid: 0n });
  });

  it("two Settled events in one transaction become two rows, in order", () => {
    const events = classifyVaultEntry(
      entry({
        instructions: [call("settle_v2"), call("settle_v2")],
        settled: [settled({ paid: 1n, settlementNonce: 4n }), settled({ paid: 2n, settlementNonce: 5n })],
      }),
    );
    expect(events.map((event) => [event.kind, event.kind === "settled" ? event.paid : null])).toEqual([
      ["settled", 1n],
      ["settled", 2n],
    ]);
  });

  it("A SETTLEMENT IS NEVER INFERRED: a settle_v2 whose event did not parse is `other`, not a settlement with guessed numbers", () => {
    const events = classifyVaultEntry(entry({ instructions: [call("settle_v2")], settled: [], vaultLamportsDelta: 60_000_000n }));
    expect(events).toEqual([{ kind: "other", instructions: ["settle_v2"] }]);
    expect(events.some((event) => event.kind === "settled")).toBe(false);
  });
});

describe("the keeper's investing steps", () => {
  it("wrap_sol carries its amount", () => {
    expect(classifyVaultEntry(entry({ instructions: [call("wrap_sol", { amount: 10_000_000n })] }))).toEqual([{ kind: "wrapped", lamports: 10_000_000n }]);
  });

  it("convert reads the vault's own wSOL and USDC balances, never min_out", () => {
    const events = classifyVaultEntry(
      entry({
        instructions: [call("convert", { amount_in: 10_000_000n, min_out: 900_000n })],
        vaultTokenDeltas: [delta(WSOL_MINT, ["10000000", "0.01"], ["0", "0"], 9), delta(USDC_MINT, ["0", "0"], ["1000342", "1.000342"])],
      }),
    );
    expect(events).toEqual([{ kind: "converted", lamportsSpent: 10_000_000n, usdcReceivedRaw: 1_000_342n }]);
    // min_out is a floor the swap had to clear, not what it returned.
    expect(JSON.stringify(events, (_, value) => (typeof value === "bigint" ? value.toString() : value))).not.toContain("900000");
  });

  it("convert with no balances read says so, rather than inventing amounts", () => {
    expect(classifyVaultEntry(entry({ instructions: [call("convert", { amount_in: 1n, min_out: 1n })] }))).toEqual([
      { kind: "converted", lamportsSpent: null, usdcReceivedRaw: null },
    ]);
  });

  it("invest names the leg and takes SPYx's DISPLAY amount from the RPC's strings, which are not amountRaw / 10^decimals", () => {
    // A scaledUiAmount mint: 11,345,678 raw units display as 0.1241643, not 0.11345678.
    const events = classifyVaultEntry(
      entry({
        instructions: [call("invest", { leg_index: 0, amount_in: 5_000_000n, min_out: 1n }, { target_mint: SPYX_MINT })],
        vaultTokenDeltas: [
          delta(USDC_MINT, ["5000000", "5"], ["0", "0"]),
          delta(SPYX_MINT, ["0", "0"], ["11345678", "0.1241643"], 8),
        ],
      }),
    );
    expect(events).toEqual([
      { kind: "invested", mint: SPYX_MINT, symbol: "SPYx", usdcSpentRaw: 5_000_000n, receivedRaw: 11_345_678n, receivedUi: "0.1241643" },
    ]);
  });

  it("invest with no balances keeps the leg and drops the amounts", () => {
    const events = classifyVaultEntry(entry({ instructions: [call("invest", { leg_index: 0 }, { target_mint: SPYX_MINT })] }));
    expect(events).toEqual([{ kind: "invested", mint: SPYX_MINT, symbol: "SPYx", usdcSpentRaw: null, receivedRaw: null, receivedUi: null }]);
  });
});

describe("the owner's own transactions", () => {
  it("withdraw carries its lamports", () => {
    expect(classifyVaultEntry(entry({ instructions: [call("withdraw", { amount: 20_000_000n })] }))).toEqual([{ kind: "withdrew_sol", lamports: 20_000_000n }]);
  });

  it("withdraw_token names the mint and says how much left, for wSOL and for SPYx", () => {
    const wsol = classifyVaultEntry(
      entry({
        instructions: [call("withdraw_token", { amount: 100_000_000n }, { token_mint: WSOL_MINT })],
        vaultTokenDeltas: [delta(WSOL_MINT, ["100000000", "0.1"], ["0", "0"], 9)],
      }),
    );
    expect(wsol).toEqual([{ kind: "withdrew_token", mint: WSOL_MINT, amountRaw: 100_000_000n, uiAmount: "0.1" }]);

    const spyx = classifyVaultEntry(
      entry({
        instructions: [call("withdraw_token", { amount: 1_000_000n }, { token_mint: SPYX_MINT })],
        vaultTokenDeltas: [delta(SPYX_MINT, ["11345678", "0.1241643"], ["10345678", "0.1132212"], 8)],
      }),
    );
    expect(spyx).toEqual([{ kind: "withdrew_token", mint: SPYX_MINT, amountRaw: 1_000_000n, uiAmount: "0.0109431" }]);
  });

  it("create_vault_v2 and set_policy_v2 carry the rule as it was signed", () => {
    const created = classifyVaultEntry(
      entry({ instructions: [call("create_vault_v2", { mode: 0, skim_bps: 2_000, volume_bps: 200, max_contribution: 60_000_000n, wallet_reserve: 50_000_000n })] }),
    );
    expect(created).toEqual([{ kind: "vault_created", mode: 0, skimBps: 2_000, volumeBps: 200, maxContribution: 60_000_000n, walletReserve: 50_000_000n }]);

    const changed = classifyVaultEntry(
      entry({ instructions: [call("set_policy_v2", { mode: 0, skim_bps: 3_000, volume_bps: 200, paused: true, max_contribution: 1n, wallet_reserve: 0n })] }),
    );
    expect(changed).toEqual([{ kind: "rule_changed", mode: 0, skimBps: 3_000, volumeBps: 200, paused: true, maxContribution: 1n, walletReserve: 0n }]);
  });

  it("set_invest_policy says whether it turned investing on or off", () => {
    const args = { min_investment: 5_000_000n, max_per_call: 1_000_000_000n, max_rolling_30d: 31_000_000_000n };
    expect(classifyVaultEntry(entry({ instructions: [call("set_invest_policy", { ...args, enabled: true })] }))).toEqual([
      { kind: "policy_signed", enabled: true, minInvestment: 5_000_000n, maxPerCall: 1_000_000_000n, maxRolling30d: 31_000_000_000n },
    ]);
    expect(classifyVaultEntry(entry({ instructions: [call("set_invest_policy", { ...args, enabled: false })] }))[0]).toMatchObject({ kind: "policy_signed", enabled: false });
  });

  it("link_wallet names the wallet; unlink_wallet does not name one, so it claims none", () => {
    expect(classifyVaultEntry(entry({ instructions: [call("link_wallet", {}, { wallet: WALLET, vault: VAULT })] }))).toEqual([{ kind: "linked", wallet: WALLET }]);
    // unlink_wallet's IDL accounts are authority, owner, vault and trading_link:
    // the wallet is not among them and is not guessed from the link PDA.
    expect(classifyVaultEntry(entry({ instructions: [call("unlink_wallet", {}, { owner: key(), vault: VAULT, trading_link: key() })] }))).toEqual([
      { kind: "unlinked", wallet: null },
    ]);
  });

  it("arguments that did not decode leave their fields null rather than a number nobody read", () => {
    expect(classifyVaultEntry(entry({ instructions: [call("withdraw", null)] }))).toEqual([{ kind: "withdrew_sol", lamports: null }]);
  });
});

describe("transactions with no SIP instruction", () => {
  it("SOL that arrived is a plain transfer, never a settlement", () => {
    const events = classifyVaultEntry(entry({ vaultLamportsDelta: 5_000_000n }));
    expect(events).toEqual([{ kind: "received_sol", lamports: 5_000_000n }]);
  });

  it("nothing of the vault's moved: upkeep", () => {
    expect(classifyVaultEntry(entry({ vaultLamportsDelta: 0n }))).toEqual([{ kind: "upkeep" }]);
    expect(classifyVaultEntry(entry({ vaultLamportsDelta: null }))).toEqual([{ kind: "upkeep" }]);
  });

  it("a token balance that moved with no SIP instruction is `other`, not named", () => {
    const events = classifyVaultEntry(entry({ vaultLamportsDelta: 0n, vaultTokenDeltas: [delta(USDC_MINT, ["0", "0"], ["25", "0.000025"])] }));
    expect(events).toEqual([{ kind: "other", instructions: [] }]);
  });

  it("a token account that opened but holds nothing is still upkeep", () => {
    const events = classifyVaultEntry(entry({ vaultLamportsDelta: 0n, vaultTokenDeltas: [delta(USDC_MINT, ["0", "0"], ["0", "0"])] }));
    expect(events).toEqual([{ kind: "upkeep" }]);
  });
});

describe("precedence", () => {
  it("a failed transaction is failed, whatever it holds", () => {
    const events = classifyVaultEntry(entry({ ok: false, instructions: [call("settle_v2")], settled: [settled()] }));
    expect(events).toEqual([{ kind: "failed", instructions: ["settle_v2"] }]);
  });

  it("a transaction that could not be read says so, and is never read as an empty one", () => {
    const events = classifyVaultEntry(entry({ readable: false, vaultLamportsDelta: null }));
    expect(events).toEqual([{ kind: "unreadable" }]);
    expect(events[0]!.kind).not.toBe("upkeep");
  });

  it("several SIP instructions come out in order, the unnamed ones gathered once at the end", () => {
    const events = classifyVaultEntry(
      entry({
        instructions: [
          call("wrap_sol", { amount: 1n }),
          call("convert", { amount_in: 1n }),
          call("invest", { leg_index: 0 }, { target_mint: SPYX_MINT }),
          call("unknown"),
        ],
      }),
    );
    expect(events.map((event) => event.kind)).toEqual(["wrapped", "converted", "invested", "other"]);
    expect(events[3]).toEqual({ kind: "other", instructions: ["unknown"] });
  });
});

describe("subtractDecimals", () => {
  it("subtracts the RPC's display strings exactly, without a float", () => {
    expect(subtractDecimals("0.1241643", "0")).toBe("0.1241643");
    expect(subtractDecimals("0.1241643", "0.1132212")).toBe("0.0109431");
    expect(subtractDecimals("0", "0.1")).toBe("-0.1");
    expect(subtractDecimals("1", "1")).toBe("0");
    expect(subtractDecimals("10.5", "0.25")).toBe("10.25");
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004.
    expect(subtractDecimals("0.3", "0.1")).toBe("0.2");
    expect(subtractDecimals("9007199254740993.000001", "0.000001")).toBe("9007199254740993");
  });

  it("anything that is not a decimal string is null, never zero", () => {
    expect(subtractDecimals("", "0")).toBeNull();
    expect(subtractDecimals("1e9", "0")).toBeNull();
    expect(subtractDecimals("0x10", "0")).toBeNull();
  });
});
