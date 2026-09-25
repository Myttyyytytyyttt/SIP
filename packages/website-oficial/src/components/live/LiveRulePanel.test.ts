// THE GEAR SIGNS, AND WHAT IT SIGNS IS PINNED HERE (owner, 09-25).
//
// The Savings rule card is read-only; its gear opens "Vault settings", and on a
// live page one Save there signs set_policy_v2 (mode, rate, pause) and/or
// set_invest_policy (assets, shares, threshold). Both write EVERY field of their
// account, so the one thing that must never happen is a field the dialog does
// not show going out as a guess. The arithmetic is rule-settings-plan.test.ts's;
// these tests drive the HOST — the form it hands the dialog, and what each Save
// actually asks the wallet for — through the same writers the page uses.

import { ANTHROPIC_MINT, JUPITER_V6, PROFIT_BPS_MAX, PROFIT_BPS_MIN, SPYX_MINT, VOLUME_BPS_MAX, VOLUME_BPS_MIN } from "@sip/solana-core/client";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuleSettingsFormProps } from "@/components/rule-settings-dialog";
import type { RuleSettingsDoor } from "@/components/savings-rule-panel";
import type { InvestRequest, VaultRuleRequest } from "@/hooks/use-vault-actions";
import type { SettingsDraft } from "@/lib/rule-settings";
import { LIVE_COPY } from "@/lib/live-copy";
import { SETTINGS_COPY } from "@/lib/settings-copy";
import type { InvestmentPolicyJson, VaultAccountJson, VaultStateJson } from "@/lib/vault-api";
import type { SavingsRule, SavingsStats } from "@/mocks/types";

import { liveSnapshot, policyState } from "../../../test/fixtures/live-dashboard";

const calls = vi.hoisted(() => ({
  rule: [] as unknown[],
  policy: [] as unknown[],
  choices: [] as unknown[],
  form: null as unknown,
  status: null as unknown,
  door: null as unknown,
  card: null as unknown,
  state: null as unknown,
  running: false,
}));

vi.mock("@/hooks/use-vault-state", () => ({
  useVaultScreen: () => (calls.state === null ? null : { pensionKey: "owner", view: { kind: "ready", state: calls.state }, refresh: () => undefined, api: {} }),
}));

vi.mock("@/hooks/use-onboarding-closed", () => ({ useBasketChoice: () => null }));
vi.mock("@/lib/onboarding-memory", async (original) => ({
  ...(await original<typeof import("@/lib/onboarding-memory")>()),
  saveBasketChoice: (_key: string, choice: unknown) => calls.choices.push(choice),
}));

vi.mock("@/hooks/use-vault-actions", () => {
  const writer = (sink: unknown[]) => ({
    progress: { phase: "idle" },
    running: calls.running,
    busyElsewhere: false,
    unconfirmed: false,
    setPolicy: (input: unknown) => {
      sink.push(input);
      return Promise.resolve();
    },
    investPolicy: (input: unknown) => {
      sink.push(input);
      return Promise.resolve();
    },
    buildAgain: () => Promise.resolve(),
    checkAgain: () => Promise.resolve(),
    dismiss: () => undefined,
  });
  return { useVaultWrite: (key: string) => (key === "vault" ? writer(calls.rule) : writer(calls.policy)) };
});

// The card and the dialog have their own tests; here only what the host hands them matters.
vi.mock("@/components/savings-rule-panel", () => ({
  SavingsRulePanel: (props: { settings: RuleSettingsDoor; rule: SavingsRule }) => {
    calls.door = props.settings;
    calls.card = props.rule;
    return null;
  },
}));
vi.mock("@/components/rule-settings-dialog", () => ({
  RuleSettingsDialog: ({ children }: { children: ReactNode }) => children,
  RuleSettingsStatus: ({ children }: { children: ReactNode }) => {
    calls.status = children;
    return null;
  },
  RuleSettingsForm: (props: unknown) => {
    calls.form = props;
    return null;
  },
}));

import { LiveRulePanel, RATE_RANGES, minimumFor } from "@/components/live/LiveRulePanel";

/** The vault account as the chain stores it: profit at 20 %, limits 0.06 / 0.05 SOL. */
const ACCOUNT = liveSnapshot().vault.state! as unknown as VaultAccountJson;

const leg = (mint: string, weightBps: number) => ({ mint, weightBps, minOutRateWad: "1" });

/** SPYx and ANTHROPIC at 50/50, $5 a leg — $10 in all — on Jupiter. */
const POLICY = policyState({
  venueProgram: JUPITER_V6,
  legs: [leg(SPYX_MINT, 5_000), leg(ANTHROPIC_MINT, 5_000)],
  minInvestment: "5000000",
  maxPerCall: "149000000",
  maxRolling30d: "4619000000",
});

