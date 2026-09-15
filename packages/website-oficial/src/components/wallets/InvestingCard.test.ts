// The investing card rendered to HTML in each state, with Privy mocked, and its buttons pressed: the
// pattern VaultCard.test.ts uses. Pressing a button runs the real flow against a stub client.

import { SIP_PROGRAM_ID, SPYX_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
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
import { InvestingCard, canSignPolicy, readCaps, setupRent, usedInLast30Days } from "@/components/wallets/InvestingCard";
import { VaultWriteLock } from "@/hooks/use-vault-actions";
import { VaultScreenContext, type VaultScreenValue, type VaultView } from "@/hooks/use-vault-state";
import type { InvestmentPolicyJson, VaultApi, VaultStateJson } from "@/lib/vault-api";

const CLICK = { type: "click", target: {} };
const PENSION = Keypair.generate().publicKey.toBase58();
const VAULT = Keypair.generate().publicKey.toBase58();
const account = (): string => Keypair.generate().publicKey.toBase58();

/** The pools at mainnet slot 447313239. */
const PRICES: VaultStateJson["prices"] = {
  slot: 1,
  convertWad: "100038711555492562",
  usdcRawPerSol: "100038711",
  legs: [{ symbol: "SPYx", mint: SPYX_MINT, wad: "131283650130637569", usdcRawPer1e8: "761709474" }],
};

const POLICY: InvestmentPolicyJson = {
  vault: VAULT,
  enabled: true,
  venueProgram: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  inMint: USDC_MINT,
  legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: "124719467624105690" }],
  minConvertRateWad: "90034840399943305",
  minInvestment: "5000000",
  maxPerCall: "10000000",
  maxRolling30d: "50000000",
  bucketDays: new Array<number>(31).fill(0),
  bucketAmounts: new Array<string>(31).fill("0"),
  lifetimeInvested: "25000000",
  policyNonce: "1",
};

function stateWith(overrides: Partial<VaultStateJson> = {}): VaultStateJson {
  return {
    owner: PENSION,
    programId: SIP_PROGRAM_ID,
    vault: { status: "exists", address: VAULT, lamports: "1285240", rentFloor: "1285240", withdrawableLamports: "0" },
    policy: { status: "missing", address: account() },
    config: { address: account(), status: "missing", exists: false, paused: null },
    walletLinks: [],
    holdings: { status: "exists", items: [] },
    vaultTokenAccounts: {
      status: "exists",
      items: [
        { mint: WSOL_MINT, address: account(), tokenProgram: TOKEN_PROGRAM, status: "missing" },
        { mint: USDC_MINT, address: account(), tokenProgram: TOKEN_PROGRAM, status: "missing" },
        { mint: SPYX_MINT, address: account(), tokenProgram: TOKEN_2022_PROGRAM, status: "missing" },
      ],
    },
    rents: { vault: "1285240", link: "1305560", policy: "5577840", tokenAccount: "1488440", legTokenAccounts: { [SPYX_MINT]: "1559560" } },
    prices: PRICES,
    ...overrides,
  };
}

function screen(view: VaultView, api: Partial<VaultApi> = {}) {
  return { pensionKey: PENSION, view, refresh: vi.fn(), api: api as VaultApi } satisfies VaultScreenValue;
}

function render(value: VaultScreenValue): string {
  mocked.buttons.length = 0;
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(VaultScreenContext.Provider, { value }, createElement(VaultWriteLock, null, createElement(InvestingCard)))));
}

const buttons = (label: string) => mocked.buttons.filter((button) => button.label === label);

beforeEach(() => {
  // Phantom connected at the pension key, so a pressed button reaches the build route.
  mocked.wallets = [{ address: PENSION, standardWallet: { name: "Phantom" } }];
  mocked.signTransaction.mockReset();
});

