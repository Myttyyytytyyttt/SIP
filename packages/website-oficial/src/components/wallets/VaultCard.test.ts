// The vault card rendered to HTML in each state, with Privy mocked, and its buttons pressed: the
// pattern WalletsScreen.test.ts uses (the ui Button is wrapped to remember each button's label,
// disabled state and onClick). Pressing Create runs the real flow against a stub client.

import { SIP_PROGRAM_ID } from "@sip/solana-core/client";
import { Keypair } from "@solana/web3.js";
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
  return {
    textOf,
    buttons: [] as { label: string; disabled: boolean; onClick: ((event: unknown) => void) | undefined }[],
    wallets: [] as { address: string; standardWallet: unknown }[],
    signTransaction: vi.fn(),
    signMessage: vi.fn(),
  };
});

vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({ ready: true, wallets: mocked.wallets }),
  useSignTransaction: () => ({ signTransaction: mocked.signTransaction }),
  useSignMessage: () => ({ signMessage: mocked.signMessage }),
}));

vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  return {
    ...actual,
    Button: (props: Parameters<typeof actual.Button>[0]) => {
      mocked.buttons.push({ label: mocked.textOf(props.children).trim(), disabled: props.disabled === true, onClick: props.onClick as unknown as ((event: unknown) => void) | undefined });
      return actual.Button(props);
    },
  };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import { VaultCard } from "@/components/wallets/VaultCard";
import { VaultWriteLock } from "@/hooks/use-vault-actions";
import { VaultScreenContext, type VaultScreenValue, type VaultView } from "@/hooks/use-vault-state";
import type { VaultApi, VaultStateJson } from "@/lib/vault-api";

const CLICK = { type: "click", target: {} };
const PENSION = Keypair.generate().publicKey.toBase58();
const VAULT = Keypair.generate().publicKey.toBase58();

function stateWith(overrides: Partial<VaultStateJson> = {}): VaultStateJson {
  return {
    owner: PENSION,
    programId: SIP_PROGRAM_ID,
    vault: { status: "missing", address: VAULT },
    policy: { status: "missing", address: Keypair.generate().publicKey.toBase58() },
    config: { address: Keypair.generate().publicKey.toBase58(), status: "missing", exists: false, paused: null },
    walletLinks: [],
    holdings: { status: "exists", items: [] },
    vaultTokenAccounts: { status: "exists", items: [] },
    rents: { vault: "1285240", link: "1305560", policy: "5577840", tokenAccount: "1488440", legTokenAccounts: {} },
    prices: { slot: 1, convertWad: "100038711555492562", usdcRawPerSol: "100038711", legs: [] },
    ...overrides,
  };
}

function screen(view: VaultView, api: Partial<VaultApi> = {}) {
  return { pensionKey: PENSION, view, refresh: vi.fn(), api: api as VaultApi } satisfies VaultScreenValue;
}

function render(value: VaultScreenValue, props: { volumeOffered?: boolean } = {}): string {
  mocked.buttons.length = 0;
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(VaultScreenContext.Provider, { value }, createElement(VaultWriteLock, null, createElement(VaultCard, props)))),
  );
}

const buttons = (label: string) => mocked.buttons.filter((button) => button.label === label);
const radio = (html: string, value: string): string => html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))?.[0] ?? "";

beforeEach(() => {
  mocked.wallets = [{ address: PENSION, standardWallet: { name: "Phantom" } }];
  mocked.signTransaction.mockReset();
  mocked.signMessage.mockReset();
});

