// Creating a trading wallet and linking it in one press: every state the chain can stop the press in,
// with its words, and the one thing it must never do — create a vault, or lose the wallet it just made.

import { SIP_PROGRAM_ID } from "@sip/solana-core/client";
import { describe, expect, it, vi } from "vitest";

import { PENSION_KEY, POLICY, SIGNER, TRADING_0 } from "../../test/fixtures/privy-user";
import { READY_BACKOFF_MS, createAndLinkFlow, linkGate, pressPlan, stopStillHolds, type CreateAndLinkDeps, type CreateAndLinkStop } from "@/lib/create-and-link";
import { SIGNER_VARIABLE, POLICY_VARIABLE } from "@/lib/trading-wallets";
import type { VaultStateJson } from "@/lib/vault-api";
import { CREATE_LINK_COPY, LINK_COPY, VAULT_COPY } from "@/lib/vault-copy";
import type { LinkWalletResult } from "@/lib/vault-flows";

const SEAT = { privySignerId: SIGNER, privyPolicyId: POLICY };
const VAULT = "Vau1tP1aceho1der111111111111111111111111111";

type Chain = { vault?: "exists" | "missing" | "unreadable"; config?: "exists" | "missing" | "unreadable"; paused?: boolean };

function stateOf(chain: Chain = {}): VaultStateJson {
  const config = chain.config ?? "exists";
  return {
    owner: PENSION_KEY,
    programId: SIP_PROGRAM_ID,
    vault: { status: chain.vault ?? "exists", address: VAULT },
    policy: { status: "missing", address: VAULT },
    config: { address: VAULT, status: config, exists: config === "exists", paused: config === "exists" ? chain.paused === true : null },
    walletLinks: [],
    holdings: { status: "exists", items: [] },
    vaultTokenAccounts: { status: "exists", items: [] },
    rents: { vault: "1285240", link: "1305560", policy: "5577840", tokenAccount: "1488440", legTokenAccounts: {} },
    prices: null,
  };
}

const LANDED: LinkWalletResult = { ok: true, signature: "sig", explorerUrl: null, slot: null, unitsConsumed: null, consentSignature: null };
const DECLINED: LinkWalletResult = { ok: false, kind: "refused", message: "Phantom did not approve. Nothing was sent.", consentSignature: null };

interface Harness {
  readonly deps: CreateAndLinkDeps;
  readonly createWallet: ReturnType<typeof vi.fn>;
  readonly refreshUser: ReturnType<typeof vi.fn>;
  readonly link: ReturnType<typeof vi.fn>;
  readonly steps: string[];
  readonly createdSeen: string[];
  readonly waits: number[];
}

function harness(
  over: {
    createWallet?: ReturnType<typeof vi.fn>;
    config?: { privySignerId: string | null; privyPolicyId: string | null };
    chain?: () => VaultStateJson | "loading" | null;
    signable?: () => readonly string[];
    link?: ReturnType<typeof vi.fn>;
  } = {},
): Harness {
  const createWallet = over.createWallet ?? vi.fn().mockResolvedValue({ wallet: { address: TRADING_0 } });
  const refreshUser = vi.fn().mockResolvedValue(null);
  const link = over.link ?? vi.fn<(address: string) => Promise<LinkWalletResult>>().mockResolvedValue(LANDED);
  const steps: string[] = [];
  const createdSeen: string[] = [];
  const waits: number[] = [];
  const deps: CreateAndLinkDeps = {
    createWallet: createWallet as unknown as CreateAndLinkDeps["createWallet"],
    config: over.config ?? SEAT,
    refreshUser,
    chain: over.chain ?? (() => stateOf()),
    signable: over.signable ?? (() => [PENSION_KEY, TRADING_0]),
    link: link as unknown as CreateAndLinkDeps["link"],
    onStep: (step) => steps.push(step),
    onCreated: (address) => createdSeen.push(address),
    wait: async (ms) => {
      waits.push(ms);
    },
  };
  return { deps, createWallet, refreshUser, link, steps, createdSeen, waits };
}

