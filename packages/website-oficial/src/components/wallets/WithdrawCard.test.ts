// The withdrawal card rendered to HTML with Privy mocked, and its buttons pressed: the pattern
// VaultCard.test.ts uses. Pressing a share runs the real flow against a stub client.

import { ANTHROPIC_MINT, SIP_PROGRAM_ID, SPYX_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
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
  };
});

vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({ ready: true, wallets: mocked.wallets }),
  useSignTransaction: () => ({ signTransaction: mocked.signTransaction }),
  useSignMessage: () => ({ signMessage: vi.fn() }),
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
import { WithdrawCard, largestHoldings, maxWithdrawalText, readWithdrawal, tokenLabel, tokenRows } from "@/components/wallets/WithdrawCard";
import { VaultWriteLock } from "@/hooks/use-vault-actions";
import { VaultScreenContext, type VaultScreenValue, type VaultView } from "@/hooks/use-vault-state";
import type { HoldingJson, VaultApi, VaultStateJson } from "@/lib/vault-api";

const CLICK = { type: "click", target: {} };
const PENSION = Keypair.generate().publicKey.toBase58();
const VAULT = Keypair.generate().publicKey.toBase58();
const account = (): string => Keypair.generate().publicKey.toBase58();

const SPYX_HOLDING: HoldingJson = { tokenAccount: account(), mint: SPYX_MINT, amountRaw: "12345678", decimals: 8, uiAmount: "0.12416212", tokenProgram: TOKEN_2022_PROGRAM };
const WSOL_HOLDING: HoldingJson = { tokenAccount: account(), mint: WSOL_MINT, amountRaw: "100000000", decimals: 9, uiAmount: "0.1", tokenProgram: TOKEN_PROGRAM };

function stateWith(overrides: Partial<VaultStateJson> = {}): VaultStateJson {
  return {
    owner: PENSION,
    programId: SIP_PROGRAM_ID,
    vault: { status: "exists", address: VAULT, lamports: "151285240", rentFloor: "1285240", withdrawableLamports: "150000000" },
    policy: { status: "missing", address: account() },
    config: { address: account(), status: "missing", exists: false, paused: null },
    walletLinks: [],
    holdings: { status: "exists", items: [SPYX_HOLDING, WSOL_HOLDING] },
    vaultTokenAccounts: { status: "exists", items: [] },
    rents: { vault: "1285240", link: "1305560", policy: "5577840", tokenAccount: "1488440", legTokenAccounts: { [SPYX_MINT]: "1559560" } },
    prices: null,
    ...overrides,
  };
}

function screen(view: VaultView, api: Partial<VaultApi> = {}) {
  return { pensionKey: PENSION, view, refresh: vi.fn(), api: api as VaultApi } satisfies VaultScreenValue;
}

function render(value: VaultScreenValue): string {
  mocked.buttons.length = 0;
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(VaultScreenContext.Provider, { value }, createElement(VaultWriteLock, null, createElement(WithdrawCard)))));
}

const buttons = (label: string) => mocked.buttons.filter((button) => button.label === label);

beforeEach(() => {
  // Phantom connected at the pension key, so a pressed button reaches the build route.
  mocked.wallets = [{ address: PENSION, standardWallet: { name: "Phantom" } }];
  mocked.signTransaction.mockReset();
});

