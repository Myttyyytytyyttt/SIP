// The new-user setup's screens, rendered to HTML with fixtures, and their
// buttons pressed: the pattern VaultCard.test.ts uses (the ui Button is wrapped
// to remember each button's label, disabled state and onClick).

import { DEFAULT_VAULT_POLICY, MODE_PROFIT } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  function textOf(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (typeof node === "object" && node !== null && "props" in node) return textOf((node as { props: { children?: unknown } }).props.children);
    return "";
  }
  return { textOf, buttons: [] as { label: string; disabled: boolean; primary: boolean; onClick: ((event: unknown) => void) | undefined }[] };
});

vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  return {
    ...actual,
    Button: (props: Parameters<typeof actual.Button>[0]) => {
      mocked.buttons.push({
        label: mocked.textOf(props.children).trim(),
        disabled: props.disabled === true,
        primary: "data-onboarding-primary" in (props as Record<string, unknown>),
        onClick: props.onClick as unknown as ((event: unknown) => void) | undefined,
      });
      return actual.Button(props);
    },
  };
});

import { OnboardingBody, onboardingHeading, type OnboardingBodyProps } from "@/components/onboarding/OnboardingBody";
import type { WriteProgress } from "@/hooks/use-vault-actions";
import { formatSol } from "@/lib/amounts";
import { LIVE_COPY, ONBOARDING_COPY } from "@/lib/live-copy";
import { LINK_COPY, PROFIT_RATE, VAULT_COPY, shortAddress } from "@/lib/vault-copy";
import { CREATE_VAULT_FEE_LAMPORTS } from "@/lib/vault-limits";

const KEY = "PensionKeyP1aceho1der111111111111111111111";
const CLICK = { type: "click", target: {} };

function props(overrides: Partial<OnboardingBodyProps> = {}): OnboardingBodyProps {
  return {
    step: "welcome",
    pensionKey: KEY,
    vaultRent: 1_285_240n,
    linkRent: 1_305_560n,
    fees: CREATE_VAULT_FEE_LAMPORTS,
    usdcPerSol: 100_038_711n,
    read: "form",
    maxText: "0.06",
    reserveText: "0.05",
    onMaxText: vi.fn(),
    onReserveText: vi.fn(),
    progress: { phase: "idle" },
    running: false,
    busyElsewhere: false,
    unconfirmed: false,
    onContinue: vi.fn(),
    onBack: vi.fn(),
    onCreate: vi.fn(),
    onRetryRead: vi.fn(),
    onBuildAgain: vi.fn(),
    onCheckAgain: vi.fn(),
    onDismissProgress: vi.fn(),
    onDone: vi.fn(),
    onDisconnect: vi.fn(),
    ...overrides,
  };
}

function render(value: OnboardingBodyProps): string {
  mocked.buttons.length = 0;
  return renderToStaticMarkup(createElement(OnboardingBody, value));
}

const buttons = (label: string) => mocked.buttons.filter((button) => button.label === label);
const button = (label: string) => {
  const found = buttons(label);
  expect(found).toHaveLength(1);
  return found[0]!;
};
/** The text a person reads: tags dropped, entities for the two characters React escapes put back. */
const textOf = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

beforeEach(() => {
  mocked.buttons.length = 0;
});

describe("every screen", () => {
  it("never says keeper, SIP or Nuvem, nor prints a missing value", () => {
    const states: Partial<OnboardingBodyProps>[] = [
      { step: "welcome" },
      { step: "welcome", vaultRent: null, linkRent: null, usdcPerSol: null },
      { step: "vault" },
      { step: "vault", vaultRent: null, usdcPerSol: null },
      { step: "vault", read: "reading" },
      { step: "vault", read: "unreadable" },
      { step: "ready", progress: { phase: "finished", kind: "create", result: { ok: true, signature: "sig", explorerUrl: "https://solscan.io/tx/sig", slot: 1, unitsConsumed: null } } as WriteProgress },
    ];
    for (const state of states) {
      const text = textOf(render(props(state)));
      expect(text).not.toMatch(/\bkeeper\b|\bSIP\b|nuvem|undefined|null|NaN/i);
    }
  });

  it("has a header for each step, the step counted in the first two", () => {
    const welcome = onboardingHeading("welcome");
    expect(welcome).toMatchObject({ eyebrow: "Step 1 of 2", title: "SaverFi", titleLead: "Welcome to", hero: true });
    expect(welcome.points).toHaveLength(4);
    expect(onboardingHeading("vault")).toEqual({ eyebrow: "Step 2 of 2", title: "Create your vault", description: VAULT_COPY.noVaultDescription });
    expect(onboardingHeading("ready").eyebrow).toBeNull();
  });
});

