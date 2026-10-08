// The overview tab: its derivations held as pure functions, then the tab rendered to HTML inside the
// mocks WalletsScreen.test.ts uses (Privy mocked, the ui Button wrapped to remember each button's label,
// disabled state and onClick), so what the tab renders is exactly what the whole screen will render.
//
// What it must never do is held here too: print a 0 nobody read, call a wallet "not linked" on a read
// that did not answer, or render anything the cards' own tests count (rows, ids, their buttons).

import { CATALOGUE, MODE_PROFIT, MODE_VOLUME, SIP_PROGRAM_ID, USDC_MINT } from "@sip/solana-core/client";
import { Keypair } from "@solana/web3.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORTED, PENSION_KEY, POLICY, SIGNER, TRADING_0, TRADING_1, TRADING_2, embedded, phantom, userWith } from "../../../test/fixtures/privy-user";

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
    refreshUser: vi.fn(),
  };
});

// THE SAME MOCK BLOCK AS WalletsScreen.test.ts: the overview may use no Privy hook that one does not mock.
vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ...mocked.privy, login: mocked.login, logout: mocked.logout }),
  useLogin: () => ({ login: mocked.login }),
  useUser: () => ({ user: mocked.privy.user, refreshUser: mocked.refreshUser }),
  useSigners: () => ({ addSigners: vi.fn(), removeSigners: vi.fn() }),
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useCreateWallet: () => ({ createWallet: vi.fn() }),
  useExportWallet: () => ({ exportWallet: vi.fn() }),
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
import {
  WalletsOverview,
  attentionOf,
  investingFace,
  nextStepSection,
  overviewOf,
  overviewWallets,
  symbolFor,
  useWalletsAttention,
  vaultFace,
  walletsFace,
  walletsToFix,
  withdrawFace,
  type OverviewWallet,
} from "@/components/wallets/WalletsOverview";
import { VaultWriteLock } from "@/hooks/use-vault-actions";
import { VaultScreenContext, type VaultScreenValue, type VaultView } from "@/hooks/use-vault-state";
import { LIVE_COPY } from "@/lib/live-copy";
import { SETTINGS_COPY } from "@/lib/settings-copy";
import type { VaultAccountJson, VaultApi, VaultStateJson } from "@/lib/vault-api";
import { OVERVIEW_COPY, VAULT_COPY, WALLETS_COPY, shortAddress } from "@/lib/vault-copy";
import type { WalletsSection } from "@/lib/wallets-sections";

const CLICK = { type: "click", target: {} };
const VAULT = Keypair.generate().publicKey.toBase58();
const STRANGER = Keypair.generate().publicKey.toBase58();
const LATE = Keypair.generate().publicKey.toBase58();
const SPYX = CATALOGUE.find((asset) => asset.symbol === "SPYx")!.mint;

function account(overrides: Partial<VaultAccountJson> = {}): VaultAccountJson {
  return {
    owner: PENSION_KEY,
    paused: false,
    skimMode: MODE_PROFIT,
    skimBps: 2000,
    volumeBps: 100,
    lifetimeSaved: "36600000",
    createdAt: "1758240000",
    maxContribution: "60000000",
    walletReserve: "50000000",
    policyNonce: "0",
    ...overrides,
  };
}

/** VaultCard.test.ts's template: no vault, no policy, nothing linked — read for the pension key. */
function stateWith(overrides: Partial<VaultStateJson> = {}): VaultStateJson {
  return {
    owner: PENSION_KEY,
    programId: SIP_PROGRAM_ID,
    vault: { status: "missing", address: VAULT },
    policy: { status: "missing", address: Keypair.generate().publicKey.toBase58() },
    config: { address: Keypair.generate().publicKey.toBase58(), status: "exists", exists: true, paused: false },
    walletLinks: [],
    holdings: { status: "exists", items: [] },
    vaultTokenAccounts: { status: "exists", items: [] },
    rents: { vault: "1285240", link: "1305560", policy: "5577840", tokenAccount: "1488440", legTokenAccounts: {} },
    prices: { slot: 1, convertWad: "100038711555492562", usdcRawPerSol: "100038711", legs: [{ symbol: "SPYx", mint: SPYX, wad: "1000000000000000000", usdcRawPer1e8: "100000000" }] },
    ...overrides,
  };
}

const vaultExists = (overrides: Partial<VaultAccountJson> = {}): VaultStateJson["vault"] => ({
  status: "exists",
  address: VAULT,
  lamports: "300000000",
  rentFloor: "1285240",
  withdrawableLamports: "298714760",
  state: account(overrides),
});