function vaultState(policy: InvestmentPolicyJson | null, status: "exists" | "missing" | "unreadable" = policy === null ? "missing" : "exists"): VaultStateJson {
  return {
    owner: "owner",
    programId: "program",
    vault: { status: "exists", address: "vault", state: ACCOUNT },
    policy: { status, address: "policy", ...(policy === null ? {} : { state: policy }) },
    config: { address: "config", status: "exists", exists: true, paused: false },
    walletLinks: [],
    holdings: { status: "exists", items: [] },
    vaultTokenAccounts: { status: "exists", items: [] },
    rents: null,
    prices: null,
  } as unknown as VaultStateJson;
}

const RULE: SavingsRule = { mode: "profit", rateBps: 2_000, thresholdUsd: 10, targets: [], paused: false };
const STATS = {} as SavingsStats;

/** Mounts the host and returns the form it built (null when it shows a status instead). */
function mount(state: VaultStateJson | null): RuleSettingsFormProps | null {
  calls.state = state;
  calls.form = null;
  calls.status = null;
  calls.door = null;
  renderToStaticMarkup(createElement(LiveRulePanel, { rule: RULE, stats: STATS, activity: [], now: "2026-09-16T12:00:00.000Z", onRefresh: () => undefined }));
  return calls.form as RuleSettingsFormProps | null;
}

const edit = (form: RuleSettingsFormProps, change: Partial<SettingsDraft>): SettingsDraft => ({ ...form.initial, ...change });

/** The refresh block as the form would draw it, with or without unsaved basket edits. */
const refreshOf = (form: RuleSettingsFormProps, buyingChanged: boolean): ReactNode =>
  typeof form.refresh === "function" ? form.refresh({ buyingChanged }) : form.refresh;

/** The first element in a tree with an onClick whose text includes `label`. */
function button(node: ReactNode, label: string): ReactElement<{ onClick: () => void; disabled?: boolean }> | null {
  if (!isValidElement(node)) return Array.isArray(node) ? (node.map((child) => button(child, label)).find(Boolean) ?? null) : null;
  const props = node.props as { onClick?: () => void; children?: ReactNode };
  if (typeof props.onClick === "function" && renderToStaticMarkup(node as ReactElement).includes(label)) return node as ReactElement<{ onClick: () => void }>;
  return button(props.children, label);
}

beforeEach(() => {
  calls.rule.length = 0;
  calls.policy.length = 0;
  calls.choices.length = 0;
  calls.running = false;
});

describe("the ranges are the program's", () => {
  it("offers exactly the rates each mode accepts", () => {
    expect(RATE_RANGES.profit.min).toBe(PROFIT_BPS_MIN);
    expect(RATE_RANGES.profit.max).toBe(PROFIT_BPS_MAX);
    expect(RATE_RANGES.volume.min).toBe(VOLUME_BPS_MIN);
    expect(RATE_RANGES.volume.max).toBe(VOLUME_BPS_MAX);
  });

  it("is still the chain's inverse for the threshold: minimum × 10 000 ÷ the lightest leg", () => {
    expect(minimumFor(10_000_000n, [5_000, 5_000])).toBe(5_000_000n);
  });
});

describe("the form the gear opens", () => {
  it("opens on the vault's stored rule and basket, live, with Volume not offered", () => {
    const form = mount(vaultState(POLICY))!;
    expect(form.live).toBe(true);
    expect(form.initial.mode).toBe("profit");
    expect(form.initial.rateBps).toBe(ACCOUNT.skimBps);
    expect(form.initial.picked.map((pick) => pick.id).sort()).toEqual([ANTHROPIC_MINT, SPYX_MINT].sort());
    expect(form.initial.threshold).toMatch(/^10(\.0+)?$/);
    expect(form.volume).toEqual({ selectable: false, note: SETTINGS_COPY.volumeComing });
    expect(form.weightsEditable).toBe(true);
  });

  it("shows the vault being read, never a form over a guess", () => {
    expect(mount(null)).toBeNull();
    expect(renderToStaticMarkup(createElement("div", null, calls.status as ReactNode))).toContain(SETTINGS_COPY.loading);
  });

  it("without a policy: an even split and the $10 base, applied when buying starts", () => {
    const form = mount(vaultState(null))!;
    expect(form.weightsEditable).toBe(false);
    expect(form.thresholdNote).toBe(SETTINGS_COPY.appliesWhenBuyingStarts);
    expect(form.initial.threshold).toBe("10");
  });

  it("locks the buying half, with the reason, when the policy cannot be read", () => {
    expect(mount(vaultState(null, "unreadable"))!.buyingLocked).not.toBeNull();
  });

  it("freezes everything while a signature is under way", () => {
    calls.running = true;
    expect(mount(vaultState(POLICY))!.frozen).toBe(true);
  });
});