describe("linkGate: what the chain says about linking, in one place", () => {
  it("lets a link through only with a vault, a configured program and no pause", () => {
    expect(linkGate(stateOf())).toBeNull();
  });

  it.each<[Chain, string, string]>([
    [{ vault: "missing" }, "needs_vault", LINK_COPY.needsVault],
    [{ vault: "unreadable" }, "vault_unreadable", VAULT_COPY.unreadable],
    [{ config: "missing" }, "needs_config", LINK_COPY.needsConfig],
    [{ config: "unreadable" }, "config_unreadable", LINK_COPY.unreadable],
    [{ paused: true }, "paused", LINK_COPY.paused],
  ])("refuses %o as %s, with its words", (chain, code, message) => {
    expect(linkGate(stateOf(chain))).toStrictEqual({ code, message });
  });

  it("answers the vault before the program: no vault is the owner's next step whatever else is wrong", () => {
    expect(linkGate(stateOf({ vault: "missing", config: "missing", paused: true }))?.code).toBe("needs_vault");
  });
});

describe("pressPlan: what the press promises, from the screen's view of the chain", () => {
  it("a chain that can take a link promises the link, with the rent the chain reports", () => {
    expect(pressPlan({ kind: "ready", state: stateOf() })).toStrictEqual({ links: true, linkRent: 1_305_560n });
  });

  it("a read still in flight keeps the whole promise, and invents no rent: the flow reads the chain after the create", () => {
    expect(pressPlan({ kind: "loading" })).toStrictEqual({ links: true, linkRent: null });
    expect(pressPlan(null)).toStrictEqual({ links: true, linkRent: null });
  });

  it("A READ THAT FAILED promises the create alone, in the read's own words: no link, no Phantom, no rent", () => {
    // The screen knew before the press: the flow would mint a wallet and stop at chain_unknown.
    expect(pressPlan({ kind: "unreadable", message: VAULT_COPY.unreadable })).toStrictEqual({ links: false, reason: VAULT_COPY.unreadable });
  });

  it.each<[Chain, string]>([
    [{ vault: "missing" }, LINK_COPY.needsVault],
    [{ config: "missing" }, LINK_COPY.needsConfig],
    [{ paused: true }, LINK_COPY.paused],
  ])("a chain that refuses the link (%o) promises the create alone, with the gate's words", (chain, reason) => {
    expect(pressPlan({ kind: "ready", state: stateOf(chain) })).toStrictEqual({ links: false, reason });
  });

  it("a chain with no rents read promises the link and names no amount", () => {
    const state = { ...stateOf(), rents: null };
    expect(pressPlan({ kind: "ready", state })).toStrictEqual({ links: true, linkRent: null });
  });
});

describe("stopStillHolds: a stop that described the chain is dropped once the chain moves", () => {
  const needsVault: CreateAndLinkStop = { kind: "gate", message: LINK_COPY.needsVault, gate: "needs_vault" };

  it("THE VAULT THE STOP ASKED FOR NOW EXISTS: the note that asked for it no longer holds", () => {
    // The designed path for every first-time owner: press, get "Create your vault first", create it.
    // The note used to stay on screen, a role=alert asserting there is no vault under a button offering the link.
    expect(stopStillHolds(needsVault, stateOf({ vault: "missing" }))).toBe(true);
    expect(stopStillHolds(needsVault, stateOf())).toBe(false);
  });

  it("another gate is another statement: the chain refusing for a different reason does not keep this one", () => {
    expect(stopStillHolds(needsVault, stateOf({ config: "missing" }))).toBe(false);
    expect(stopStillHolds({ kind: "gate", message: LINK_COPY.paused, gate: "paused" }, stateOf({ paused: true }))).toBe(true);
  });

  it("a chain that has not been read proves nothing, so nothing is taken back on its word", () => {
    expect(stopStillHolds(needsVault, null)).toBe(true);
  });

  it("a stop that records what happened during the press stays true however the chain moves", () => {
    for (const stop of [
      { kind: "chain_unknown", message: CREATE_LINK_COPY.chainUnknown, gate: null },
      { kind: "not_ready", message: CREATE_LINK_COPY.notReady, gate: null },
      { kind: "no_address", message: CREATE_LINK_COPY.noAddress, gate: null },
    ] satisfies CreateAndLinkStop[]) {
      expect(stopStillHolds(stop, stateOf()), stop.kind).toBe(true);
    }
    expect(stopStillHolds(null, stateOf())).toBe(true);
  });
});