/** A stored investing rule; floors of 1 sit far under any price, so they buy on every route. */
function policyExists(enabled: boolean, legs: readonly string[] = [SPYX], minConvertRateWad = "1"): VaultStateJson["policy"] {
  return {
    status: "exists",
    address: Keypair.generate().publicKey.toBase58(),
    state: {
      vault: VAULT,
      enabled,
      venueProgram: Keypair.generate().publicKey.toBase58(),
      inMint: USDC_MINT,
      legs: legs.map((mint) => ({ mint, weightBps: Math.floor(10_000 / legs.length), minOutRateWad: "1" })),
      minConvertRateWad,
      minInvestment: "1000000",
      maxPerCall: "25000000",
      maxRolling30d: "250000000",
      bucketDays: [],
      bucketAmounts: [],
      lifetimeInvested: "0",
      policyNonce: "0",
    },
  };
}

const link = (wallet: string, status: VaultStateJson["walletLinks"][number]["status"]): VaultStateJson["walletLinks"][number] => ({
  wallet,
  link: Keypair.generate().publicKey.toBase58(),
  status,
  vault: status === "this_vault" ? VAULT : status === "other_vault" ? STRANGER : null,
});

const ready = (state: VaultStateJson): VaultView => ({ kind: "ready", state });
const seated = (address: string): OverviewWallet => ({ address, seat: "has-signer" });

/** A vault, investing set up, and one seated wallet linked to it: every setup step done. */
const allDone = (): VaultStateJson => stateWith({ vault: vaultExists(), policy: policyExists(true), walletLinks: [link(TRADING_1, "this_vault")] });

/** A tile past loading, for the face functions; a test that reaches here still loading has failed already. */
function loaded<T extends { readonly kind: string }>(tile: T): Exclude<T, { readonly kind: "loading" }> {
  if (tile.kind === "loading") throw new Error("still loading");
  return tile as Exclude<T, { readonly kind: "loading" }>;
}

