// The new-user setup's decisions, branch by branch: when it is wanted, when it
// replaces the wallets modal, what its vault step may offer, and when a create
// has landed.

import { describe, expect, it } from "vitest";

import type { WriteProgress } from "@/hooks/use-vault-actions";
import type { VaultScreenValue, VaultView } from "@/hooks/use-vault-state";
import type { DashboardKind, VaultPresence } from "@/lib/dashboard-mode";
import type { LiveStage } from "@/lib/live-types";
import { landedCreate, onboardingOpen, onboardingWanted, setupIsTheDoor, vaultPresenceOf, vaultStepRead } from "@/lib/onboarding";
import type { VaultApi, VaultStateJson } from "@/lib/vault-api";

const KEY = "PensionKeyP1aceho1der111111111111111111111";
const OTHER = "OtherKeyP1aceho1der1111111111111111111111";

const stateOf = (status: "missing" | "exists" | "unreadable", owner = KEY): VaultStateJson => ({ owner, vault: { status, address: "vault" } }) as unknown as VaultStateJson;
const screenOf = (view: VaultView, pensionKey = KEY): VaultScreenValue => ({ pensionKey, view, refresh: () => undefined, api: {} as VaultApi });

describe("vaultPresenceOf", () => {
  it("says reading until THIS key's vault has answered", () => {
    expect(vaultPresenceOf(null, KEY)).toBe("reading");
    expect(vaultPresenceOf(screenOf({ kind: "ready", state: stateOf("missing") }), null)).toBe("reading");
    expect(vaultPresenceOf(screenOf({ kind: "ready", state: stateOf("missing") }, OTHER), KEY)).toBe("reading");
    expect(vaultPresenceOf(screenOf({ kind: "loading" }), KEY)).toBe("reading");
    // The view is not reset on a key change: an answer about another key is no answer.
    expect(vaultPresenceOf(screenOf({ kind: "ready", state: stateOf("missing", OTHER) }), KEY)).toBe("reading");
  });

  it("keeps a failed read apart from a missing vault", () => {
    expect(vaultPresenceOf(screenOf({ kind: "unreadable", message: "x" }), KEY)).toBe("unreadable");
    expect(vaultPresenceOf(screenOf({ kind: "ready", state: stateOf("unreadable") }), KEY)).toBe("unreadable");
    expect(vaultPresenceOf(screenOf({ kind: "ready", state: stateOf("missing") }), KEY)).toBe("missing");
    expect(vaultPresenceOf(screenOf({ kind: "ready", state: stateOf("exists") }), KEY)).toBe("exists");
  });
});

const KINDS: readonly DashboardKind[] = ["landing", "loading", "mock", "live-connect", "live-keyless", "live-unavailable", "live"];
const PRESENCES: readonly VaultPresence[] = ["reading", "missing", "exists", "unreadable"];
const STAGES: readonly (LiveStage | null)[] = [null, "vault_unreadable", "no_vault", "no_trading_wallet", "not_linked", "waiting_first_settlement", "active"];
const HAS_VAULT: readonly LiveStage[] = ["no_trading_wallet", "not_linked", "waiting_first_settlement", "active"];

describe("onboardingWanted", () => {
  it("is true for a Live page, not closed, whose vault read says missing and whose live read does not contradict it", () => {
    for (const liveStage of [null, "no_vault", "vault_unreadable"] as const) {
      expect(onboardingWanted({ kind: "live", closed: false, vault: "missing", liveStage, engaged: false })).toBe(true);
    }
  });

  it("is false on every page but Live, and whenever this tab closed it", () => {
    for (const kind of KINDS) {
      for (const vault of PRESENCES) {
        for (const liveStage of STAGES) {
          for (const engaged of [true, false]) {
            expect(onboardingWanted({ kind, closed: true, vault, liveStage, engaged })).toBe(false);
            if (kind !== "live") expect(onboardingWanted({ kind, closed: false, vault, liveStage, engaged })).toBe(false);
          }
        }
      }
    }
  });

  it("never opens over a vault either read has seen", () => {
    for (const vault of PRESENCES) {
      for (const liveStage of HAS_VAULT) {
        for (const engaged of [true, false]) expect(onboardingWanted({ kind: "live", closed: false, vault, liveStage, engaged })).toBe(false);
      }
    }
    for (const liveStage of STAGES) expect(onboardingWanted({ kind: "live", closed: false, vault: "exists", liveStage, engaged: true })).toBe(false);
  });

  it("stays up through a read that fails or is in flight only once it has been on screen", () => {
    for (const vault of ["reading", "unreadable"] as const) {
      expect(onboardingWanted({ kind: "live", closed: false, vault, liveStage: null, engaged: false })).toBe(false);
      expect(onboardingWanted({ kind: "live", closed: false, vault, liveStage: null, engaged: true })).toBe(true);
      expect(onboardingWanted({ kind: "live", closed: false, vault, liveStage: "no_vault", engaged: true })).toBe(true);
    }
  });
});

