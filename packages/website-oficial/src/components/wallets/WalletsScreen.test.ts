// The wallets screen, rendered to HTML with Privy mocked, in each state Privy can put it in — and its
// buttons, pressed. The test environment is node with no DOM, so the ui Button is wrapped to remember
// each button's label, disabled state and onClick as it renders. Pressing one runs the component's real
// handler against Privy's mocked methods: that is what proves the screen hands Privy exactly the
// keeper's signer id and policy id, and never a click event.

import type { WalletWithMetadata } from "@privy-io/react-auth";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EVM_EMBEDDED,
  IMPORTED,
  PENSION_KEY,
  POLICY,
  RECORD,
  SIGNER,
  TRADING_0,
  TRADING_1,
  TRADING_2,
  embedded,
  phantom,
  userWith,
} from "../../../test/fixtures/privy-user";

const mocked = vi.hoisted(() => {
  /** A rendered element tree's text, without a DOM. */
  function textOf(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (typeof node === "object" && node !== null && "props" in node) {
      return textOf((node as { props: { children?: unknown } }).props.children);
    }
    return "";
  }
  return {
    textOf,
    privy: { ready: true, authenticated: true, user: null as unknown },
    config: { privySignerId: null as string | null, privyPolicyId: null as string | null },
    buttons: [] as { label: string; disabled: boolean; onClick: ((event: unknown) => void) | undefined }[],
    login: vi.fn(),
    logout: vi.fn(),
    createWallet: vi.fn(),
    addSigners: vi.fn(),
    refreshUser: vi.fn(),
    exportWallet: vi.fn(),
  };
});

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ...mocked.privy, login: mocked.login, logout: mocked.logout }),
  useLogin: () => ({ login: mocked.login }),
  useUser: () => ({ user: mocked.privy.user, refreshUser: mocked.refreshUser }),
  useSigners: () => ({ addSigners: mocked.addSigners, removeSigners: vi.fn() }),
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useCreateWallet: () => ({ createWallet: mocked.createWallet }),
  useExportWallet: () => ({ exportWallet: mocked.exportWallet }),
  // The vault card and each row's link control take their signers from these; nothing here signs.
  useWallets: () => ({ ready: true, wallets: [] }),
  useSignTransaction: () => ({ signTransaction: async () => ({ signedTransaction: new Uint8Array(0) }) }),
  useSignMessage: () => ({ signMessage: async () => ({ signature: new Uint8Array(0) }) }),
}));

vi.mock("@/app/providers", () => ({ useSolanaConfig: () => mocked.config }));

vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  return {
    ...actual,
    Button: (props: Parameters<typeof actual.Button>[0]) => {
      mocked.buttons.push({
        label: mocked.textOf(props.children).trim(),
        disabled: props.disabled === true,
        onClick: props.onClick as unknown as ((event: unknown) => void) | undefined,
      });
      return actual.Button(props);
    },
  };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletsScreen } from "@/components/wallets/WalletsScreen";

/** What a real click hands a handler: an object with a target, which Privy would read as options. */
const CLICK = { type: "click", target: {} };

function render(): string {
  mocked.buttons.length = 0;
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(WalletsScreen)));
}

const buttons = (label: string) => mocked.buttons.filter((button) => button.label === label);

/** Each trading wallet row: its seat as rendered, and the addresses inside it. */
function rows(html: string): { seat: string; body: string }[] {
  return [...html.matchAll(/<li[^>]*data-seat="([a-z-]+)"[^>]*>(.*?)<\/li>/g)].map((match) => ({
    seat: match[1] ?? "",
    body: match[2] ?? "",
  }));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mocked.privy = { ready: true, authenticated: true, user: RECORD };
  mocked.config = { privySignerId: SIGNER, privyPolicyId: POLICY };
  for (const fn of [mocked.login, mocked.logout, mocked.createWallet, mocked.addSigners, mocked.refreshUser, mocked.exportWallet]) {
    fn.mockReset();
  }
  mocked.logout.mockResolvedValue(undefined);
  mocked.refreshUser.mockImplementation(async () => mocked.privy.user);
  mocked.exportWallet.mockResolvedValue(undefined);
});

describe("WalletsScreen states", () => {
  it("loading: a skeleton until Privy is ready, and nothing Privy-dependent", () => {
    mocked.privy = { ready: false, authenticated: false, user: null };
    const html = render();
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Connect pension key");
    expect(buttons("Create wallet")).toHaveLength(0);
  });

  it("logged out: Connect opens Privy's login with no arguments, never the click event", () => {
    mocked.privy = { ready: true, authenticated: false, user: null };
    const html = render();
    expect(html).toContain("Connect your pension key");
    expect(buttons("Create wallet")).toHaveLength(0);
    const [connect] = buttons("Connect pension key");
    connect?.onClick?.(CLICK);
    expect(mocked.login.mock.calls).toStrictEqual([[]]);
  });

  it("a session without an external Solana wallet: says so, offers Disconnect, creates nothing", () => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([embedded(TRADING_0, 0, true)]) };
    const html = render();
    expect(html).toContain("This session has no pension key");
    expect(buttons("Disconnect")).toHaveLength(1);
    expect(buttons("Create wallet")).toHaveLength(0);
    expect(rows(html)).toHaveLength(0);
  });

  it("the seat not configured: the refusal names both variables, and Create is disabled and creates nothing even if pressed", async () => {
    mocked.config = { privySignerId: null, privyPolicyId: null };
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom()]) };
    const html = render();
    expect(html).toMatch(/role="alert"[^>]*>[^<]*SIP_SOLANA_PRIVY_SIGNER_ID and SIP_SOLANA_PRIVY_POLICY_ID/);
    expect(html).not.toContain(SIGNER);
    const [create] = buttons("Create wallet");
    expect(create?.disabled).toBe(true);
    create?.onClick?.(CLICK);
    await flush();
    expect(mocked.createWallet).not.toHaveBeenCalled();
  });
});