describe("overviewOf: what the overview may say, and what it may not", () => {
  it("loading: every tile waits, no step is called missing, and no tab gets a dot", () => {
    const overview = overviewOf({ kind: "loading" }, [seated(TRADING_1)], PENSION_KEY);
    expect(overview.read).toBe("loading");
    expect([overview.vault.kind, overview.investing.kind, overview.withdraw.kind]).toEqual(["loading", "loading", "loading"]);
    expect(overview.steps).toBeNull();
    expect([...attentionOf(overview)]).toEqual([]);
    expect(overviewOf(null, [], PENSION_KEY).read).toBe("loading");
  });

  it("a ready state read for ANOTHER pension key is the previous key's answer: loading, not this key's vault", () => {
    const stale = stateWith({ owner: STRANGER, vault: { status: "unreadable", address: VAULT } });
    const overview = overviewOf(ready(stale), [], PENSION_KEY);
    expect(overview.read).toBe("loading");
    expect(overview.vault.kind).toBe("loading");
    expect(overview.steps).toBeNull();
    expect([...attentionOf(overview)]).toEqual([]);
  });

  it("the route did not answer: every figure is unread, the vault tab gets the dot, and a wallet's link is never called missing", () => {
    const overview = overviewOf({ kind: "unreadable", message: "x" }, [seated(TRADING_1), seated(TRADING_2)], PENSION_KEY);
    expect(overview.read).toBe("failed");
    expect([overview.vault.kind, overview.investing.kind, overview.withdraw.kind]).toEqual(["unreadable", "unreadable", "unreadable"]);
    expect(overview.steps).toBeNull();
    expect([...attentionOf(overview)]).toEqual(["vault"]);
    expect(overview.wallets.byStatus.checking).toBe(2);
    expect(overview.wallets.byStatus["not-linked"]).toBe(0);
    // No "0 of 2 linked": nobody read a link.
    expect(walletsFace(overview.wallets, overview.vault.kind)).toEqual({ value: OVERVIEW_COPY.walletsCount(2), figure: true, sub: OVERVIEW_COPY.walletsChecking(2) });
    for (const face of [vaultFace(loaded(overview.vault)), investingFace(loaded(overview.investing)), withdrawFace(loaded(overview.withdraw))]) {
      expect(face).toEqual({ value: OVERVIEW_COPY.notRead, figure: false, sub: OVERVIEW_COPY.couldNotRead });
    }
  });

  it("an answer whose vault read failed is a failed read too, though what it did read still counts", () => {
    const overview = overviewOf(ready(stateWith({ vault: { status: "unreadable", address: VAULT }, config: { address: VAULT, status: "exists", exists: true, paused: true } })), [], PENSION_KEY);
    expect(overview.read).toBe("failed");
    expect(overview.vault.kind).toBe("unreadable");
    expect(overview.investing.kind).toBe("unreadable");
    expect(overview.withdraw.kind).toBe("unreadable");
    expect(overview.protocolPaused).toBe(true);
    expect(overview.steps).toBeNull();
    expect(attentionOf(overview).has("vault")).toBe(true);
  });

  it("no vault: create it first; investing and taking money out wait for it; a wallet with no vault to link to is no dot", () => {
    const state = stateWith({ walletLinks: [link(TRADING_2, "missing")] });
    const overview = overviewOf(ready(state), [seated(TRADING_2)], PENSION_KEY);
    expect(overview.read).toBe("ready");
    expect(vaultFace(loaded(overview.vault))).toEqual({ value: OVERVIEW_COPY.vaultMissing, figure: false, sub: OVERVIEW_COPY.vaultMissingLine });
    expect(investingFace(loaded(overview.investing))).toEqual({ value: OVERVIEW_COPY.notRead, figure: false, sub: OVERVIEW_COPY.needsVault });
    expect(withdrawFace(loaded(overview.withdraw))).toEqual({ value: OVERVIEW_COPY.notRead, figure: false, sub: OVERVIEW_COPY.needsVault });
    expect(overview.steps).toEqual([false, true, false, false]);
    expect(walletsToFix(overview)).toBeNull();
    expect([...attentionOf(overview)]).toEqual([]);
  });

  it("wallets and no vault yet: counted, and said to link once the vault exists — never 'being checked'", () => {
    const overview = overviewOf(ready(stateWith()), [seated(TRADING_1)], PENSION_KEY);
    expect(overview.vault.kind).toBe("missing");
    expect(overview.wallets.byStatus.checking).toBe(1);
    expect(walletsFace(overview.wallets, overview.vault.kind)).toEqual({ value: OVERVIEW_COPY.walletsCount(1), figure: true, sub: OVERVIEW_COPY.walletsNeedVault });
  });

  it("no vault yet, and a wallet that will not simply link once it exists: no permission, or linked to another vault, said first", () => {
    const noSeat = overviewOf(ready(stateWith()), [{ address: TRADING_1, seat: "missing" }], PENSION_KEY);
    expect(walletsFace(noSeat.wallets, noSeat.vault.kind).sub).toBe(OVERVIEW_COPY.walletsNeedPermission(1));
    const elsewhere = overviewOf(ready(stateWith({ walletLinks: [link(TRADING_1, "other_vault")] })), [seated(TRADING_1)], PENSION_KEY);
    expect(walletsFace(elsewhere.wallets, elsewhere.vault.kind).sub).toBe(OVERVIEW_COPY.walletsElsewhere(1));
  });

  it("the link step is never called missing on a link the read did not answer: the setup list waits instead", () => {
    const policy = policyExists(true);
    // The one wallet's link came back unreadable: it may well be linked, so no step is claimed either way.
    const unread = overviewOf(ready(stateWith({ vault: vaultExists(), policy, walletLinks: [link(TRADING_1, "unreadable")] })), [seated(TRADING_1)], PENSION_KEY);
    expect(unread.steps).toBeNull();
    // A wallet too new to have been asked about: the same.
    const tooNew = overviewOf(ready(stateWith({ vault: vaultExists(), policy, walletLinks: [] })), [seated(TRADING_1)], PENSION_KEY);
    expect(tooNew.steps).toBeNull();
    // One linked wallet answers the step, whatever the others' reads said.
    const oneLinked = overviewOf(
      ready(stateWith({ vault: vaultExists(), policy, walletLinks: [link(TRADING_1, "this_vault"), link(TRADING_2, "unreadable")] })),
      [seated(TRADING_1), seated(TRADING_2)],
      PENSION_KEY,
    );
    expect(oneLinked.steps).toEqual([true, true, true, true]);
    // No vault: nothing can be linked to it, so the step is known to be missing even with no link read.
    const noVault = overviewOf(ready(stateWith({ walletLinks: [] })), [seated(TRADING_1)], PENSION_KEY);
    expect(noVault.steps).toEqual([false, true, false, false]);
    // Every link answered, none here: the step is honestly not done.
    const answered = overviewOf(ready(stateWith({ vault: vaultExists(), policy, walletLinks: [link(TRADING_1, "missing")] })), [seated(TRADING_1)], PENSION_KEY);
    expect(answered.steps).toEqual([true, true, false, true]);
  });

  it("a vault and no trading wallets: none yet, said as where they come from; the next step is a wallet", () => {
    const overview = overviewOf(ready(stateWith({ vault: vaultExists() })), [], PENSION_KEY);
    expect(walletsFace(overview.wallets, overview.vault.kind)).toEqual({ value: OVERVIEW_COPY.walletsNone, figure: false, sub: OVERVIEW_COPY.walletsNoneLine });
    expect(overview.steps).toEqual([true, false, false, false]);
    expect([...attentionOf(overview)]).toEqual([]);
  });

  it("the vault's tile: its balance in SOL, its mode and rate as the vault card says them, and what it has saved", () => {
    const profit = vaultFace(loaded(overviewOf(ready(stateWith({ vault: vaultExists() })), [], PENSION_KEY).vault));
    expect(profit).toEqual({ value: "0.3 SOL", figure: true, sub: "Profit · 20 % · saved so far 0.0366 SOL", paused: false, exact: "0.3 SOL" });
    const volume = vaultFace(loaded(overviewOf(ready(stateWith({ vault: vaultExists({ skimMode: MODE_VOLUME, paused: true }) })), [], PENSION_KEY).vault));
    // The rate of the mode the vault measures, never the other one.
    expect(volume).toEqual({ value: "0.3 SOL", figure: true, sub: "Volume · 1 % · saved so far 0.0366 SOL", paused: true, exact: "0.3 SOL" });
    // A balance the answer did not carry is a dash, not 0 SOL.
    const { lamports: _lamports, ...noBalance } = vaultExists();
    expect(vaultFace(loaded(overviewOf(ready(stateWith({ vault: noBalance })), [], PENSION_KEY).vault)).value).toBe(OVERVIEW_COPY.notRead);
  });

  it("each wallet once, by the status its row shows — a wallet missing from the read is being checked, never 'not linked'", () => {
    const wallets: OverviewWallet[] = [
      { address: TRADING_0, seat: "missing" },
      seated(TRADING_1),
      seated(TRADING_2),
      seated(IMPORTED),
      seated(STRANGER),
      { address: LATE, seat: "unknown" },
    ];
    const state = stateWith({
      vault: vaultExists(),
      walletLinks: [link(TRADING_0, "this_vault"), link(TRADING_1, "this_vault"), link(TRADING_2, "missing"), link(IMPORTED, "other_vault"), link(LATE, "this_vault")],
    });
    const overview = overviewOf(ready(state), wallets, PENSION_KEY);
    expect(overview.wallets.byStatus).toEqual({ "needs-permission": 1, linked: 1, "not-linked": 1, elsewhere: 1, checking: 2, paused: 0 });
    // Linked is what the chain says, whatever the seat: TRADING_0 needs permission AND is linked.
    expect(overview.wallets.linked).toBe(3);
    expect(walletsFace(overview.wallets, overview.vault.kind)).toEqual({ value: OVERVIEW_COPY.walletsLinked(3, 6), figure: true, sub: OVERVIEW_COPY.walletsNeedPermission(1) });
    expect(walletsToFix(overview)).toEqual({ needPermission: 1, notLinked: 1 });
    expect(attentionOf(overview).has("trading")).toBe(true);
  });

  it("the wallets' line, most pressing first: permission, then a missing link, then a check, then another vault, then all linked", () => {
    const face = (wallets: OverviewWallet[], links: VaultStateJson["walletLinks"]) =>
      walletsFace(overviewOf(ready(stateWith({ vault: vaultExists(), walletLinks: links })), wallets, PENSION_KEY).wallets, "exists");
    expect(face([seated(TRADING_1), seated(TRADING_2)], [link(TRADING_1, "this_vault"), link(TRADING_2, "missing")]).sub).toBe(OVERVIEW_COPY.walletsNotLinked(1));
    expect(face([seated(TRADING_1), seated(TRADING_2)], [link(TRADING_1, "this_vault"), link(TRADING_2, "unreadable")]).sub).toBe(OVERVIEW_COPY.walletsChecking(1));
    expect(face([seated(TRADING_1), seated(TRADING_2)], [link(TRADING_1, "this_vault"), link(TRADING_2, "other_vault")]).sub).toBe(OVERVIEW_COPY.walletsElsewhere(1));
    expect(face([seated(TRADING_1), seated(TRADING_2)], [link(TRADING_1, "this_vault"), link(TRADING_2, "this_vault")])).toEqual({ value: "2 of 2 linked", figure: true, sub: OVERVIEW_COPY.walletsAllLinked });
    // Only wallets that are checking or elsewhere: nothing to fix from the Trading wallets tab, so no dot.
    const calm = overviewOf(ready(stateWith({ vault: vaultExists(), walletLinks: [link(TRADING_1, "other_vault")] })), [seated(TRADING_1), seated(TRADING_2)], PENSION_KEY);
    expect(attentionOf(calm).has("trading")).toBe(false);
  });

  it("a paused vault and a paused SaverFi are said apart, and a linked wallet then reads paused", () => {
    const wallets = [seated(TRADING_1)];
    const links = [link(TRADING_1, "this_vault")];
    const vaultPaused = overviewOf(ready(stateWith({ vault: vaultExists({ paused: true }), walletLinks: links })), wallets, PENSION_KEY);
    expect([vaultPaused.vaultPaused, vaultPaused.protocolPaused]).toEqual([true, false]);
    expect(vaultPaused.wallets.byStatus.paused).toBe(1);
    // Still linked: the pause is its own row, not a wallet to fix.
    expect(walletsFace(vaultPaused.wallets, vaultPaused.vault.kind).sub).toBe(OVERVIEW_COPY.walletsAllLinked);
    expect(attentionOf(vaultPaused).size).toBe(0);

    const protocolPaused = overviewOf(
      ready(stateWith({ vault: vaultExists(), walletLinks: links, config: { address: VAULT, status: "exists", exists: true, paused: true } })),
      wallets,
      PENSION_KEY,
    );
    expect([protocolPaused.vaultPaused, protocolPaused.protocolPaused]).toEqual([false, true]);
    expect(protocolPaused.wallets.byStatus.paused).toBe(1);
  });

  it("investing: not set up, on, paused — with the basket's symbols — or unread", () => {
    const of = (policy: VaultStateJson["policy"]) => overviewOf(ready(stateWith({ vault: vaultExists(), policy })), [], PENSION_KEY);
    const missing = of({ status: "missing", address: VAULT });
    expect(investingFace(loaded(missing.investing))).toEqual({ value: OVERVIEW_COPY.investingMissing, figure: false, sub: OVERVIEW_COPY.investingMissingLine });
    expect(missing.steps?.[3]).toBe(false);

    const unknownMint = Keypair.generate().publicKey.toBase58();
    const on = of(policyExists(true, [SPYX, unknownMint]));
    expect(investingFace(loaded(on.investing))).toEqual({ value: OVERVIEW_COPY.investingOn, figure: false, sub: `SPYx · ${shortAddress(unknownMint)}` });
    expect(on.steps?.[3]).toBe(true);

    expect(investingFace(loaded(of(policyExists(false)).investing))).toEqual({ value: OVERVIEW_COPY.investingPaused, figure: false, sub: "SPYx" });

    const unread = of({ status: "unreadable", address: VAULT });
    expect(unread.investing.kind).toBe("unreadable");
    // Investing unread: whether it is set up is not known, so no step list is offered.
    expect(unread.steps).toBeNull();
  });

  it("a basket still carrying price limits puts a dot on Investing, blocking or not; a live-price basket does not", () => {
    // policyExists signs every floor at 1 wad: what a policy signed since 2026-10-08 carries.
    const live = overviewOf(ready(stateWith({ vault: vaultExists(), policy: policyExists(true) })), [], PENSION_KEY);
    expect(live.priceLimits).toBeNull();
    expect(attentionOf(live).has("investing")).toBe(false);

    // An old SOL floor far under today's price: a limit, not stopping anything.
    const held = overviewOf(ready(stateWith({ vault: vaultExists(), policy: policyExists(true, [SPYX], "2") })), [], PENSION_KEY);
    expect(held.priceLimits).toBe("held");
    expect([...attentionOf(held)]).toEqual(["investing"]);

    const passed = overviewOf(ready(stateWith({ vault: vaultExists(), policy: policyExists(true, [SPYX], "999999999999999999999") })), [], PENSION_KEY);
    expect(passed.priceLimits).toBe("blocking");
    expect([...attentionOf(passed)]).toEqual(["investing"]);
  });

  it("taking money out: what can be withdrawn, and the tokens beside it only when a read found them", () => {
    const holding = (mint: string, amountRaw: string) => ({ tokenAccount: Keypair.generate().publicKey.toBase58(), mint, amountRaw, decimals: 8, uiAmount: "1", tokenProgram: VAULT });
    const of = (overrides: Partial<VaultStateJson>) => withdrawFace(loaded(overviewOf(ready(stateWith({ vault: vaultExists(), ...overrides })), [], PENSION_KEY).withdraw));

    // A glance rounds to four places; the exact figure rides along for the tile's title.
    expect(of({})).toEqual({ value: "0.2987 SOL", figure: true, sub: OVERVIEW_COPY.withdrawLine, exact: "0.29871476 SOL" });
    expect(of({ holdings: { status: "exists", items: [holding(SPYX, "5"), holding(USDC_MINT, "0")] } }).sub).toBe(OVERVIEW_COPY.withdrawTokens(1));
    expect(of({ holdings: { status: "exists", items: [holding(SPYX, "5"), holding(USDC_MINT, "7")] } }).sub).toBe("+ 2 tokens in your vault");
    expect(of({ holdings: { status: "unreadable", items: [] }, vaultTokenAccounts: { status: "unreadable", items: [] } }).sub).toBe(OVERVIEW_COPY.tokensUnread);
    const { withdrawableLamports: _withdrawable, ...noWithdrawable } = vaultExists();
    expect(of({ vault: noWithdrawable })).toEqual({ value: OVERVIEW_COPY.notRead, figure: false, sub: OVERVIEW_COPY.withdrawLine });
  });

  it("every step done: the setup list has nothing left to say", () => {
    expect(overviewOf(ready(allDone()), [seated(TRADING_1)], PENSION_KEY).steps).toEqual([true, true, true, true]);
  });
});

