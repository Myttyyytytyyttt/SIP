// A trading wallet's row with its link control, rendered to HTML with Privy mocked and the
// screen's chain state given, in each state the chain can put a link in.

import { SIP_PROGRAM_ID } from "@sip/solana-core/client";
import { Keypair } from "@solana/web3.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PENSION_KEY, POLICY, SIGNER, TRADING_0, embedded, phantom, userWith } from "../../../test/fixtures/privy-user";

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
    buttons: [] as { label: string; disabled: boolean; onClick: ((event: unknown) => void) | undefined }[],
    signTransaction: vi.fn(),
    signMessage: vi.fn(),
  };
});

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ready: true, authenticated: true, user: mocked.user }),
  useUser: () => ({ user: mocked.user, refreshUser: vi.fn() }),
  useSigners: () => ({ addSigners: vi.fn(), removeSigners: vi.fn() }),
}));

vi.mock("@privy-io/react-auth/solana", () => ({
  useExportWallet: () => ({ exportWallet: vi.fn() }),
  useWallets: () => ({ ready: true, wallets: [] }),
  useSignTransaction: () => ({ signTransaction: mocked.signTransaction }),
  useSignMessage: () => ({ signMessage: mocked.signMessage }),
}));

vi.mock("@/app/providers", () => ({ useSolanaConfig: () => ({ privySignerId: "kyio853439oa78qfvmt853i4", privyPolicyId: "jsuzcjv6njl0raqjjhzqe9fh" }) }));

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
import { TradingWalletRow } from "@/components/wallets/TradingWalletRow";
import { VaultWriteLock, WriteLockContext, type WriteLock } from "@/hooks/use-vault-actions";
import { VaultScreenContext, type VaultScreenValue } from "@/hooks/use-vault-state";
import type { VaultApi, VaultStateJson, WalletLinkStatus } from "@/lib/vault-api";
import { CREATE_LINK_COPY, LINK_COPY } from "@/lib/vault-copy";

const CLICK = { type: "click", target: {} };
const LINK = Keypair.generate().publicKey.toBase58();
const OTHER_WALLET = Keypair.generate().publicKey.toBase58();
const VAULT = Keypair.generate().publicKey.toBase58();

type Chain = { vault?: "exists" | "missing" | "unreadable"; config?: "exists" | "missing" | "unreadable"; paused?: boolean; link?: WalletLinkStatus | "absent"; wallet?: string };

function stateOf(chain: Chain): VaultStateJson {
  const config = chain.config ?? "exists";
  return {
    owner: PENSION_KEY,
    programId: SIP_PROGRAM_ID,
    vault: { status: chain.vault ?? "exists", address: VAULT },
    policy: { status: "missing", address: Keypair.generate().publicKey.toBase58() },
    config: { address: Keypair.generate().publicKey.toBase58(), status: config, exists: config === "exists", paused: config === "exists" ? chain.paused === true : null },
    walletLinks:
      chain.link === "absent"
        ? []
        : [{ wallet: chain.wallet ?? TRADING_0, link: LINK, status: chain.link ?? "missing", vault: chain.link === "this_vault" ? VAULT : null }],
    holdings: { status: "exists", items: [] },
    vaultTokenAccounts: { status: "exists", items: [] },
    rents: { vault: "1285240", link: "1305560", policy: "5577840", tokenAccount: "1488440", legTokenAccounts: {} },
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
  chain: Chain,
  address: string = TRADING_0,
  build = vi.fn(),
  /** Links this screen has sent and cannot confirm, as `<pensionKey>:<tradingAddress>`. */
  sent: readonly string[] = [],
): { html: string; build: typeof build; refresh: ReturnType<typeof vi.fn> } {
  mocked.buttons.length = 0;
  const refresh = vi.fn();
  const value: VaultScreenValue = { pensionKey: PENSION_KEY, view: { kind: "ready", state: stateOf(chain) }, refresh, api: { build } as unknown as VaultApi };
  const row = { address, id: null, walletIndex: 0, imported: false, listed: true };
  const rows = createElement("ul", null, createElement(TradingWalletRow, { row }));
  const held = sent.length === 0 ? createElement(VaultWriteLock, null, rows) : createElement(WriteLockContext.Provider, { value: lockAwaiting(sent) }, rows);
  const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(VaultScreenContext.Provider, { value }, held)));
  return { html, build, refresh };
}

const buttons = (label: string) => mocked.buttons.filter((button) => button.label === label);

beforeEach(() => {
  mocked.user = userWith([phantom(), embedded(TRADING_0, 0, true)]);
  mocked.signTransaction.mockReset();
  mocked.signMessage.mockReset();
});