describe("createAndLinkFlow: nothing is created", () => {
  it("refuses before Privy when the keeper's seat is not configured, naming the variables", async () => {
    const h = harness({ config: { privySignerId: null, privyPolicyId: null } });
    const outcome = await createAndLinkFlow(h.deps);
    expect(outcome.created).toBeNull();
    expect(outcome.link).toBeNull();
    expect(outcome.stop?.kind).toBe("seat");
    expect(outcome.stop?.message).toContain(SIGNER_VARIABLE);
    expect(outcome.stop?.message).toContain(POLICY_VARIABLE);
    expect(h.createWallet).not.toHaveBeenCalled();
    expect(h.link).not.toHaveBeenCalled();
    expect(h.steps).toEqual([]);
  });

  it("a closed Privy dialog says nothing at all, and links nothing", async () => {
    const h = harness({ createWallet: vi.fn().mockRejectedValue(new Error("User exited the create wallet flow")) });
    const outcome = await createAndLinkFlow(h.deps);
    expect(outcome.stop).toStrictEqual({ kind: "create", message: null, gate: null });
    expect(outcome.created).toBeNull();
    expect(h.link).not.toHaveBeenCalled();
    // A wallet can exist even after a throw, so the record is read again anyway.
    expect(h.refreshUser).toHaveBeenCalledTimes(1);
  });

  it("a Privy refusal with a reason shows the reason, and links nothing", async () => {
    const h = harness({ createWallet: vi.fn().mockRejectedValue(new Error("Embedded wallet proxy did not respond in time")) });
    const outcome = await createAndLinkFlow(h.deps);
    expect(outcome.stop?.kind).toBe("create");
    expect(outcome.stop?.message).not.toBeNull();
    expect(h.link).not.toHaveBeenCalled();
  });
});

describe("createAndLinkFlow: the wallet exists and the chain stops", () => {
  it("Privy named no address: nothing is linked, and the words send the owner to the list", async () => {
    const h = harness({ createWallet: vi.fn().mockResolvedValue({ wallet: {} }) });
    const outcome = await createAndLinkFlow(h.deps);
    expect(outcome.stop).toStrictEqual({ kind: "no_address", message: CREATE_LINK_COPY.noAddress, gate: null });
    expect(h.link).not.toHaveBeenCalled();
    expect(h.createdSeen).toEqual([]);
  });

  it("NO VAULT: the wallet is created and kept, the vault is never created for the owner, nothing is signed", async () => {
    const h = harness({ chain: () => stateOf({ vault: "missing" }) });
    const outcome = await createAndLinkFlow(h.deps);
    expect(outcome.created).toBe(TRADING_0);
    expect(outcome.stop).toStrictEqual({ kind: "gate", message: LINK_COPY.needsVault, gate: "needs_vault" });
    expect(h.link).not.toHaveBeenCalled();
    // The address is announced before the stop: the list shows the wallet whatever happens next.
    expect(h.createdSeen).toEqual([TRADING_0]);
    expect(h.createWallet).toHaveBeenCalledTimes(1);
  });

  it.each<[Chain, string]>([
    [{ vault: "unreadable" }, "vault_unreadable"],
    [{ config: "missing" }, "needs_config"],
    [{ config: "unreadable" }, "config_unreadable"],
    [{ paused: true }, "paused"],
  ])("keeps the wallet and signs nothing when the chain says %o", async (chain, code) => {
    const h = harness({ chain: () => stateOf(chain) });
    const outcome = await createAndLinkFlow(h.deps);
    expect(outcome.created).toBe(TRADING_0);
    expect(outcome.stop?.gate).toBe(code);
    expect(h.link).not.toHaveBeenCalled();
  });

  it("a chain that is still loading, or was never read, is never linked from", async () => {
    for (const chain of [() => "loading" as const, () => null]) {
      const h = harness({ chain });
      const outcome = await createAndLinkFlow(h.deps);
      expect(outcome.created).toBe(TRADING_0);
      expect(outcome.stop).toStrictEqual({ kind: "chain_unknown", message: CREATE_LINK_COPY.chainUnknown, gate: null });
      expect(h.link).not.toHaveBeenCalled();
    }
  });

  it("the session never gets the wallet to sign with: bounded waiting, then the wallet is left to its row", async () => {
    const h = harness({ signable: () => [PENSION_KEY] });
    const outcome = await createAndLinkFlow(h.deps);
    expect(outcome.created).toBe(TRADING_0);
    expect(outcome.stop).toStrictEqual({ kind: "not_ready", message: CREATE_LINK_COPY.notReady, gate: null });
    expect(h.waits).toEqual([...READY_BACKOFF_MS]);
    expect(h.link).not.toHaveBeenCalled();
  });

  it("Privy lists the new wallet a moment late: the press waits, then links it", async () => {
    let reads = 0;
    const h = harness({
      signable: () => {
        reads += 1;
        return reads > 2 ? [PENSION_KEY, TRADING_0] : [PENSION_KEY];
      },
    });
    const outcome = await createAndLinkFlow(h.deps);
    expect(outcome.stop).toBeNull();
    expect(outcome.link).toStrictEqual(LANDED);
    expect(h.waits).toEqual([READY_BACKOFF_MS[0], READY_BACKOFF_MS[1]]);
  });
});