describe("setupIsTheDoor", () => {
  it("replaces the wallets modal only while this key has no vault", () => {
    expect(setupIsTheDoor("missing", null)).toBe(true);
    expect(setupIsTheDoor("missing", "no_vault")).toBe(true);
    expect(setupIsTheDoor("unreadable", "no_vault")).toBe(true);
    // In flight, with the live read already saying there is none: the setup, not a second form.
    expect(setupIsTheDoor("reading", "no_vault")).toBe(true);
    // A read that failed or is in flight with nothing else to go on keeps the wallets modal: the key may have a vault.
    expect(setupIsTheDoor("unreadable", null)).toBe(false);
    expect(setupIsTheDoor("unreadable", "vault_unreadable")).toBe(false);
    expect(setupIsTheDoor("reading", null)).toBe(false);
    expect(setupIsTheDoor("exists", "no_vault")).toBe(false);
    for (const vault of PRESENCES) for (const stage of HAS_VAULT) expect(setupIsTheDoor(vault, stage)).toBe(false);
  });
});

describe("onboardingOpen", () => {
  it("keeps the celebration up whatever the reads say, and never reopens a finished setup", () => {
    expect(onboardingOpen(false, "celebrating")).toBe(true);
    expect(onboardingOpen(true, "celebrating")).toBe(true);
    expect(onboardingOpen(true, "done")).toBe(false);
    expect(onboardingOpen(false, "done")).toBe(false);
    expect(onboardingOpen(true, null)).toBe(true);
    expect(onboardingOpen(false, null)).toBe(false);
  });
});

describe("landedCreate", () => {
  const landed: WriteProgress = { phase: "finished", kind: "create", result: { ok: true, signature: "s", explorerUrl: null, slot: 1, unitsConsumed: null } } as WriteProgress;
  it("is true only for a create that landed", () => {
    expect(landedCreate(landed)).toBe(true);
    expect(landedCreate({ phase: "idle" })).toBe(false);
    expect(landedCreate({ phase: "running", kind: "create", step: "approve_pension", built: null })).toBe(false);
    expect(landedCreate({ phase: "finished", kind: "create", result: { ok: false, kind: "refused", message: "no" } } as WriteProgress)).toBe(false);
    expect(landedCreate({ ...landed, kind: "rule" } as WriteProgress)).toBe(false);
  });
});

describe("vaultStepRead", () => {
  it("offers the form only on a read that says missing", () => {
    expect(vaultStepRead({ kind: "loading" }, KEY)).toBe("reading");
    expect(vaultStepRead({ kind: "unreadable", message: "x" }, KEY)).toBe("unreadable");
    expect(vaultStepRead({ kind: "ready", state: stateOf("unreadable") }, KEY)).toBe("unreadable");
    expect(vaultStepRead({ kind: "ready", state: stateOf("missing") }, KEY)).toBe("form");
    // A vault that exists never gets the form, even for the moment before the setup closes.
    expect(vaultStepRead({ kind: "ready", state: stateOf("exists") }, KEY)).toBe("reading");
    // Another key's "missing" is no answer about this key: never the form on it.
    expect(vaultStepRead({ kind: "ready", state: stateOf("missing", OTHER) }, KEY)).toBe("reading");
  });
});