describe("InvestingCard", () => {
  it("no vault: says to create it first, and offers nothing to sign", () => {
    const html = render(screen({ kind: "ready", state: stateWith({ vault: { status: "missing", address: VAULT } }) }));
    expect(html).toContain("Create your vault first.");
    expect(mocked.buttons).toHaveLength(0);
  });

  it("an unreadable vault or policy is never offered a form", () => {
    for (const state of [stateWith({ vault: { status: "unreadable", address: VAULT } }), stateWith({ policy: { status: "unreadable", address: account() } })]) {
      render(screen({ kind: "ready", state }));
      expect(buttons("Sign investment policy")).toHaveLength(0);
    }
    expect(render(screen({ kind: "ready", state: stateWith({ policy: { status: "unreadable", address: account() } }) }))).toContain("SIP could not read your investment policy just now.");
  });

  it("no policy: SIP's basket and $5 rule, the default caps, today's limits in the owner's words, the rent, and the issuer's powers; Sign waits for the box", () => {
    const html = render(screen({ kind: "ready", state: stateWith() }));
    expect(html).toContain("SPYx · 100 %");
    expect(html).toContain("Buys each time $5.00 of USDC is ready");
    expect(html).toContain('value="1000"');
    expect(html).toContain('value="31000"');
    expect(html).toContain("SOL is never sold below $90.03 (90 % of today&#x27;s $100.04)");
    expect(html).toContain("SPYx is never bought above $801.80 per 100,000,000 raw units (5.3 % over today&#x27;s pool price)");
    expect(html).toContain("the keeper converts it to USDC, never below $90.03 per SOL.");
    expect(html).toContain("never paying more than $801.80 per 100,000,000 raw units. At most $1,000.00 per buy and $31,000.00 per 30 days until you change them.");
    // Policy 5,577,840 + wSOL and USDC 1,488,440 each + SPYx 1,559,560 lamports, then 5,000 + 30,000 of fees.
    expect(html).toContain("Setting this up costs 0.01011428 SOL of rent for the policy and the vault&#x27;s token accounts, and none of it comes back.");
    expect(html).toContain("Cost: 0.01011428 SOL of rent that does not come back, plus 0.000035 SOL of network fees.");
    expect(html).toContain("holds a permanent delegate that can move it, including out of your vault.");
    expect(html).toContain("I understand the issuer can freeze, pause or move SPYx");
    const box = html.match(/<input[^>]*name="invest-acknowledge"[^>]*>/)?.[0] ?? "";
    expect(box).toContain('type="checkbox"');
    expect(box).not.toContain("checked");
    expect(buttons("Sign investment policy").map((button) => button.disabled)).toEqual([true]);
  });

  it("Sign is possible only with the box ticked, valid caps and no other write running", () => {
    expect(canSignPolicy({ acknowledged: true, capsOk: true, blocked: false })).toBe(true);
    expect(canSignPolicy({ acknowledged: false, capsOk: true, blocked: false })).toBe(false);
    expect(canSignPolicy({ acknowledged: true, capsOk: false, blocked: false })).toBe(false);
    expect(canSignPolicy({ acknowledged: true, capsOk: true, blocked: true })).toBe(false);
  });

  it("reads the caps as dollars into USDC raw units, and refuses a per-buy cap under $5 or a month under one buy", () => {
    expect(readCaps("10", "50")).toEqual({ ok: true, maxPerCall: 10_000_000n, maxRolling30d: 50_000_000n });
    expect(readCaps("1000", "31000")).toEqual({ ok: true, maxPerCall: 1_000_000_000n, maxRolling30d: 31_000_000_000n });
    expect(readCaps("4.99", "50")).toMatchObject({ ok: false });
    expect(readCaps("10", "9")).toMatchObject({ ok: false, message: "Most per buy must be at least $5.00, and Most per 30 days at least Most per buy." });
    expect(readCaps("", "50")).toMatchObject({ ok: false });
    expect(readCaps("10.0000001", "50")).toMatchObject({ ok: false });
  });

  it("the rent quoted counts the policy and only the vault accounts missing, and says nothing when a part is unknown", () => {
    const partly = stateWith();
    const items = partly.vaultTokenAccounts.items.map((item) => (item.mint === USDC_MINT ? { ...item, status: "exists" as const } : item));
    expect(setupRent({ ...partly, vaultTokenAccounts: { status: "exists", items } })).toBe(5_577_840n + 1_488_440n + 1_559_560n);
    expect(setupRent({ ...partly, rents: null })).toBeNull();
    expect(setupRent({ ...partly, vaultTokenAccounts: { status: "unreadable", items: [] } })).toBeNull();
  });

  it("a policy: on, the basket, its floors against today's prices below market, the caps, what it used and invested, and whether it can buy", () => {
    const holdings: VaultStateJson["holdings"] = { status: "exists", items: [{ tokenAccount: account(), mint: USDC_MINT, amountRaw: "3000000", decimals: 6, uiAmount: "3", tokenProgram: TOKEN_PROGRAM }] };
    const html = render(screen({ kind: "ready", state: stateWith({ policy: { status: "exists", address: account(), state: POLICY }, holdings }) }));
    expect(html).toContain("Investing is on.");
    expect(html).toContain("Floors below market");
    expect(html).toContain("SPYx · 100 %");
    expect(html).toContain("$10.00");
    expect(html).toContain("$50.00");
    expect(html).toContain("$25.00");
    expect(html).toContain("SOL floor $90.03, today $100.04");
    expect(html).toContain("SPYx ceiling $801.80 per 100,000,000 raw units, today $761.71");
    expect(html).toContain("Waiting: it buys once the vault holds $5.00 of USDC.");
    expect(html).toContain("Signing again does not refill this month&#x27;s cap.");
    expect(buttons("Sign again with today's prices")).toHaveLength(1);
    expect(buttons("Pause investing")).toHaveLength(1);
    expect(buttons("Sign investment policy")).toHaveLength(0);
  });

  it("a SOL price under the signed floor says buying waits until signing again", () => {
    const fallen = { ...PRICES!, convertWad: "80000000000000000", usdcRawPerSol: "80000000" };
    const html = render(screen({ kind: "ready", state: stateWith({ policy: { status: "exists", address: account(), state: POLICY }, prices: fallen }) }));
    expect(html).toContain("The market moved past a floor: buying waits until you sign again with today&#x27;s prices.");
    expect(html).not.toContain("Floors below market");
  });

  it("Pause asks for the policy on screen to be signed again with investing off, and is offered with no prices on screen; it never hands the flow the click event", async () => {
    const build = vi.fn(async () => ({ ok: false as const, status: 409, code: "vault_missing", message: "Create your vault first.", retryAfterSeconds: null, body: {} }));
    const value = screen({ kind: "ready", state: stateWith({ policy: { status: "exists", address: account(), state: POLICY }, prices: null }) }, { build: build as unknown as VaultApi["build"] });
    const html = render(value);
    expect(html).toContain("Pausing signs this policy again as it is, with investing off, so it needs no prices.");
    expect(buttons("Pause investing").map((button) => button.disabled)).toEqual([false]);
    buttons("Pause investing")[0]?.onClick?.(CLICK);
    await vi.waitFor(() => expect(value.refresh).toHaveBeenCalledTimes(1));
    expect(build.mock.calls).toStrictEqual([[{ action: "pauseInvesting", owner: PENSION }]]);
    expect(mocked.signTransaction).not.toHaveBeenCalled();
  });

  it("Resume hands the flow the stored caps with investing on, which reads today's prices", async () => {
    const build = vi.fn(async () => ({ ok: false as const, status: 409, code: "vault_missing", message: "Create your vault first.", retryAfterSeconds: null, body: {} }));
    const value = screen({ kind: "ready", state: stateWith({ policy: { status: "exists", address: account(), state: { ...POLICY, enabled: false } } }) }, { build: build as unknown as VaultApi["build"] });
    const html = render(value);
    expect(html).toContain("Investing is paused.");
    buttons("Resume investing")[0]?.onClick?.(CLICK);
    await vi.waitFor(() => expect(value.refresh).toHaveBeenCalledTimes(1));
    expect(build.mock.calls).toStrictEqual([[{ action: "investPolicy", owner: PENSION, maxPerCall: "10000000", maxRolling30d: "50000000", enabled: true }]]);
  });

  it("sums the day-buckets of the trailing 31 days as the program does", () => {
    const now = 20_000 * 86_400 + 5;
    const days = new Array<number>(31).fill(0);
    const amounts = new Array<string>(31).fill("0");
    [days[0], amounts[0]] = [20_000, "1000000"];
    [days[1], amounts[1]] = [19_970, "2000000"];
    [days[2], amounts[2]] = [19_969, "4000000"];
    expect(usedInLast30Days(days, amounts, now)).toBe(3_000_000n);
  });
});
