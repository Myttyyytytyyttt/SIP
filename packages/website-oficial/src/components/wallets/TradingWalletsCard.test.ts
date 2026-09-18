// The trading wallets card: the one button that creates a wallet AND links it, rendered in each state the
// chain and Privy can put it in, and pressed. The environment is node with no DOM, so the ui Button is
// wrapped to remember each button as it renders and pressing one runs the component's real handler against
// mocked Privy — which is what proves the press goes on to the link instead of stopping at the create.

import { SIP_PROGRAM_ID } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PENSION_KEY, POLICY, SIGNER, TRADING_0, TRADING_1, embedded, phantom, userWith } from "../../../test/fixtures/privy-user";

const mocked = vi.hoisted(() => {
  function textOf(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (typeof node === "object" && node !== null && "props" in node) return textOf((node as { props: { children?: unknown } }).props.children);
    return "";
  }
  return {
    textOf,
    user: null as unknown,
    config: { privySignerId: null as string | null, privyPolicyId: null as string | null },
    wallets: [] as { address: string; standardWallet: unknown }[],
    buttons: [] as { label: string; disabled: boolean; onClick: ((event: unknown) => void) | undefined }[],
    createWallet: vi.fn(),
    refreshUser: vi.fn(),
    signTransaction: vi.fn(),
    signMessage: vi.fn(),
  };
});

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ready: true, authenticated: true, user: mocked.user }),
  useUser: () => ({ user: mocked.user, refreshUser: mocked.refreshUser }),
  useSigners: () => ({ addSigners: vi.fn(), removeSigners: vi.fn() }),
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useCreateWallet: () => ({ createWallet: mocked.createWallet }),
  useExportWallet: () => ({ exportWallet: vi.fn() }),
  useWallets: () => ({ ready: true, wallets: mocked.wallets }),
  useSignTransaction: () => ({ signTransaction: mocked.signTransaction }),
  useSignMessage: () => ({ signMessage: mocked.signMessage }),
}));

vi.mock("@/app/providers", () => ({ useSolanaConfig: () => mocked.config }));

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
import { CreateAndLinkNote, TradingWalletsCard } from "@/components/wallets/TradingWalletsCard";
import { VAULT_CARD_ID } from "@/components/wallets/VaultScreen";
import { VaultWriteLock, WriteLockContext, type WriteLock } from "@/hooks/use-vault-actions";
import { VaultScreenContext, type VaultScreenValue, type VaultView } from "@/hooks/use-vault-state";
import type { CreateAndLinkOutcome } from "@/lib/create-and-link";
import { MAX_TRADING_WALLETS } from "@/lib/trading-wallets";
import type { VaultApi, VaultStateJson } from "@/lib/vault-api";
import { CREATE_LINK_COPY, LINK_COPY } from "@/lib/vault-copy";

const CLICK = { type: "click", target: {} };
const VAULT = "Vau1tP1aceho1der111111111111111111111111111";
const LINK_RENT = "1305560";

type Chain = { vault?: "exists" | "missing" | "unreadable"; config?: "exists" | "missing" | "unreadable"; paused?: boolean };

function stateOf(chain: Chain = {}): VaultStateJson {
  const config = chain.config ?? "exists";
  return {
    owner: PENSION_KEY,
    programId: SIP_PROGRAM_ID,
    vault: { status: chain.vault ?? "exists", address: VAULT },
    policy: { status: "missing", address: VAULT },
    config: { address: VAULT, status: config, exists: config === "exists", paused: config === "exists" ? chain.paused === true : null },
    walletLinks: [],
    holdings: { status: "exists", items: [] },
    vaultTokenAccounts: { status: "exists", items: [] },
    rents: { vault: "1285240", link: LINK_RENT, policy: "5577840", tokenAccount: "1488440", legTokenAccounts: {} },
    prices: null,
  };
}

/** The screen's lock as it is when a link has been sent for `sent` and could not be confirmed. */
const lockAwaiting = (sent: readonly string[]): WriteLock => ({
  holder: null,
  consents: new Map(),
  unconfirmedLinks: new Set(sent),
  setUnconfirmedLink: () => {},
  acquire: () => true,
  release: () => {},
});

