// Importing a wallet the person already uses, seated, then linking it: every stop, the one key read, and the
// rules carried over from the earlier build — never an empty policy list, stop when the seat is not there, keep
// the address and never the key, and say a wallet is there whenever Privy may have it.

import { SIP_PROGRAM_ID, base58Encode } from "@sip/solana-core/client";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { PENSION_KEY, POLICY, SIGNER, TRADING_0, phantom, teeWallet, userWith } from "../../test/fixtures/privy-user";
import { SEAT_BACKOFF_MS, importAndLinkFlow, stopStillHolds, type ImportAndLinkDeps } from "@/lib/create-and-link";
import { SeatNotConfigured, importTradingWallet, type ImportWalletFn } from "@/lib/trading-wallets";
import type { VaultStateJson } from "@/lib/vault-api";
import { IMPORT_LINK_COPY, LINK_COPY, shortAddress } from "@/lib/vault-copy";
import type { LinkWalletResult } from "@/lib/vault-flows";

const SEAT = { privySignerId: SIGNER, privyPolicyId: POLICY };
const VAULT = "Vau1tP1aceho1der111111111111111111111111111";
const WALLET = "ImportedP1aceho1der1111111111111111111111";
// A real-shaped key, generated on the spot: a redaction test against a placeholder would prove nothing.
const KEY = base58Encode(Keypair.generate().secretKey);

function stateOf(vault: "exists" | "missing" = "exists"): VaultStateJson {
  return {
    owner: PENSION_KEY,
    programId: SIP_PROGRAM_ID,
    vault: { status: vault, address: VAULT },
    policy: { status: "missing", address: VAULT },
    config: { address: VAULT, status: "exists", exists: true, paused: false },
    walletLinks: [],
    holdings: { status: "exists", items: [] },
    vaultTokenAccounts: { status: "exists", items: [] },
    rents: { vault: "1285240", link: "1305560", policy: "5577840", tokenAccount: "1488440", legTokenAccounts: {} },
    prices: null,
  };
}

const SEATED = userWith([phantom(), teeWallet(TRADING_0, 0, true), teeWallet(WALLET, null, true, { imported: true })]);
const UNSEATED = userWith([phantom(), teeWallet(WALLET, null, false, { imported: true })]);
const WITHOUT = userWith([phantom(), teeWallet(TRADING_0, 0, true)]);

const LANDED: LinkWalletResult = { ok: true, signature: "sig", explorerUrl: null, slot: null, unitsConsumed: null, consentSignature: null };

function harness(
  over: {
    importWallet?: ReturnType<typeof vi.fn>;
    config?: { privySignerId: string | null; privyPolicyId: string | null };
    records?: ReadonlyArray<ReturnType<typeof userWith> | null>;
    takeKey?: () => Promise<string | null>;
    needsLink?: boolean;
    chain?: () => VaultStateJson | "loading" | null;
    signable?: () => readonly string[];
  } = {},
) {
  const importWallet = over.importWallet ?? vi.fn().mockResolvedValue({ address: WALLET });
  const records = [...(over.records ?? [SEATED])];
  const refreshUser = vi.fn(async () => (records.length > 1 ? records.shift()! : records[0]!) ?? null);
  const link = vi.fn<(address: string) => Promise<LinkWalletResult>>().mockResolvedValue(LANDED);
  const takeKey = vi.fn(over.takeKey ?? (async () => KEY));
  const steps: string[] = [];
  const imported: string[] = [];
  const waits: number[] = [];
  const deps: ImportAndLinkDeps = {
    importWallet: importWallet as unknown as ImportWalletFn,
    config: over.config ?? SEAT,
    takeKey,
    expected: WALLET,
    needsLink: over.needsLink ?? true,
    refreshUser,
    chain: over.chain ?? (() => stateOf()),
    signable: over.signable ?? (() => [PENSION_KEY, WALLET]),
    link,
    onStep: (step) => steps.push(step),
    onImported: (address) => imported.push(address),
    wait: async (ms) => {
      waits.push(ms);
    },
  };
  return { deps, importWallet, refreshUser, link, takeKey, steps, imported, waits };
}