describe("VaultCard", () => {
  it("loading: a skeleton, and no create form", () => {
    const html = render(screen({ kind: "loading" }));
    expect(html).toContain('aria-busy="true"');
    expect(buttons("Create vault")).toHaveLength(0);
  });

  it("unreadable never renders Create vault, whether the route or the vault read failed; Retry re-reads with no argument", () => {
    for (const view of [{ kind: "unreadable", message: "x" } as const, { kind: "ready", state: stateWith({ vault: { status: "unreadable", address: VAULT } }) } as const]) {
      const value = screen(view);
      const html = render(value);
      expect(html).toContain("SaverFi could not read Solana just now. Nothing was offered to sign.");
      expect(buttons("Create vault")).toHaveLength(0);
      buttons("Retry")[0]?.onClick?.(CLICK);
      expect(value.refresh.mock.calls).toStrictEqual([[]]);
    }
  });

  it("no vault: Profit selected with its rule, Volume greyed with Coming soon, the limits with dollars, and the live rent", () => {
    const html = render(screen({ kind: "ready", state: stateWith() }));
    expect(radio(html, "0")).toContain('checked=""');
    expect(radio(html, "1")).toContain('disabled=""');
    expect(html).toContain("Profit · 20 % of what your trading wallet gains. The keeper watches your trading wallet&#x27;s SOL.");
    expect(html).toContain(
      "A losing stretch moves nothing, and its loss comes off the next gain. Once your trading wallet has signed 100 transactions of its own while still behind, that loss is dropped and later gains count in full.",
    );
    expect(html).toContain("One settlement moves at most 0.06 SOL; anything above that is not carried over. It never leaves the trading wallet with less than 0.05 SOL.");
    expect(html).toContain("Coming soon");
    expect(html).toContain("Coming soon: the keeper cannot measure trading volume yet, so a volume vault would receive nothing.");
    expect(html).toContain('value="0.06"');
    expect(html).toContain('value="0.05"');
    expect(html).toContain("≈ $6.00");
    expect(html).toContain("Creating the vault costs 0.00128524 SOL of rent plus the network fee.");
    expect(html).toContain("a vault cannot be closed, so it does not come back.");
    expect(buttons("Create vault")[0]?.disabled).toBe(false);
  });

  it("with VOLUME offered, its option is enabled and says what it takes, not that it is coming", () => {
    const html = render(screen({ kind: "ready", state: stateWith() }), { volumeOffered: true });
    expect(radio(html, "1")).not.toContain('disabled=""');
    expect(html).not.toContain("Coming soon");
    expect(html).toContain("Volume · 2 % of the SOL value of every buy and sell your trading wallet makes, win or lose.");
  });

  it("Create hands the flow the limits shown as an explicit object, never the click event, and re-reads when the vault already exists", async () => {
    const build = vi.fn(async () => ({ ok: false as const, status: 409, code: "vault_exists", message: "This pension key already has a vault.", retryAfterSeconds: null, body: {} }));
    const value = screen({ kind: "ready", state: stateWith() }, { build: build as unknown as VaultApi["build"] });
    render(value);
    buttons("Create vault")[0]?.onClick?.(CLICK);
    await vi.waitFor(() => expect(value.refresh).toHaveBeenCalledTimes(1));
    expect(build.mock.calls).toStrictEqual([[{ action: "createVault", owner: PENSION, mode: 0, maxContribution: "60000000", walletReserve: "50000000" }]]);
    expect(mocked.signTransaction).not.toHaveBeenCalled();
  });

  it("a vault: its rule, address, balance and what can be withdrawn, the day it was created, and Paused when it is", () => {
    const html = render(
      screen({
        kind: "ready",
        state: stateWith({
          vault: {
            status: "exists",
            address: VAULT,
            lamports: "300000000",
            rentFloor: "1285240",
            withdrawableLamports: "298714760",
            state: { owner: PENSION, paused: true, skimMode: 0, skimBps: 2_000, volumeBps: 200, lifetimeSaved: "0", createdAt: "1789495565", maxContribution: "60000000", walletReserve: "50000000", policyNonce: "0" },
          },
        }),
      }),
    );
    expect(html).toContain(VAULT);
    expect(html).toContain(`https://solscan.io/account/${VAULT}`);
    expect(html).toContain("0.3 SOL");
    expect(html).toContain("0.29871476 SOL");
    expect(html).toContain("2026-09-15");
    expect(html).toContain("Paused");
    expect(html).toContain("Profit · 20 %");
    expect(html).toContain("One settlement moves at most 0.06 SOL");
    expect(buttons("Create vault")).toHaveLength(0);
  });
});