function render(
  view: VaultView,
  build = vi.fn(),
  /** Links this screen has sent and cannot confirm, as `<pensionKey>:<tradingAddress>`. */
  sent: readonly string[] = [],
): { html: string; build: typeof build; refresh: ReturnType<typeof vi.fn> } {
  mocked.buttons.length = 0;
  const refresh = vi.fn();
  const value: VaultScreenValue = { pensionKey: PENSION_KEY, view, refresh, api: { build } as unknown as VaultApi };
  const card = createElement(TradingWalletsCard);
  const held = sent.length === 0 ? createElement(VaultWriteLock, null, card) : createElement(WriteLockContext.Provider, { value: lockAwaiting(sent) }, card);
  const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(VaultScreenContext.Provider, { value }, held)));
  return { html, build, refresh };
}

const ready = (chain: Chain = {}): VaultView => ({ kind: "ready", state: stateOf(chain) });
/** A sentence as React renders it into HTML: apostrophes become entities. */
const asHtml = (text: string): string => text.replaceAll("'", "&#x27;");
const buttons = (label: string) => mocked.buttons.filter((button) => button.label === label);
const press = (label: string) => buttons(label)[0]?.onClick?.(CLICK);

beforeEach(() => {
  mocked.user = userWith([phantom()]);
  mocked.config = { privySignerId: SIGNER, privyPolicyId: POLICY };
  mocked.wallets = [
    { address: PENSION_KEY, standardWallet: {} },
    { address: TRADING_0, standardWallet: { isPrivyWallet: true } },
  ];
  for (const fn of [mocked.createWallet, mocked.refreshUser, mocked.signTransaction, mocked.signMessage]) fn.mockReset();
  mocked.refreshUser.mockImplementation(async () => mocked.user);
  mocked.createWallet.mockResolvedValue({ wallet: { address: TRADING_0 } });
});

describe("the one button, before it is pressed", () => {
  it("with a vault ready it says it will link too, and says what Phantom will ask and what it costs", () => {
    const { html } = render(ready());
    const [button] = buttons(CREATE_LINK_COPY.button);
    expect(button?.disabled).toBe(false);
    expect(buttons("Create wallet")).toHaveLength(0);
    // Requirement: Phantom's window opens partway through, so it is announced before the press, not after.
    expect(html).toContain("0.00130556 SOL of rent");
    expect(html).toContain("Phantom&#x27;s window opens partway through, after the wallet exists.");
  });

  it("with no vault it promises only what it will do: create the wallet, sign nothing, pay nothing", () => {
    const { html } = render(ready({ vault: "missing" }));
    expect(buttons(CREATE_LINK_COPY.buttonCreateOnly)).toHaveLength(1);
    expect(buttons(CREATE_LINK_COPY.button)).toHaveLength(0);
    expect(html).toContain("Nothing is signed and nothing is paid.");
    expect(html).toContain(asHtml(LINK_COPY.needsVault));
  });

  it.each<[Chain, string]>([
    [{ config: "missing" }, LINK_COPY.needsConfig],
    [{ paused: true }, LINK_COPY.paused],
  ])("says the chain's own reason when it cannot link (%o)", (chain, message) => {
    const { html } = render(ready(chain));
    expect(buttons(CREATE_LINK_COPY.buttonCreateOnly)).toHaveLength(1);
    expect(html).toContain(asHtml(message));
  });

  it("while the chain is still being read it offers the whole press, and the flow judges the chain after the create", () => {
    expect(render({ kind: "loading" }).html).toContain("Phantom&#x27;s window opens partway through");
    expect(buttons(CREATE_LINK_COPY.button)).toHaveLength(1);
  });

  it("the keeper's seat not configured: disabled, the variables named, and pressing it creates nothing", async () => {
    mocked.config = { privySignerId: null, privyPolicyId: null };
    const { html, build } = render(ready());
    const [button] = buttons(CREATE_LINK_COPY.button);
    expect(button?.disabled).toBe(true);
    expect(html).toMatch(/role="alert"[^>]*>[^<]*SIP_SOLANA_PRIVY_SIGNER_ID and SIP_SOLANA_PRIVY_POLICY_ID/);
    button?.onClick?.(CLICK);
    await vi.waitFor(() => expect(mocked.createWallet).not.toHaveBeenCalled());
    expect(build).not.toHaveBeenCalled();
  });

  it("ten wallets already: disabled with the count, and no promise of a link", () => {
    mocked.user = userWith([phantom(), ...Array.from({ length: MAX_TRADING_WALLETS }, (_, index) => embedded(`Fu11${index}`.padEnd(42, "x"), index, true))]);
    const { html } = render(ready());
    expect(buttons(CREATE_LINK_COPY.button)[0]?.disabled).toBe(true);
    expect(html).toContain("trading wallets for one account");
    expect(html).not.toContain("Phantom&#x27;s window opens partway through");
  });
});

