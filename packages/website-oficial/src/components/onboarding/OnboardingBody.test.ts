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
import { SETUP_RATE, SETUP_STOCKS, basketSplit } from "@/lib/onboarding";
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
    read: "form",
    rateBps: 2_000,
    onRate: vi.fn(),
    basket: { kind: "sol" },
    onBasket: vi.fn(),
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
      { step: "welcome", vaultRent: null, linkRent: null },
      { step: "vault" },
      { step: "vault", vaultRent: null },
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
    expect(welcome).toMatchObject({ eyebrow: "Step 1 of 2", title: "SaverFi", titleLead: "Welcome to", hero: true, brand: true });
    expect(welcome.points).toHaveLength(4);
    const vault = onboardingHeading("vault");
    // Led by its motion like the welcome, but its title is not the brand's name: no mark in it.
    expect(vault).toMatchObject({ eyebrow: "Step 2 of 2", title: "Create your vault", description: VAULT_COPY.noVaultDescription, hero: true });
    expect(vault.brand).toBeUndefined();
    expect(vault.points).toHaveLength(4);
    expect(onboardingHeading("vault", 1_500).points?.[0]).toBe("Keeps 15\u00a0% of each gain");
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
  it("leads with its own motion in every read state: the form, a read in flight, a read that failed", () => {
    for (const read of ["form", "reading", "unreadable"] as const) {
      const html = render(props({ step: "vault", read }));
      expect(html).toMatch(/<video[^>]*src="\/motion\/onboarding-vault.mp4"/);
      expect(html).toMatch(/<video[^>]*poster="\/motion\/onboarding-vault.jpg"/);
      expect(html).not.toContain("onboarding-welcome");
    }
  });

  it("offers one choice — the share of each gain — as a bar and four presets, and no limits to fill in", () => {
    const html = render(props({ step: "vault" }));
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("<details");
    // No field to fill in (the slider's own hidden form input aside): the limits are the product's.
    expect(html).not.toMatch(/inputmode="decimal"|type="number"/i);
    expect(html).not.toContain("onboarding-max-contribution");
    expect(html).toContain('data-slot="slider"');
    // The thumb speaks the percent, not the basis points.
    expect(html).toMatch(/aria-valuetext="20\u00a0%"/);
    for (const preset of ["10", "15", "20", "30"]) expect(html).toMatch(new RegExp(`data-slot="toggle-group-item"[^>]*>${preset}\u00a0%<`));
    // 20 % is the product's start, so its preset is the one pressed.
    expect(html).toMatch(/aria-checked="true"[^>]*>20\u00a0%<|data-state="on"[^>]*>20\u00a0%</);
    // Under the bar, one line: the settlement cap, and no promise about losses carried forward.
    expect(textOf(html)).toContain(ONBOARDING_COPY.vault.ruleLine(formatSol(DEFAULT_VAULT_POLICY.maxContribution)));
    expect(textOf(html)).not.toMatch(/loss comes off/);
  });

  it("offers what the savings become: SOL pressed by default, the offered stocks, and USDC greyed as not available", () => {
    const html = render(props({ step: "vault" }));
    expect(textOf(html)).toContain(ONBOARDING_COPY.vault.basketTitle);
    const tile = (symbol: string): string => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*?>${symbol}</span>(?:(?!</button>).)*</button>`, "s"))?.[0] ?? "";
    expect(tile("SOL")).toContain('aria-pressed="true"');
    for (const stock of SETUP_STOCKS) expect(tile(stock.symbol)).toContain('aria-pressed="false"');
    expect(tile("USDC")).toMatch(/\sdisabled=""/);
    expect(tile("USDC")).toContain(ONBOARDING_COPY.vault.usdcSub);
    expect(textOf(html)).toContain(ONBOARDING_COPY.vault.basketSol);
    // The choice is not signed on this step: the one approval, said in the header, stays the vault's.
    expect(onboardingHeading("vault").points).toContain("One approval");
  });

  it("with stocks chosen, says the equal split and that buying is approved later", () => {
    const mints = SETUP_STOCKS.map((stock) => stock.mint);
    const html = render(props({ step: "vault", basket: { kind: "stocks", mints } }));
    const tile = (symbol: string): string => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*?>${symbol}</span>(?:(?!</button>).)*</button>`, "s"))?.[0] ?? "";
    expect(tile("SOL")).toContain('aria-pressed="false"');
    for (const stock of SETUP_STOCKS) expect(tile(stock.symbol)).toContain('aria-pressed="true"');
    const split = basketSplit({ kind: "stocks", mints }).map((leg) => `${leg.symbol} ${leg.percent} %`).join(" · ");
    expect(textOf(html)).toContain(ONBOARDING_COPY.vault.basketStocks(split));
  });

  it("says the cost above the button, and Create sends the share chosen with the product's limits, never the click", () => {
    const value = props({ step: "vault", rateBps: 1_500 });
    const html = render(value);
    expect(html.indexOf("Cost:")).toBeGreaterThan(-1);
    expect(html.indexOf("Cost:")).toBeLessThan(html.lastIndexOf(">Create vault<"));
    // The short form (owner, 09-24): the rent, then the fees.
    expect(textOf(html)).toContain(ONBOARDING_COPY.vault.cost(formatSol(1_285_240n), formatSol(CREATE_VAULT_FEE_LAMPORTS)));
    expect(textOf(html)).toContain("15 %");
    const create = button(VAULT_COPY.create);
    expect(create.primary).toBe(true);
    expect(create.disabled).toBe(false);
    create.onClick?.(CLICK);
    expect(value.onCreate).toHaveBeenCalledTimes(1);
    expect(value.onCreate).toHaveBeenCalledWith({
      mode: MODE_PROFIT,
      skimBps: 1_500,
      maxContribution: DEFAULT_VAULT_POLICY.maxContribution,
      walletReserve: DEFAULT_VAULT_POLICY.walletReserve,
    });
  });

  it("holds a share from outside the bar's range to the range before it can be signed", () => {
    const value = props({ step: "vault", rateBps: 90_000 });
    render(value);
    button(VAULT_COPY.create).onClick?.(CLICK);
    expect(value.onCreate).toHaveBeenCalledWith(expect.objectContaining({ skimBps: SETUP_RATE.max }));
  });

  it("names an unread rent in the existing flow's own words", () => {
    expect(textOf(render(props({ step: "vault", vaultRent: null })))).toContain(VAULT_COPY.costUnknown);
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
    // The last line follows the choice: SOL by default here.
    expect(textOf(html)).toContain(ONBOARDING_COPY.ready.nextSol);
    expect(buttons(VAULT_COPY.dismiss)).toHaveLength(0);
    const done = button(ONBOARDING_COPY.ready.done);
    expect(done.primary).toBe(true);
    done.onClick?.(CLICK);
    expect(value.onDone).toHaveBeenCalledTimes(1);
  });
});

describe("ready, after stocks were chosen", () => {
  it("names the approval still to come", () => {
    const mints = SETUP_STOCKS.map((stock) => stock.mint);
    const html = render(
      props({
        step: "ready",
        basket: { kind: "stocks", mints },
        progress: { phase: "finished", kind: "create", result: { ok: true, signature: "sig", explorerUrl: null, slot: 1, unitsConsumed: null } } as WriteProgress,
      }),
    );
    expect(textOf(html)).toContain("Approve buying SPYx and ANTHROPIC when your first savings arrive");
    expect(textOf(html)).not.toContain(ONBOARDING_COPY.ready.nextSol);
  });
});