describe("WithdrawCard", () => {
  it("SOL: the balance, the rent kept, what can be withdrawn and the rule; Withdraw SOL waits for an amount", () => {
    const html = render(screen({ kind: "ready", state: stateWith() }));
    expect(html).toContain("0.15128524 SOL");
    expect(html).toContain("0.15 SOL");
    expect(html).toContain("Kept as rent 0.00128524 SOL");
    expect(html).toContain("Only your pension key can withdraw, and SaverFi cannot pause or block a SOL withdrawal. The vault keeps 0.00128524 SOL of rent, which Solana requires, and a vault cannot be closed.");
    expect(buttons("Withdraw SOL").map((button) => button.disabled)).toEqual([true]);
    expect(buttons("Max")).toHaveLength(1);
  });

  it("with nothing to withdraw: where savings come from, and the vault's address to send a test amount to", () => {
    const html = render(screen({ kind: "ready", state: stateWith({ vault: { status: "exists", address: VAULT, lamports: "1285240", rentFloor: "1285240", withdrawableLamports: "0" } }) }));
    expect(html).toContain("Savings arrive from linked trading wallets. To try a withdrawal now, send a little SOL to the vault address from your wallet app.");
    expect(html).toContain(VAULT);
    expect(buttons("Withdraw SOL")).toHaveLength(0);
  });

  it("with investing on, the SOL section says the keeper can convert SOL that reaches the vault within about a minute, and to pause first to test a withdrawal; paused or with no policy it says nothing of it", () => {
    const policy: NonNullable<VaultStateJson["policy"]["state"]> = {
      vault: VAULT,
      enabled: true,
      venueProgram: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
      inMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: "124719467624105690" }],
      minConvertRateWad: "90034840399943305",
      minInvestment: "5000000",
      maxPerCall: "10000000",
      maxRolling30d: "50000000",
      bucketDays: new Array<number>(31).fill(0),
      bucketAmounts: new Array<string>(31).fill("0"),
      lifetimeInvested: "0",
      policyNonce: "1",
    };
    const empty = { status: "exists" as const, address: VAULT, lamports: "1285240", rentFloor: "1285240", withdrawableLamports: "0" };
    const words = "Investing is on, so the keeper can convert SOL that reaches this vault to USDC within about a minute, and it then shows under Tokens. To test a SOL withdrawal, pause investing first.";
    const on = render(screen({ kind: "ready", state: stateWith({ vault: empty, policy: { status: "exists", address: account(), state: policy } }) }));
    expect(on).toContain("send a little SOL to the vault address");
    expect(on).toContain(words);
    expect(render(screen({ kind: "ready", state: stateWith({ policy: { status: "exists", address: account(), state: policy } }) }))).toContain(words);
    expect(render(screen({ kind: "ready", state: stateWith({ vault: empty, policy: { status: "exists", address: account(), state: { ...policy, enabled: false } } }) }))).not.toContain(words);
    expect(render(screen({ kind: "ready", state: stateWith({ vault: empty }) }))).not.toContain(words);
  });

  it("Max is exactly the withdrawable lamports; an amount above it, zero, or ten decimals is refused with words", () => {
    for (const withdrawable of [150_000_000n, 298_714_760n, 1n, 18_446_744_073_709_551_615n]) {
      expect(readWithdrawal(maxWithdrawalText(withdrawable), withdrawable)).toEqual({ ok: true, lamports: withdrawable });
    }
    expect(readWithdrawal("0.150000001", 150_000_000n)).toEqual({ ok: false, message: "The vault can release at most 0.15 SOL." });
    expect(readWithdrawal("0", 150_000_000n)).toEqual({ ok: false, message: "Enter more than 0 SOL." });
    expect(readWithdrawal("0.0000000001", 150_000_000n)).toMatchObject({ ok: false });
  });

  it("tokens: SPYx with the RPC's own amount, the issuer's powers and the account it may create; wSOL arrives as SOL", () => {
    const html = render(screen({ kind: "ready", state: stateWith() }));
    expect(html).toContain("0.12416212");
    // Two stocks, two issuers: the line may no longer name one of them, and it
    // carries the fact that separates them — one key holds everything on ANTHROPIC.
    expect(html).toContain("Each issuer can freeze, pause or move its own stock, even inside your vault, and on ANTHROPIC one key holds all of those powers.");
    expect(html).toContain("Creates your own SPYx token account if you have none (0.00155956 SOL of rent, paid by you and kept by you).");
    expect(html).toContain("Arrives in your wallet as SOL.");
    expect(buttons("25 %")).toHaveLength(2);
    expect(buttons("All")).toHaveLength(2);
  });

  it("25 % and All hand the flow raw shares of the SPYx holding, from its own account, never a click event", async () => {
    const build = vi.fn(async () => ({ ok: false as const, status: 422, code: "not_held", message: "Your vault holds none of this token.", retryAfterSeconds: null, body: {} }));
    const value = screen({ kind: "ready", state: stateWith() }, { build: build as unknown as VaultApi["build"] });
    render(value);
    const [quarter] = buttons("25 %");
    const [all] = buttons("All");
    quarter?.onClick?.(CLICK);
    await vi.waitFor(() => expect(value.refresh).toHaveBeenCalledTimes(1));
    all?.onClick?.(CLICK);
    await vi.waitFor(() => expect(value.refresh).toHaveBeenCalledTimes(2));
    expect(build.mock.calls).toStrictEqual([
      [{ action: "withdrawToken", owner: PENSION, mint: SPYX_MINT, amountRaw: "3086419", vaultToken: SPYX_HOLDING.tokenAccount }],
      [{ action: "withdrawToken", owner: PENSION, mint: SPYX_MINT, amountRaw: "12345678", vaultToken: SPYX_HOLDING.tokenAccount }],
    ]);
    expect(mocked.signTransaction).not.toHaveBeenCalled();
  });

  it("no vault says to create it first; tokens neither listed nor read by address are never offered", () => {
    expect(render(screen({ kind: "ready", state: stateWith({ vault: { status: "missing", address: VAULT } }) }))).toContain("Create your vault first.");
    const html = render(screen({ kind: "ready", state: stateWith({ holdings: { status: "unreadable", items: [] }, vaultTokenAccounts: { status: "unreadable", items: [] } }) }));
    expect(html).toContain("SaverFi could not read the vault&#x27;s tokens just now.");
    expect(buttons("All")).toHaveLength(0);
  });

  it("a listing too large to read still offers the vault's own accounts that hold something, says only they are shown, and All names that account", async () => {
    const usdc = account();
    const vaultTokenAccounts: VaultStateJson["vaultTokenAccounts"] = {
      status: "exists",
      items: [
        { mint: WSOL_MINT, address: account(), tokenProgram: TOKEN_PROGRAM, status: "missing", amountRaw: null, decimals: null, uiAmount: null },
        { mint: USDC_MINT, address: usdc, tokenProgram: TOKEN_PROGRAM, status: "exists", amountRaw: "12500000", decimals: 6, uiAmount: "12.5" },
        { mint: SPYX_MINT, address: account(), tokenProgram: TOKEN_2022_PROGRAM, status: "exists", amountRaw: "0", decimals: 8, uiAmount: "0" },
        { mint: ANTHROPIC_MINT, address: account(), tokenProgram: TOKEN_2022_PROGRAM, status: "missing", amountRaw: null, decimals: null, uiAmount: null },
      ],
    };
    const state = stateWith({ holdings: { status: "unreadable", items: [] }, vaultTokenAccounts });
    expect(tokenRows(state)).toEqual({ source: "own_accounts", rows: [{ tokenAccount: usdc, mint: USDC_MINT, amountRaw: "12500000", decimals: 6, uiAmount: "12.5", tokenProgram: TOKEN_PROGRAM }] });
    const build = vi.fn(async () => ({ ok: false as const, status: 422, code: "not_held", message: "Your vault holds none of this token.", retryAfterSeconds: null, body: {} }));
    const value = screen({ kind: "ready", state }, { build: build as unknown as VaultApi["build"] });
    const html = render(value);
    // The names are SaverFi's own four targets, not this listing's rows: one per offered leg.
    expect(html).toContain("SaverFi could not list every token account your vault owns just now, so only its own wSOL, USDC, SPYx and ANTHROPIC accounts are shown.");
    expect(html).toContain("12.5");
    expect(html).not.toContain("SaverFi could not read the vault&#x27;s tokens just now.");
    expect(buttons("All")).toHaveLength(1);
    buttons("All")[0]?.onClick?.(CLICK);
    await vi.waitFor(() => expect(value.refresh).toHaveBeenCalledTimes(1));
    expect(build.mock.calls).toStrictEqual([[{ action: "withdrawToken", owner: PENSION, mint: USDC_MINT, amountRaw: "12500000", vaultToken: usdc }]]);

    const empty = { ...vaultTokenAccounts, items: vaultTokenAccounts.items.filter((item) => item.mint !== USDC_MINT) };
    expect(render(screen({ kind: "ready", state: stateWith({ holdings: { status: "unreadable", items: [] }, vaultTokenAccounts: empty }) }))).toContain("Those accounts hold no tokens.");
    expect(buttons("All")).toHaveLength(0);
  });

  it("shows the largest holding of each mint, and names the tokens it knows", () => {
    const smaller = { ...SPYX_HOLDING, tokenAccount: account(), amountRaw: "5" };
    expect(largestHoldings([smaller, SPYX_HOLDING, { ...WSOL_HOLDING, amountRaw: "0" }])).toEqual([SPYX_HOLDING]);
    expect([tokenLabel(SPYX_MINT), tokenLabel(WSOL_MINT), tokenLabel("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")]).toEqual(["SPYx", "wSOL", "USDC"]);
    expect(tokenLabel(VAULT)).toBe(`${VAULT.slice(0, 4)}…${VAULT.slice(-4)}`);
  });
});