describe("the press", () => {
  it("creates the wallet with the keeper's seat and goes straight on to the link, with no second click", async () => {
    const build = vi.fn().mockResolvedValue({ ok: false, status: 503, code: "upstream", body: null });
    render(ready(), build);
    press(CREATE_LINK_COPY.button);
    await vi.waitFor(() => expect(build).toHaveBeenCalled());
    expect(mocked.createWallet.mock.calls).toStrictEqual([[{ createAdditional: true, signers: [{ signerId: SIGNER, policyIds: [POLICY] }] }]]);
    // The link began of its own accord: the consent's preparation is the link flow's first request.
    expect(build.mock.calls[0]?.[0]).toMatchObject({ action: "prepareLink", owner: PENSION_KEY, wallet: TRADING_0 });
    // Privy's record is read again before the link, so the list holds the wallet either way.
    expect(mocked.refreshUser.mock.invocationCallOrder[0]).toBeLessThan(build.mock.invocationCallOrder[0] ?? 0);
  });

  it("stops before asking anyone for anything when there is no vault, and the wallet is still created", async () => {
    const { build } = render(ready({ vault: "missing" }));
    press(CREATE_LINK_COPY.buttonCreateOnly);
    await vi.waitFor(() => expect(mocked.refreshUser).toHaveBeenCalled());
    expect(mocked.createWallet).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
    expect(mocked.signMessage).not.toHaveBeenCalled();
    expect(mocked.signTransaction).not.toHaveBeenCalled();
  });

  it("a second wallet takes the same press, and the first is untouched", async () => {
    mocked.user = userWith([phantom(), embedded(TRADING_1, 0, true)]);
    mocked.createWallet.mockResolvedValue({ wallet: { address: TRADING_0 } });
    const build = vi.fn().mockResolvedValue({ ok: false, status: 503, code: "upstream", body: null });
    const { html } = render(ready(), build);
    expect(html).toContain(TRADING_1);
    press(CREATE_LINK_COPY.button);
    await vi.waitFor(() => expect(build).toHaveBeenCalled());
    expect(build.mock.calls[0]?.[0]).toMatchObject({ action: "prepareLink", wallet: TRADING_0 });
  });

  it("a link this screen sent and cannot confirm stops the press that would race it, and says so", () => {
    // A row sent it; the card is a different writer, so its own `unconfirmed` is false. Offering the whole
    // press here would sign and send a second link while the first may still land.
    const { html } = render(ready(), vi.fn(), [`${PENSION_KEY}:${TRADING_1}`]);
    expect(buttons(CREATE_LINK_COPY.button)[0]?.disabled).toBe(true);
    expect(html).toContain(CREATE_LINK_COPY.linkAwaiting);
  });

  it("another write already holds the screen: the button is disabled and says so", () => {
    // The lock is taken by the press itself; a render while it is held shows what a row's link would show.
    const { html } = render(ready());
    expect(html).not.toContain(LINK_COPY.busy);
    expect(buttons(CREATE_LINK_COPY.button)[0]?.disabled).toBe(false);
  });
});