describe("TradingWalletRow's link control", () => {
  it("the program not configured: Link to vault is disabled and says why", () => {
    const { html } = render({ config: "missing" });
    expect(buttons("Link to vault").map((button) => button.disabled)).toEqual([true]);
    expect(html).toContain("Linking opens once SaverFi&#x27;s program is configured on Solana. Your vault, investing and withdrawals already work.");
  });

  it("no vault, or a paused protocol: disabled with its reason", () => {
    expect(render({ vault: "missing" }).html).toContain("Create your vault first.");
    expect(buttons("Link to vault")[0]?.disabled).toBe(true);
    expect(render({ paused: true }).html).toContain("SaverFi is paused, so linking waits. Withdrawals still work.");
    expect(buttons("Link to vault")[0]?.disabled).toBe(true);
  });

  it("a wallet saving into another vault gets words and no button", () => {
    const { html } = render({ link: "other_vault" });
    expect(html).toContain("This wallet saves into another vault. Only that vault&#x27;s owner can unlink it.");
    expect(buttons("Link to vault")).toHaveLength(0);
  });

  it("a wallet linked to this vault: the badge and the link on Solscan, no button", () => {
    const { html } = render({ link: "this_vault" });
    expect(html).toContain("Linked to your vault");
    expect(html).toContain(`href="https://solscan.io/account/${LINK}"`);
    expect(buttons("Link to vault")).toHaveLength(0);
  });

  it("an unreadable link is never offered", () => {
    const { html } = render({ link: "unreadable" });
    expect(html).toContain("SaverFi could not read whether this wallet is linked.");
    expect(buttons("Link to vault")).toHaveLength(0);
  });

  it("a wallet equal to the pension key never offers Link, whatever the chain says", () => {
    const { html } = render({ link: "missing", wallet: PENSION_KEY }, PENSION_KEY);
    expect(html).not.toContain("Link to vault");
    expect(buttons("Link to vault")).toHaveLength(0);
  });

  it("ready: Link to vault is enabled; without the keeper's signer the row says nothing is put aside; pressing it asks nobody for anything", () => {
    mocked.user = userWith([phantom(), embedded(TRADING_0, 0, false)]);
    const { html, build } = render({});
    const [link] = buttons("Link to vault");
    expect(link?.disabled).toBe(false);
    expect(html).toContain("Until this wallet has the keeper&#x27;s signer, nothing is put aside from it.");
    link?.onClick?.(CLICK);
    expect(build).not.toHaveBeenCalled();
    expect(mocked.signMessage).not.toHaveBeenCalled();
    expect(mocked.signTransaction).not.toHaveBeenCalled();
  });

  it("a wallet the chain read did not cover is never dropped from the list: it says so, and offers a re-read", () => {
    // Exactly where a wallet sits between its create and Privy's record listing it. The old control
    // rendered nothing here, which is the one place a freshly created wallet could disappear from.
    const { html, build, refresh } = render({ link: "absent" });
    expect(html).toContain('data-link="unread"');
    expect(html).toContain("SaverFi has not read this wallet on Solana yet.");
    expect(buttons("Link to vault")).toHaveLength(0);
    const [check] = buttons("Check again");
    expect(check?.disabled).toBe(false);
    check?.onClick?.(CLICK);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
    expect(mocked.signMessage).not.toHaveBeenCalled();
  });

  it("a link this screen already sent for this wallet is never offered a second time, wherever it was sent from", () => {
    // The card's chained press sent it and could not confirm it. This row is a DIFFERENT writer, so its own
    // `unconfirmed` is false and it used to offer a second link for the same wallet: two transactions, one
    // landing and one burning its fee. The wait lives on the screen's lock, under the wallet's own key.
    const { html, build } = render({}, TRADING_0, vi.fn(), [`${PENSION_KEY}:${TRADING_0}`]);
    expect(buttons("Link to vault")[0]?.disabled).toBe(true);
    expect(html).toContain(LINK_COPY.sentNotConfirmed);
    expect(build).not.toHaveBeenCalled();
  });

  it("…and another wallet's unconfirmed link says nothing about this one", () => {
    const { html } = render({}, TRADING_0, vi.fn(), [`${PENSION_KEY}:${OTHER_WALLET}`]);
    expect(buttons("Link to vault")[0]?.disabled).toBe(false);
    expect(html).not.toContain(LINK_COPY.sentNotConfirmed);
  });

  it("the card's sentence about this row promises its link only once the chain has read the wallet", () => {
    // Same moment, two places: the row of a wallet the read has not covered shows no Link to vault, and
    // the card's "It is in the list below…" — printed after every stop, including `not_ready`, which fires
    // precisely because Privy has not listed the wallet yet — must not send the owner looking for it.
    const { html } = render({ link: "absent" });
    expect(html).toContain(CREATE_LINK_COPY.notReadYet);
    expect(buttons(LINK_COPY.link)).toHaveLength(0);
    expect(CREATE_LINK_COPY.inTheList).toContain(LINK_COPY.link);
    expect(CREATE_LINK_COPY.inTheList).toContain("Once SaverFi has read it on Solana");
  });

  it("with the keeper's signer there is no such note", () => {
    const { html } = render({});
    expect(html).not.toContain("nothing is put aside from it");
    expect([SIGNER, POLICY]).toHaveLength(2);
  });
});