describe("createAndLinkFlow: the link runs", () => {
  it("the happy path: created, then linked, in one press, with the create step first", async () => {
    const h = harness();
    const outcome = await createAndLinkFlow(h.deps);
    expect(outcome).toStrictEqual({ created: TRADING_0, link: LANDED, stop: null });
    expect(h.link.mock.calls).toStrictEqual([[TRADING_0]]);
    expect(h.createWallet.mock.calls).toStrictEqual([[{ createAdditional: true, signers: [{ signerId: SIGNER, policyIds: [POLICY] }] }]]);
    expect(h.steps).toEqual(["creating_wallet"]);
    expect(h.createdSeen).toEqual([TRADING_0]);
  });

  it("the link's own refusal is carried as it is: the wallet was created, and the press does not retry it", async () => {
    const h = harness({ link: vi.fn<(address: string) => Promise<LinkWalletResult>>().mockResolvedValue(DECLINED) });
    const outcome = await createAndLinkFlow(h.deps);
    expect(outcome.created).toBe(TRADING_0);
    expect(outcome.stop).toBeNull();
    expect(outcome.link).toStrictEqual(DECLINED);
    expect(h.createWallet).toHaveBeenCalledTimes(1);
    expect(h.link).toHaveBeenCalledTimes(1);
  });

  it("the seat is never read and never waited for: a wallet is born seated, and linking does not need it", async () => {
    const h = harness();
    await createAndLinkFlow(h.deps);
    // The only record read is the one after the create; nothing polls Privy for a signer.
    expect(h.refreshUser).toHaveBeenCalledTimes(1);
    expect(h.waits).toEqual([]);
  });

  it.each<[string, LinkWalletResult]>([
    [
      "the relay says the wallet is already linked to another vault",
      { ok: false, kind: "refused", message: LINK_COPY.otherVault, code: "wallet_already_linked", consentSignature: null },
    ],
    ["the consent was refused", { ok: false, kind: "refused", message: LINK_COPY.consentNotSignature, consentSignature: null }],
    ["the build refused what was asked", { ok: false, kind: "refused", message: "SaverFi's server sent a transaction that is not what you asked for.", consentSignature: null }],
    ["Solana's approval window passed twice", { ok: false, kind: "expired", message: LINK_COPY.approvalPassedTwice, consentSignature: null }],
    [
      "it was sent and not confirmed",
      { ok: false, kind: "unconfirmed", message: "not confirmed", signature: "sig", explorerUrl: null, lastValidBlockHeight: 7, consentSignature: null },
    ],
  ])("carries the link's own answer untouched when %s, and never creates a second wallet", async (_name, answer) => {
    const h = harness({ link: vi.fn<(address: string) => Promise<LinkWalletResult>>().mockResolvedValue(answer) });
    const outcome = await createAndLinkFlow(h.deps);
    expect(outcome).toStrictEqual({ created: TRADING_0, link: answer, stop: null });
    expect(h.createWallet).toHaveBeenCalledTimes(1);
  });

  it("a second wallet on an account that already has one takes the same path", async () => {
    const h = harness({ signable: () => [PENSION_KEY, "Existing1111111111111111111111111111111111", TRADING_0] });
    const outcome = await createAndLinkFlow(h.deps);
    expect(outcome.stop).toBeNull();
    expect(h.link.mock.calls).toStrictEqual([[TRADING_0]]);
  });
});