describe("one Save", () => {
  it("a new rate signs the vault's rule — every other field exactly as the chain holds it", () => {
    const form = mount(vaultState(POLICY))!;
    form.onSave(edit(form, { rateBps: 3_000 }));
    const [sent] = calls.rule as VaultRuleRequest[];
    expect(sent).toEqual({
      mode: ACCOUNT.skimMode,
      skimBps: 3_000,
      volumeBps: ACCOUNT.volumeBps,
      paused: ACCOUNT.paused,
      maxContribution: BigInt(ACCOUNT.maxContribution),
      walletReserve: BigInt(ACCOUNT.walletReserve),
    });
    expect(calls.policy).toEqual([]);
  });

  it("a new threshold signs the investing policy, stored caps and pause travelling with it", () => {
    const paused = policyState({ ...POLICY, enabled: false });
    const form = mount(vaultState(paused))!;
    form.onSave(edit(form, { threshold: "12" }));
    const [sent] = calls.policy as InvestRequest[];
    expect(sent!.enabled).toBe(false);
    expect(sent!.maxPerCall).toBe(149_000_000n);
    // 50/50: the basket buys at $12 when each leg's minimum is $6.
    expect(sent!.minInvestment).toBe(6_000_000n);
    expect(calls.rule).toEqual([]);
  });

  it("both at once: the rule first, the policy only once the rule has landed", () => {
    const form = mount(vaultState(POLICY))!;
    form.onSave(edit(form, { rateBps: 3_000, threshold: "12" }));
    expect(calls.rule).toHaveLength(1);
    expect(calls.policy).toEqual([]);
  });

  it("nothing is signed while the form is frozen, whatever it hands back", () => {
    calls.running = true;
    const form = mount(vaultState(POLICY))!;
    form.onSave(edit(form, { rateBps: 3_000 }));
    expect(calls.rule).toEqual([]);
  });

  it("without a policy, a new basket is kept on this device and nothing is signed", () => {
    const form = mount(vaultState(null))!;
    form.onSave(edit(form, { picked: [{ id: SPYX_MINT, percent: "100" }] }));
    expect(calls.choices).toEqual([{ kind: "stocks", mints: [SPYX_MINT] }]);
    expect(calls.policy).toEqual([]);
    expect(calls.rule).toEqual([]);
  });
});

describe("refresh price limits", () => {
  it("re-signs the stored basket as it stands, at today's prices", () => {
    const form = mount(vaultState(POLICY))!;
    const press = button(refreshOf(form, false), SETTINGS_COPY.refresh);
    expect(press).not.toBeNull();
    press!.props.onClick();
    const [sent] = calls.policy as InvestRequest[];
    expect(sent!.maxPerCall).toBe(149_000_000n);
    expect(sent!.minInvestment).toBe(5_000_000n);
    expect(sent!.enabled).toBe(POLICY.enabled);
    expect([...(sent!.weights ?? new Map())].sort()).toEqual([
      [ANTHROPIC_MINT, 5_000],
      [SPYX_MINT, 5_000],
    ].sort());
  });

  it("is not offered without a signed basket", () => {
    expect(mount(vaultState(null))!.refresh).toBeNull();
  });

  it("is held while the basket has unsaved edits: it would re-sign the stored one under them", () => {
    const form = mount(vaultState(POLICY))!;
    expect(button(refreshOf(form, true), SETTINGS_COPY.refresh)).toBeNull();
    expect(renderToStaticMarkup(createElement("div", null, refreshOf(form, true)))).toContain(SETTINGS_COPY.refreshBlocked);
  });
});

describe("the basket the card shows", () => {
  it("says a policy nobody could read could not be read — never 'nothing picked'", () => {
    mount(vaultState(null, "unreadable"));
    expect((calls.card as SavingsRule).targetsNote).toBe(LIVE_COPY.policyUnreadable);
  });

  it("is the chain's own when a policy is signed", () => {
    mount(vaultState(POLICY));
    expect((calls.card as SavingsRule).targetsNote).toBeUndefined();
  });
});

describe("the gear on the card", () => {
  it("is handed to the card closed, with no dot over a basket whose limits are current", () => {
    mount(vaultState(POLICY));
    expect(calls.door).toMatchObject({ open: false, attention: false });
  });
});