describe("the helpers the overview reads through", () => {
  it("Privy's trading wallets, never the pension key, each with its seat from Privy's record", () => {
    const user = userWith([phantom(), embedded(TRADING_0, 0, false), embedded(TRADING_1, 1, true), embedded(PENSION_KEY, 2, true)]);
    expect(overviewWallets(user, PENSION_KEY)).toEqual([
      { address: TRADING_0, seat: "missing" },
      { address: TRADING_1, seat: "has-signer" },
    ]);
    expect(overviewWallets(null, PENSION_KEY)).toEqual([]);
  });

  it("names a mint by the app's symbol or the catalogue's, and otherwise shortens it rather than inventing a ticker", () => {
    for (const asset of CATALOGUE) expect(symbolFor(asset.mint)).toBe(asset.symbol);
    expect(symbolFor(USDC_MINT)).toBe("USDC");
    expect(symbolFor(STRANGER)).toBe(shortAddress(STRANGER));
  });
});

describe("OVERVIEW_COPY", () => {
  /** Every string the object can produce: the literals, and each function called with sample arguments. */
  function sentences(): string[] {
    // Each function is called with arguments of its own arity, so a word like "undefined" in the output is a real fault.
    const samples: unknown[][] = [[0], [1], [3], ["Investing"], [1, 0], [0, 2], [2, 1], [3, 5], ["Profit", "20 %", "0.0366"], ["Volume", "1 %", null]];
    const out: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") out.push(value);
      else if (typeof value === "function") {
        for (const args of samples.filter((sample) => sample.length === value.length)) {
          const produced = (value as (...rest: unknown[]) => unknown)(...args);
          if (typeof produced === "string") out.push(produced);
        }
      } else if (value !== null && typeof value === "object") for (const entry of Object.values(value)) walk(entry);
    };
    walk(OVERVIEW_COPY);
    return out;
  }

  it("says SaverFi and plain words: never the keeper, the code name, an account's jargon, 'policy' or 'bps'", () => {
    const all = sentences();
    expect(all.length).toBeGreaterThan(40);
    expect(all.filter((sentence) => /\bkeeper\b|\bSIP\b|\bPDA\b|polic(y|ies)|\bbps\b|nuvem|undefined|null|NaN|[áéíóúñ¿¡]/i.test(sentence))).toEqual([]);
  });

  it("counts in English: one wallet, two wallets", () => {
    expect(OVERVIEW_COPY.walletsToFix(1, 0)).toBe("1 trading wallet needs your permission before anything can be saved from it.");
    expect(OVERVIEW_COPY.walletsToFix(0, 2)).toBe("2 trading wallets are not linked to your vault, so nothing they gain is put aside.");
    expect(OVERVIEW_COPY.walletsToFix(2, 1)).toBe("2 trading wallets need your permission and 1 is not linked to your vault, so nothing is put aside from them yet.");
    expect(OVERVIEW_COPY.walletsNeedPermission(1)).toBe("1 needs your permission");
    expect(OVERVIEW_COPY.withdrawTokens(1)).toBe("+ 1 token in your vault");
  });

  it("says where the vault's pause is turned back on, since the overview offers no switch for it", () => {
    expect(OVERVIEW_COPY.vaultPaused).toContain(SETTINGS_COPY.title);
    expect(OVERVIEW_COPY.vaultPaused).toMatch(/gear/);
  });
});