describe("welcome", () => {
  it("leads with the motion, in H.264 with its still frame, hidden from screen readers", () => {
    const html = render(props());
    expect(html).toMatch(/<video[^>]*src="\/motion\/onboarding-welcome.mp4"/);
    expect(html).toMatch(/<video[^>]*poster="\/motion\/onboarding-welcome.jpg"/);
    expect(html).toMatch(/<video[^>]*aria-hidden="true"/);
    // Read inside the <video> tag alone ("muted" is also in every text-muted-foreground class). React sets
    // `muted` as a property, never as markup, so the browser check (not this one) covers it.
    const tag = html.match(/<video[^>]*>/)?.[0] ?? "";
    for (const attribute of ["autoplay", "loop", "playsinline"]) expect(tag.toLowerCase()).toContain(attribute);
    // The motion comes before the four points and the costs.
    expect(html.indexOf("<video")).toBeLessThan(html.indexOf(ONBOARDING_COPY.welcome.tradeTitle));
  });

  it("asks nothing of the reader before Continue: no cost list, no fine print (owner, 09-24)", () => {
    const text = textOf(render(props()));
    expect(text).not.toMatch(/What it costs|rent|network fee|close this/i);
    expect(text).toContain(ONBOARDING_COPY.pensionKey(shortAddress(KEY)));
  });

  it("Continue is the primary button and moves on; Disconnect is there, and is not", () => {
    const value = props();
    render(value);
    const next = button(ONBOARDING_COPY.welcome.continue);
    expect(next.primary).toBe(true);
    next.onClick?.(CLICK);
    expect(value.onContinue).toHaveBeenCalledTimes(1);
    const out = button(LIVE_COPY.disconnect);
    expect(out.primary).toBe(false);
    out.onClick?.(CLICK);
    expect(value.onDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe("the vault step", () => {
  it("offers profit only, with no mode choice, and the limits folded at their defaults", () => {
    const html = render(props({ step: "vault" }));
    // textOf folds the rate's no-break space into a plain one, as a reader sees it.
    expect(textOf(html)).toContain(ONBOARDING_COPY.vault.modeTitle(PROFIT_RATE));
    expect(html).toContain(ONBOARDING_COPY.vault.modeTitle(PROFIT_RATE.replace(" ", "\u00a0")));
    expect(html).not.toContain('type="radio"');
    expect(html).toMatch(/<details(?![^>]*\sopen)[^>]*>/);
    expect(html).toMatch(/id="onboarding-max-contribution"[^>]*value="0.06"|value="0.06"[^>]*id="onboarding-max-contribution"/);
    expect(html).toMatch(/id="onboarding-wallet-reserve"[^>]*value="0.05"|value="0.05"[^>]*id="onboarding-wallet-reserve"/);
  });

  it("says the cost above the button, and Create sends exactly the limits shown, never the click", () => {
    const value = props({ step: "vault" });
    const html = render(value);
    expect(html.indexOf("Cost:")).toBeGreaterThan(-1);
    expect(html.indexOf("Cost:")).toBeLessThan(html.lastIndexOf(">Create vault<"));
    const create = button(VAULT_COPY.create);
    expect(create.primary).toBe(true);
    expect(create.disabled).toBe(false);
    create.onClick?.(CLICK);
    expect(value.onCreate).toHaveBeenCalledTimes(1);
    expect(value.onCreate).toHaveBeenCalledWith({ mode: MODE_PROFIT, maxContribution: DEFAULT_VAULT_POLICY.maxContribution, walletReserve: DEFAULT_VAULT_POLICY.walletReserve });
  });

  it("names an unread rent in the existing flow's own words", () => {
    expect(textOf(render(props({ step: "vault", vaultRent: null })))).toContain(VAULT_COPY.costUnknown);
  });

  it("refuses a zero limit out loud, outside the folded section, and disables Create", () => {
    const html = render(props({ step: "vault", maxText: "0" }));
    expect(textOf(html)).toContain(VAULT_COPY.zeroSettlement);
    expect(html.indexOf(VAULT_COPY.zeroSettlement)).toBeGreaterThan(html.indexOf("</details>"));
    expect(button(VAULT_COPY.create).disabled).toBe(true);
  });

  it("never offers Create on a read in flight or failed — the button is not there at all", () => {
    const reading = render(props({ step: "vault", read: "reading" }));
    expect(reading).toContain('aria-busy="true"');
    expect(buttons(VAULT_COPY.create)).toHaveLength(0);
    expect(textOf(reading)).not.toContain("Cost:");

    const value = props({ step: "vault", read: "unreadable" });
    const unreadable = render(value);
    expect(textOf(unreadable)).toContain(VAULT_COPY.unreadable);
    expect(buttons(VAULT_COPY.create)).toHaveLength(0);
    button(VAULT_COPY.retry).onClick?.(CLICK);
    expect(value.onRetryRead).toHaveBeenCalledTimes(1);
    expect(value.onRetryRead).toHaveBeenCalledWith();
  });

  it("while the wallet is asked: Creating…, Back and Disconnect disabled", () => {
    render(props({ step: "vault", running: true, progress: { phase: "running", kind: "create", step: "approve_pension", built: null } }));
    expect(button(VAULT_COPY.creating).disabled).toBe(true);
    expect(button(ONBOARDING_COPY.vault.back).disabled).toBe(true);
    expect(button(LIVE_COPY.disconnect).disabled).toBe(true);
  });

  it("while another signature runs on the page, says so and disables Create", () => {
    const html = render(props({ step: "vault", busyElsewhere: true }));
    expect(textOf(html)).toContain(LINK_COPY.busy);
    expect(button(VAULT_COPY.create).disabled).toBe(true);
  });

  it("a create sent and not confirmed offers Check again, never a second Create", () => {
    const value = props({
      step: "vault",
      unconfirmed: true,
      progress: { phase: "finished", kind: "create", result: { ok: false, kind: "unconfirmed", message: "Sent.", signature: "sig", explorerUrl: "https://solscan.io/tx/sig", lastValidBlockHeight: 0 } } as WriteProgress,
    });
    render(value);
    expect(button(VAULT_COPY.create).disabled).toBe(true);
    button("Check again").onClick?.(CLICK);
    expect(value.onCheckAgain).toHaveBeenCalledTimes(1);
  });
});

describe("ready", () => {
  it("shows the landed create on Solscan and hands over to the dashboard", () => {
    const value = props({ step: "ready", progress: { phase: "finished", kind: "create", result: { ok: true, signature: "sig", explorerUrl: "https://solscan.io/tx/sig", slot: 1, unitsConsumed: null } } as WriteProgress });
    const html = render(value);
    expect(textOf(html)).toContain(VAULT_COPY.created);
    expect(html).toContain('href="https://solscan.io/tx/sig"');
    for (const line of ONBOARDING_COPY.ready.next) expect(textOf(html)).toContain(line);
    expect(buttons(VAULT_COPY.dismiss)).toHaveLength(0);
    const done = button(ONBOARDING_COPY.ready.done);
    expect(done.primary).toBe(true);
    done.onClick?.(CLICK);
    expect(value.onDone).toHaveBeenCalledTimes(1);
  });
});
