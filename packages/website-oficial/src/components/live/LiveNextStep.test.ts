// The card that says what to do next. Each stage has exactly one thing to do,
// and a stage with no pension yet must show no pension figures — a screen of
// honest zeroes reads as a broken product rather than an unstarted one.

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
  return { textOf, buttons: [] as { label: string; onClick: ((event: unknown) => void) | undefined }[] };
});

vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  return {
    ...actual,
    Button: (props: Parameters<typeof actual.Button>[0]) => {
      mocked.buttons.push({ label: mocked.textOf(props.children).trim(), onClick: props.onClick as unknown as ((event: unknown) => void) | undefined });
      return actual.Button(props);
    },
  };
});

import { LiveNextStep } from "@/components/live/LiveNextStep";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveDashboard } from "@/lib/live-types";

import { OWNER, WALLET_A, liveDashboard, liveSnapshot } from "../../../test/fixtures/live-dashboard";

const onOpenWallets = vi.fn();

function render(data: LiveDashboard, seatProblem: string | null = null): string {
  mocked.buttons.length = 0;
  return renderToStaticMarkup(createElement(LiveNextStep, { data, pensionKey: OWNER, seatProblem, onOpenWallets }));
}

const buttons = (label: string) => mocked.buttons.filter((button) => button.label === label);

/** A pension key on its very first visit: no vault, no wallet, no link, no policy. */
const noVault = (): LiveDashboard =>
  liveDashboard({
    snapshot: liveSnapshot({ vault: { status: "missing", address: "v" }, policy: { status: "missing", address: "p" }, wallets: [] }),
    activity: null,
    privyWallets: [],
  });

const unlinkedSnapshot = () =>
  liveSnapshot({ wallets: [{ wallet: WALLET_A, lamports: "420000000", link: { address: "l", status: "missing", vault: null, epoch: null, settlementNonce: null, frontierSlot: null } }] });

beforeEach(() => {
  mocked.buttons.length = 0;
  onOpenWallets.mockClear();
});

describe("no vault yet", () => {
  it("names the rent it costs and offers to create one", () => {
    const html = render(noVault());
    expect(html).toContain(LIVE_COPY.noVault.title);
    expect(html).toContain("0.00128524");
    expect(buttons(LIVE_COPY.noVault.create)).toHaveLength(1);
  });

  it("shows NO pension figures: there is no pension yet", () => {
    const html = render(noVault());
    expect(html).not.toContain(LIVE_COPY.savedSoFar);
    expect(html).not.toContain("$");
  });

  it("walks the four steps, and marks none of them done", () => {
    const html = render(noVault());
    for (const step of LIVE_COPY.noVault.steps) expect(html).toContain(step);
    expect(html).not.toContain("line-through");
  });
});

describe("the stages after it", () => {
  it("a vault with no trading wallet offers to create one", () => {
    const data = liveDashboard({ snapshot: liveSnapshot({ wallets: [] }), activity: null, privyWallets: [] });
    const html = render(data);
    expect(html).toContain(LIVE_COPY.noTradingWallet.body);
    expect(buttons(LIVE_COPY.noTradingWallet.create)).toHaveLength(1);
  });

  it("…and offers NO button when this deployment has no keeper seat, saying why instead", () => {
    const data = liveDashboard({ snapshot: liveSnapshot({ wallets: [] }), activity: null, privyWallets: [] });
    const html = render(data, "The keeper's seat is not configured.");
    expect(html).toContain("The keeper&#x27;s seat is not configured.");
    expect(buttons(LIVE_COPY.noTradingWallet.create)).toHaveLength(0);
  });

  it("an unlinked wallet is offered a link", () => {
    const html = render(liveDashboard({ snapshot: unlinkedSnapshot(), activity: null }));
    expect(buttons(LIVE_COPY.notLinked.link)).toHaveLength(1);
  });

  it("…but not while the protocol is paused, or its config could not be read", () => {
    const paused = liveSnapshot({ ...unlinkedSnapshot(), config: { address: "c", status: "exists", exists: true, paused: true } });
    expect(render(liveDashboard({ snapshot: paused, activity: null }))).toContain(LIVE_COPY.notLinked.paused);
    expect(buttons(LIVE_COPY.notLinked.link)).toHaveLength(0);

    const noConfig = liveSnapshot({ ...unlinkedSnapshot(), config: { address: "c", status: "unreadable", exists: false, paused: null } });
    expect(render(liveDashboard({ snapshot: noConfig, activity: null }))).toContain(LIVE_COPY.notLinked.needsConfig);
    expect(buttons(LIVE_COPY.notLinked.link)).toHaveLength(0);
  });

  it("a linked wallet with nothing settled yet explains the keeper's sweep at the vault's own rate", () => {
    const fresh = liveSnapshot();
    const data = liveDashboard({
      snapshot: liveSnapshot({ ...fresh, vault: { ...fresh.vault, state: { ...fresh.vault.state!, lifetimeSaved: "0" } }, wallets: [{ ...fresh.wallets[0]!, link: { ...fresh.wallets[0]!.link, settlementNonce: "0" } }] }),
      activity: null,
    });
    expect(render(data)).toContain(LIVE_COPY.waiting.body("20 %"));
  });

  it("renders nothing at all once the pension is running", () => {
    expect(render(liveDashboard())).toBe("");
  });

  it("never offers to create a vault that merely could not be READ", () => {
    const data = liveDashboard({ snapshot: liveSnapshot({ vault: { status: "unreadable", address: "v" } }), activity: null });
    expect(render(data)).toBe("");
  });
});