describe("what the card says when the press stops", () => {
  const noteOf = (outcome: CreateAndLinkOutcome, vaultRent: bigint | null = 1_285_240n): string => {
    mocked.buttons.length = 0;
    return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(CreateAndLinkNote, { outcome, vaultRent })));
  };

  it("no vault: the wallet is created and said to be created, the vault is asked for, and the way there is a link to the form", () => {
    const html = noteOf({ created: TRADING_0, link: null, stop: { kind: "gate", message: LINK_COPY.needsVault, gate: "needs_vault" } });
    expect(html).toContain(asHtml(CREATE_LINK_COPY.created));
    expect(html).toContain(asHtml(CREATE_LINK_COPY.inTheList));
    expect(html).toContain(asHtml(CREATE_LINK_COPY.needsVaultTitle));
    expect(html).toContain("0.00128524 SOL of rent that never comes back");
    expect(html).toContain(`href="#${VAULT_CARD_ID}"`);
    expect(html).toContain(asHtml(CREATE_LINK_COPY.goToVault));
  });

  it("…and never claims the vault was made, nor offers to make one on the owner's behalf", () => {
    const html = noteOf({ created: TRADING_0, link: null, stop: { kind: "gate", message: LINK_COPY.needsVault, gate: "needs_vault" } });
    expect(html).toContain("SaverFi does not create one for you");
    expect(html).not.toMatch(/vault (was )?created/i);
  });

  it.each<[string, CreateAndLinkOutcome["stop"], string]>([
    ["the chain could not be read", { kind: "chain_unknown", message: CREATE_LINK_COPY.chainUnknown, gate: null }, CREATE_LINK_COPY.chainUnknown],
    ["this session cannot sign for it yet", { kind: "not_ready", message: CREATE_LINK_COPY.notReady, gate: null }, CREATE_LINK_COPY.notReady],
    ["the program is paused", { kind: "gate", message: LINK_COPY.paused, gate: "paused" }, LINK_COPY.paused],
  ])("%s: the wallet is created, said so, and the reason follows", (_name, stop, message) => {
    const html = noteOf({ created: TRADING_0, link: null, stop });
    expect(html).toContain(asHtml(CREATE_LINK_COPY.created));
    expect(html).toContain(asHtml(CREATE_LINK_COPY.inTheList));
    expect(html).toContain(asHtml(message));
    expect(html).not.toContain(`href="#${VAULT_CARD_ID}"`);
  });

  it("Privy named no wallet: nothing claims a wallet was created here, and the list is where to look", () => {
    const html = noteOf({ created: null, link: null, stop: { kind: "no_address", message: CREATE_LINK_COPY.noAddress, gate: null } });
    expect(html).not.toContain(asHtml(CREATE_LINK_COPY.created));
    expect(html).toContain(asHtml(CREATE_LINK_COPY.noAddress));
  });

  it("the keeper's seat is not configured: nothing was created, and nothing pretends otherwise", () => {
    const html = noteOf({ created: null, link: null, stop: { kind: "seat", message: "The keeper's seat is not configured.", gate: null } });
    expect(html).not.toContain(asHtml(CREATE_LINK_COPY.created));
    expect(html).toContain("The keeper&#x27;s seat is not configured.");
  });

  it("a closed Privy dialog is a choice, not a failure: the card says nothing", () => {
    expect(noteOf({ created: null, link: null, stop: { kind: "create", message: null, gate: null } })).toBe("");
  });

  it("the link itself stopped (Phantom declined, the relay refused): the wallet is created and safe, and the step's own words are the progress's", () => {
    const declined: CreateAndLinkOutcome = {
      created: TRADING_0,
      link: { ok: false, kind: "refused", message: "Phantom did not approve. Nothing was sent.", consentSignature: null },
      stop: null,
    };
    const html = noteOf(declined);
    expect(html).toContain(asHtml(CREATE_LINK_COPY.created));
    expect(html).toContain(asHtml(CREATE_LINK_COPY.inTheList));
    // Not repeated here: TxProgress already carries the refusal, with its title and its Dismiss.
    expect(html).not.toContain("Phantom did not approve");
  });

  it("a link that landed says nothing extra: the progress already says Linked", () => {
    const landed: CreateAndLinkOutcome = {
      created: TRADING_0,
      link: { ok: true, signature: "sig", explorerUrl: null, slot: null, unitsConsumed: null, consentSignature: null },
      stop: null,
    };
    expect(noteOf(landed)).toBe("");
  });
});