// ── the tab, rendered ───────────────────────────────────────────────────────

/** Buttons the cards own, and that WalletsScreen.test.ts counts exactly in the same render. */
const CARD_BUTTONS = ["Export key", "Grant SaverFi permission", "Check again", "Re-seat", "Create wallet and link it", "Create vault", "Link to vault", "Withdraw SOL", "Sign again", "Retry"];
const CARD_IDS = ['id="vault"', 'id="vault-max-contribution"', 'id="withdraw-sol-amount"', 'id="invest-'];

const refresh = vi.fn();
const onSelect = vi.fn<(section: WalletsSection) => void>();
const onDisconnect = vi.fn();

function screen(view: VaultView): VaultScreenValue {
  return { pensionKey: PENSION_KEY, view, refresh, api: {} as VaultApi };
}

function wrap(view: VaultView, child: ReturnType<typeof createElement>): string {
  mocked.buttons.length = 0;
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(VaultScreenContext.Provider, { value: screen(view) }, createElement(VaultWriteLock, null, child))));
}

const render = (view: VaultView): string => wrap(view, createElement(WalletsOverview, { pensionKey: PENSION_KEY, onDisconnect, onSelect }));
const buttons = (label: string) => mocked.buttons.filter((button) => button.label === label);
/** The labelled ui Buttons rendered: the address line's icon buttons (copy, Solscan) carry no text and are left out. */
const labels = (): string[] => mocked.buttons.map((button) => button.label).filter((label) => label !== "");
const tiles = (html: string): string[] => [...html.matchAll(/data-overview-tile="([a-z]+)"/g)].map((match) => match[1] ?? "");
const count = (html: string, needle: string): number => html.split(needle).length - 1;
/** "0 SOL" as a figure of its own — not the end of 10 SOL or 0.30 SOL. */
const ZERO_SOL = /(^|[^0-9.,])0 SOL/;