describe("WalletsScreen with the seat configured", () => {
  it("shows the pension key apart, and each trading wallet's seat as Privy's record states it", () => {
    const html = render();
    expect(html).toContain(PENSION_KEY);
    expect(html).not.toContain(EVM_EMBEDDED);
    const seen = rows(html).map((row) => [row.seat, [TRADING_0, TRADING_1, TRADING_2, IMPORTED, PENSION_KEY].filter((a) => row.body.includes(a))]);
    expect(seen).toStrictEqual([
      ["missing", [TRADING_0]],
      ["has-signer", [TRADING_1]],
      ["has-signer", [TRADING_2]],
      ["missing", [IMPORTED]],
    ]);
    expect(html).toContain("Has a signer");
    expect(html).not.toContain("Seated");
    expect(html).toContain("No seat");
    // The ids a new wallet is seated with, for the owner to match in the Privy dashboard.
    expect(html).toContain(SIGNER);
    expect(html).toContain(POLICY);
  });

  it("offers the grant only for a missing seat, and a re-read, not a grant, for an unknown one", () => {
    const flagless = { ...embedded(TRADING_0, 0, false), delegated: undefined } as unknown as WalletWithMetadata;
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), flagless, embedded(TRADING_1, 1, true)]) };
    const html = render();
    expect(rows(html).map((row) => row.seat)).toStrictEqual(["unknown", "has-signer"]);
    expect(html).toContain("Seat unknown");
    expect(buttons("Grant keeper permission")).toHaveLength(0);
    expect(buttons("Check again")).toHaveLength(1);
  });

  it("a wallet Privy lists with a signer says only that — never Seated — and prints the verify command with its ids", () => {
    // Privy's record is the same whatever the signer is: the keeper's with its policy, the keeper's without it, or
    // another key quorum set from the Privy dashboard or another client. The row must not claim the keeper's seat.
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), embedded(TRADING_1, 1, true)]) };
    const html = render();
    const [row, ...others] = rows(html);
    expect(others).toHaveLength(0);
    expect(row?.seat).toBe("has-signer");
    expect(row?.body).toContain("Has a signer");
    expect(row?.body).not.toMatch(/seated|seats only/i);
    expect(row?.body).toContain(`privy-policy verify --wallet wallet-id-tradingone --policy ${POLICY}`);
    expect(buttons("Grant keeper permission")).toHaveLength(0);
    expect(buttons("Check again")).toHaveLength(0);
  });

  it("Create wallet hands Privy exactly createAdditional and the keeper's signer id with its policy id", async () => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom()]) };
    mocked.createWallet.mockResolvedValue({ wallet: { address: TRADING_0 } });
    render();
    const [create] = buttons("Create wallet");
    expect(create?.disabled).toBe(false);
    create?.onClick?.(CLICK);
    await vi.waitFor(() => expect(mocked.refreshUser).toHaveBeenCalled());
    expect(mocked.createWallet.mock.calls).toStrictEqual([
      [{ createAdditional: true, signers: [{ signerId: SIGNER, policyIds: [POLICY] }] }],
    ]);
  });

  it("Grant keeper permission re-reads Privy's record, then adds the signer with its policy to that wallet", async () => {
    const missing = userWith([phantom(), embedded(TRADING_0, 0, false)]);
    mocked.privy = { ready: true, authenticated: true, user: missing };
    mocked.addSigners.mockResolvedValue({ user: missing });
    render();
    const grants = buttons("Grant keeper permission");
    expect(grants).toHaveLength(1);
    grants[0]?.onClick?.(CLICK);
    await vi.waitFor(() => expect(mocked.addSigners).toHaveBeenCalledTimes(1));
    expect(mocked.addSigners.mock.calls).toStrictEqual([[{ address: TRADING_0, signers: [{ signerId: SIGNER, policyIds: [POLICY] }] }]]);
    expect(mocked.refreshUser.mock.invocationCallOrder[0]).toBeLessThan(mocked.addSigners.mock.invocationCallOrder[0] ?? 0);
  });

  it("Export key opens Privy's export for each trading wallet's own address, and never the pension key's", async () => {
    render();
    const exports = buttons("Export key");
    expect(exports).toHaveLength(4);
    for (const button of exports) button.onClick?.(CLICK);
    await vi.waitFor(() => expect(mocked.exportWallet).toHaveBeenCalledTimes(4));
    expect(mocked.exportWallet.mock.calls).toStrictEqual([
      [{ address: TRADING_0 }],
      [{ address: TRADING_1 }],
      [{ address: TRADING_2 }],
      [{ address: IMPORTED }],
    ]);
  });
});