describe("importTradingWallet", () => {
  it("hands Privy the key with exactly the keeper's signer and its one policy", async () => {
    const importWallet = vi.fn().mockResolvedValue({ address: WALLET });
    expect(await importTradingWallet(importWallet, SEAT, KEY)).toBe(WALLET);
    expect(importWallet).toHaveBeenCalledExactlyOnceWith({ privateKey: KEY, additionalSigners: [{ signerId: SIGNER, policyIds: [POLICY] }] });
  });

  it.each([
    ["no policy", { privySignerId: SIGNER, privyPolicyId: null }],
    ["a blank policy", { privySignerId: SIGNER, privyPolicyId: "  " }],
    ["the signer's id as the policy", { privySignerId: SIGNER, privyPolicyId: SIGNER }],
    ["nothing", { privySignerId: null, privyPolicyId: null }],
  ])("refuses before Privy is called with %s: an empty policy list is full permission", async (_, config) => {
    const importWallet = vi.fn();
    await expect(importTradingWallet(importWallet, config, KEY)).rejects.toBeInstanceOf(SeatNotConfigured);
    expect(importWallet).not.toHaveBeenCalled();
  });
});

describe("importAndLinkFlow", () => {
  it("imports seated, reads the seat back, then links the address it checked", async () => {
    const h = harness();
    const outcome = await importAndLinkFlow(h.deps);
    expect(outcome).toEqual({ imported: WALLET, link: LANDED, stop: null, alreadyLinked: false });
    expect(h.importWallet).toHaveBeenCalledExactlyOnceWith({ privateKey: KEY, additionalSigners: [{ signerId: SIGNER, policyIds: [POLICY] }] });
    expect(h.link).toHaveBeenCalledExactlyOnceWith(WALLET);
    expect(h.steps).toEqual(["importing_wallet", "checking_permission"]);
    expect(h.imported).toEqual([WALLET]);
  });

  it("takes the key once, after the seat is known to be configurable, and hands it to nothing but Privy", async () => {
    const h = harness();
    await importAndLinkFlow(h.deps);
    expect(h.takeKey).toHaveBeenCalledTimes(1);
    const everythingElse = JSON.stringify([h.refreshUser.mock.calls, h.link.mock.calls, h.steps, h.imported]);
    expect(everythingElse).not.toContain(KEY);

    const refused = harness({ config: { privySignerId: SIGNER, privyPolicyId: null } });
    const outcome = await importAndLinkFlow(refused.deps);
    expect(outcome.stop?.kind).toBe("seat");
    expect(refused.takeKey).not.toHaveBeenCalled();
    expect(refused.importWallet).not.toHaveBeenCalled();
  });

  it("sends nothing when the field no longer holds a whole key", async () => {
    const h = harness({ takeKey: async () => null });
    expect(await importAndLinkFlow(h.deps)).toMatchObject({ imported: null, stop: { kind: "no_key", message: IMPORT_LINK_COPY.noKey } });
    expect(h.importWallet).not.toHaveBeenCalled();
  });

  it("says what Privy said when it refused, with anything key-shaped taken out", async () => {
    const h = harness({ importWallet: vi.fn().mockRejectedValue(new Error(`Invalid private key ${KEY}`)), records: [WITHOUT] });
    const outcome = await importAndLinkFlow(h.deps);
    expect(outcome.imported).toBeNull();
    expect(outcome.stop?.kind).toBe("import");
    expect(outcome.stop?.message).toContain("Invalid private key");
    expect(outcome.stop?.message).not.toContain(KEY.slice(0, 43));
    expect(h.link).not.toHaveBeenCalled();
  });

  it("says nothing when Privy's dialog was only closed", async () => {
    const h = harness({ importWallet: vi.fn().mockRejectedValue(new Error("User exited the flow")), records: [WITHOUT] });
    expect(await importAndLinkFlow(h.deps)).toMatchObject({ imported: null, stop: { kind: "import", message: null } });
  });

  it("carries on when Privy threw AFTER importing: its record lists the wallet, seated", async () => {
    const h = harness({ importWallet: vi.fn().mockRejectedValue(new Error("Failed to import wallet")) });
    expect(await importAndLinkFlow(h.deps)).toEqual({ imported: WALLET, link: LANDED, stop: null, alreadyLinked: false });
  });

  it("does not link a wallet at another address than the one every check ran on", async () => {
    const h = harness({ importWallet: vi.fn().mockResolvedValue({ address: TRADING_0 }) });
    const outcome = await importAndLinkFlow(h.deps);
    expect(outcome).toMatchObject({ imported: TRADING_0, link: null, stop: { kind: "wrong_address" } });
    expect(outcome.stop?.message).toBe(IMPORT_LINK_COPY.wrongAddress(shortAddress(TRADING_0), shortAddress(WALLET)));
    expect(h.link).not.toHaveBeenCalled();
    expect(h.imported).toEqual([TRADING_0]);
  });

  it("STOPS BEFORE THE LINK when Privy's record shows no signer: a linked wallet without its seat would save nothing", async () => {
    const h = harness({ records: [UNSEATED] });
    const outcome = await importAndLinkFlow(h.deps);
    expect(outcome).toMatchObject({ imported: WALLET, link: null, stop: { kind: "seat_missing", message: IMPORT_LINK_COPY.seatMissing } });
    expect(h.link).not.toHaveBeenCalled();
    expect(h.waits).toEqual(SEAT_BACKOFF_MS);
  });

  it("stops before the link when the record never lists the wallet", async () => {
    const h = harness({ importWallet: vi.fn().mockResolvedValue({ address: WALLET }), records: [WITHOUT] });
    expect(await importAndLinkFlow(h.deps)).toMatchObject({ imported: WALLET, stop: { kind: "seat_unknown", message: IMPORT_LINK_COPY.seatUnknown } });
    expect(h.link).not.toHaveBeenCalled();
  });

  it("waits out a record that lags behind the import, then links", async () => {
    const h = harness({ records: [WITHOUT, WITHOUT, SEATED] });
    expect(await importAndLinkFlow(h.deps)).toMatchObject({ imported: WALLET, link: LANDED, stop: null });
    expect(h.waits).toEqual(SEAT_BACKOFF_MS.slice(0, 2));
  });

  it("signs nothing for a wallet already linked to this vault", async () => {
    const h = harness({ needsLink: false });
    expect(await importAndLinkFlow(h.deps)).toEqual({ imported: WALLET, link: null, stop: null, alreadyLinked: true });
    expect(h.link).not.toHaveBeenCalled();
  });

  it("keeps the wallet and says why when the chain cannot take a link yet", async () => {
    const loading = await importAndLinkFlow(harness({ chain: () => "loading" }).deps);
    expect(loading).toMatchObject({ imported: WALLET, stop: { kind: "chain_unknown" } });
    const noVault = await importAndLinkFlow(harness({ chain: () => stateOf("missing") }).deps);
    expect(noVault).toMatchObject({ imported: WALLET, stop: { kind: "gate", gate: "needs_vault", message: LINK_COPY.needsVault } });
    expect(stopStillHolds(noVault.stop, stateOf("missing"))).toBe(true);
    expect(stopStillHolds(noVault.stop, stateOf())).toBe(false);
    const notReady = await importAndLinkFlow(harness({ signable: () => [PENSION_KEY] }).deps);
    expect(notReady).toMatchObject({ imported: WALLET, stop: { kind: "not_ready", message: IMPORT_LINK_COPY.notReady } });
  });
});