function Probe() {
  return [...useWalletsAttention()].sort().join(",");
}

beforeEach(() => {
  mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), embedded(TRADING_1, 1, true)]) };
  mocked.config = { privySignerId: SIGNER, privyPolicyId: POLICY };
  for (const fn of [refresh, onSelect, onDisconnect, mocked.login, mocked.logout, mocked.refreshUser]) fn.mockReset();
});

describe("WalletsOverview", () => {
  it("shows the four tiles in the rail's order, each the tab it opens, and the pension key once with one Disconnect", () => {
    const html = render(ready(allDone()));
    expect(tiles(html)).toEqual(["vault", "trading", "investing", "withdraw"]);
    for (const section of ["vault", "trading", "investing", "withdraw"] as const) expect(html).toContain(WALLETS_COPY.tabs[section]);
    expect(count(html, `>${OVERVIEW_COPY.pensionKey}<`)).toBe(1);
    expect(count(html, `>${PENSION_KEY}<`)).toBe(1);
    const disconnects = buttons(OVERVIEW_COPY.disconnect);
    expect(disconnects).toHaveLength(1);
    disconnects[0]?.onClick?.(CLICK);
    expect(onDisconnect.mock.calls).toStrictEqual([[]]);
    // A tile is a native button: none of them is among the ui Buttons the screen's test records.
    expect(labels()).toEqual([OVERVIEW_COPY.disconnect]);
    expect(html).toContain("0.3 SOL");
    expect(html).toContain("1 of 1 linked");
  });

  it("while the read is loading: the pension key, tiles as skeletons of the same shape, no figure and no setup list", () => {
    const html = render({ kind: "loading" });
    expect(tiles(html)).toEqual([]);
    // Said out loud: a status region with a spoken line, not an aria-label on a plain div.
    expect(html).toContain('role="status"');
    expect(html).toContain(`<span class="sr-only">${OVERVIEW_COPY.tilesLoading}</span>`);
    expect(count(html, `>${PENSION_KEY}<`)).toBe(1);
    expect(html).not.toContain(OVERVIEW_COPY.setupTitle);
    expect(html).not.toMatch(ZERO_SOL);
    // Outside any VaultScreen too: loading, never a crash.
    mocked.buttons.length = 0;
    const bare = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(WalletsOverview, { pensionKey: PENSION_KEY, onDisconnect, onSelect })));
    expect(tiles(bare)).toEqual([]);
  });

  it("a failed read says so in red, prints no 0 SOL, and Read again reads again", () => {
    for (const view of [{ kind: "unreadable", message: "x" } as const, ready(stateWith({ vault: { status: "unreadable", address: VAULT } }))]) {
      const html = render(view);
      expect(html).toMatch(new RegExp(`role="alert"[^>]*>${OVERVIEW_COPY.readFailed}<`));
      expect(html).not.toMatch(ZERO_SOL);
      expect(html).toContain(OVERVIEW_COPY.couldNotRead);
      expect(tiles(html)).toHaveLength(4);
      expect(html).not.toContain(OVERVIEW_COPY.setupTitle);
      const again = buttons(OVERVIEW_COPY.readAgain);
      expect(again).toHaveLength(1);
      refresh.mockReset();
      again[0]?.onClick?.(CLICK);
      expect(refresh).toHaveBeenCalledTimes(1);
    }
  });

  it("while a step is missing, lists the four and offers one way on: the first missing step's tab", () => {
    const noVault = render(ready(stateWith()));
    expect(noVault).toContain(OVERVIEW_COPY.setupTitle);
    for (const step of LIVE_COPY.noVault.steps) expect(noVault).toContain(step);
    const goVault = buttons(OVERVIEW_COPY.goTo(WALLETS_COPY.tabs.vault));
    expect(goVault).toHaveLength(1);
    expect(mocked.buttons.filter((button) => button.label.startsWith("Go to"))).toHaveLength(1);
    goVault[0]?.onClick?.(CLICK);
    expect(onSelect.mock.calls).toStrictEqual([["vault"]]);

    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom()]) };
    render(ready(stateWith({ vault: vaultExists() })));
    const goTrading = buttons(OVERVIEW_COPY.goTo(WALLETS_COPY.tabs.trading));
    expect(goTrading).toHaveLength(1);
    onSelect.mockReset();
    goTrading[0]?.onClick?.(CLICK);
    expect(onSelect.mock.calls).toStrictEqual([["trading"]]);
  });

  it("one way into each tab: a wallet row whose tab the setup list already points at keeps its sentence and drops its button", () => {
    // A vault, two wallets, none linked yet: the row says so, and "Getting set up" ends in the same tab.
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), embedded(TRADING_1, 1, true), embedded(TRADING_2, 2, true)]) };
    const html = render(ready(stateWith({ vault: vaultExists(), walletLinks: [link(TRADING_1, "missing"), link(TRADING_2, "missing")] })));
    expect(html).toContain(OVERVIEW_COPY.walletsToFix(0, 2));
    expect(html).toContain(OVERVIEW_COPY.setupTitle);
    expect(buttons(OVERVIEW_COPY.goTo(WALLETS_COPY.tabs.trading))).toHaveLength(1);
    expect(nextStepSection([true, true, false, false])).toBe("trading");
    expect(nextStepSection([true, true, true, true])).toBeNull();
    expect(nextStepSection(null)).toBeNull();
  });

  it("with every step done, the setup list is gone, and so is every notice", () => {
    const html = render(ready(allDone()));
    expect(html).not.toContain(OVERVIEW_COPY.setupTitle);
    expect(html).not.toContain('role="alert"');
    expect(mocked.buttons.filter((button) => button.label.startsWith("Go to"))).toHaveLength(0);
  });

  it("the pauses are said, with where the vault's is turned back on, and offer no control of their own", () => {
    const html = render(
      ready(stateWith({ vault: vaultExists({ paused: true }), policy: policyExists(true), walletLinks: [link(TRADING_1, "this_vault")], config: { address: VAULT, status: "exists", exists: true, paused: true } })),
    );
    expect(html).toContain(OVERVIEW_COPY.vaultPaused);
    expect(html).toContain(OVERVIEW_COPY.protocolPaused);
    expect(html).toContain(`>${VAULT_COPY.paused}<`);
    expect(labels()).toEqual([OVERVIEW_COPY.disconnect]);
  });

  it("old price limits to switch from, and a wallet to fix, each send to their own tab", () => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), embedded(TRADING_1, 1, true), embedded(TRADING_0, 0, false)]) };
    const html = render(
      ready(stateWith({ vault: vaultExists(), policy: policyExists(true, [SPYX], "999999999999999999999"), walletLinks: [link(TRADING_1, "this_vault"), link(TRADING_0, "this_vault")] })),
    );
    expect(html).toContain(SETTINGS_COPY.switchLiveBlocking.replaceAll("'", "&#x27;"));
    expect(html).toContain(OVERVIEW_COPY.walletsToFix(1, 0));
    const investing = buttons(OVERVIEW_COPY.goTo(WALLETS_COPY.tabs.investing));
    const trading = buttons(OVERVIEW_COPY.goTo(WALLETS_COPY.tabs.trading));
    expect([investing.length, trading.length]).toEqual([1, 1]);
    investing[0]?.onClick?.(CLICK);
    trading[0]?.onClick?.(CLICK);
    expect(onSelect.mock.calls).toStrictEqual([["investing"], ["trading"]]);
  });

  it("renders nothing the cards own: no wallet rows, no card ids, none of their buttons", () => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), embedded(TRADING_0, 0, false), embedded(TRADING_1, 1, true), embedded(TRADING_2, 2, true)]) };
    const views: VaultView[] = [
      { kind: "loading" },
      { kind: "unreadable", message: "x" },
      ready(stateWith()),
      ready(stateWith({ vault: vaultExists(), walletLinks: [link(TRADING_2, "missing")] })),
      ready(allDone()),
    ];
    for (const view of views) {
      const html = render(view);
      expect(html).not.toContain("data-seat");
      for (const id of CARD_IDS) expect(html).not.toContain(id);
      expect(mocked.buttons.filter((button) => CARD_BUTTONS.includes(button.label))).toEqual([]);
    }
  });
});

describe("useWalletsAttention", () => {
  const dots = (view: VaultView): string => wrap(view, createElement(Probe));

  it("reads the same screen as the overview: the vault on a failed read, Investing and Trading wallets when theirs need doing", () => {
    expect(dots({ kind: "loading" })).toBe("");
    expect(dots({ kind: "unreadable", message: "x" })).toBe("vault");
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), embedded(TRADING_1, 1, true)]) };
    expect(dots(ready(allDone()))).toBe("");
    expect(dots(ready(stateWith({ vault: vaultExists(), policy: policyExists(true, [SPYX], "999999999999999999999"), walletLinks: [link(TRADING_1, "missing")] })))).toBe("investing,trading");
  });

  it("gives no dot outside a vault screen", () => {
    expect(renderToStaticMarkup(createElement(Probe))).toBe("");
  });
});
