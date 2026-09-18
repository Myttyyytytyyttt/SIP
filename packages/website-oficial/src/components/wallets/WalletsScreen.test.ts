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
  teeWallet,
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
    removeSigners: vi.fn(),
    /** The record each signer call was made against: Privy's methods read the user of the render they came from. */
    signerRecords: [] as { method: "add" | "remove"; user: unknown }[],
    refreshUser: vi.fn(),
    exportWallet: vi.fn(),
  };
});

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => ({ ...mocked.privy, login: mocked.login, logout: mocked.logout }),
  useLogin: () => ({ login: mocked.login }),
  useUser: () => ({ user: mocked.privy.user, refreshUser: mocked.refreshUser }),
  // Privy's own shape (index-*.mjs, the signer hooks): both methods close over the context user of the render that
  // produced them, and look the wallet up in THAT record whenever they are called.
  useSigners: () => {
    const rendered = mocked.privy.user;
    return {
      addSigners: (input: unknown) => {
        mocked.signerRecords.push({ method: "add", user: rendered });
        return mocked.addSigners(input);
      },
      removeSigners: (input: unknown) => {
        mocked.signerRecords.push({ method: "remove", user: rendered });
        return mocked.removeSigners(input);
      },
    };
  },
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
import { ReseatConfirm } from "@/components/wallets/TradingWalletRow";
import { WalletsScreen } from "@/components/wallets/WalletsScreen";
import { useKeeperSeat } from "@/hooks/use-keeper-seat";
import { beginSeatTask, clearSeatActivity, endSeatTask, reseatRunning, seatActivity } from "@/lib/seat-activity";
import { GRANT_BACKOFF_MS, GRANT_COPY, GRANT_HOLD_MS, RESEAT_COPY } from "@/lib/trading-wallets";
import { CREATE_LINK_COPY } from "@/lib/vault-copy";

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
  for (const fn of [mocked.login, mocked.logout, mocked.createWallet, mocked.addSigners, mocked.removeSigners, mocked.refreshUser, mocked.exportWallet]) {
    fn.mockReset();
  }
  mocked.signerRecords.length = 0;
  clearSeatActivity();
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
    expect(buttons(CREATE_LINK_COPY.button)).toHaveLength(0);
  });

  it("logged out: Connect opens Privy's login with no arguments, never the click event", () => {
    mocked.privy = { ready: true, authenticated: false, user: null };
    const html = render();
    expect(html).toContain("Connect your pension key");
    expect(buttons(CREATE_LINK_COPY.button)).toHaveLength(0);
    const [connect] = buttons("Connect pension key");
    connect?.onClick?.(CLICK);
    expect(mocked.login.mock.calls).toStrictEqual([[]]);
  });

  it("a session without an external Solana wallet: says so, offers Disconnect, creates nothing", () => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([embedded(TRADING_0, 0, true)]) };
    const html = render();
    expect(html).toContain("This session has no pension key");
    expect(buttons("Disconnect")).toHaveLength(1);
    expect(buttons(CREATE_LINK_COPY.button)).toHaveLength(0);
    expect(rows(html)).toHaveLength(0);
  });

  it("the seat not configured: the refusal names both variables, and Create is disabled and creates nothing even if pressed", async () => {
    mocked.config = { privySignerId: null, privyPolicyId: null };
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom()]) };
    const html = render();
    expect(html).toMatch(/role="alert"[^>]*>[^<]*SIP_SOLANA_PRIVY_SIGNER_ID and SIP_SOLANA_PRIVY_POLICY_ID/);
    expect(html).not.toContain(SIGNER);
    const [create] = buttons(CREATE_LINK_COPY.button);
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

  it("Create wallet and link it hands Privy exactly createAdditional and the keeper's signer id with its policy id", async () => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom()]) };
    mocked.createWallet.mockResolvedValue({ wallet: { address: TRADING_0 } });
    render();
    const [create] = buttons(CREATE_LINK_COPY.button);
    expect(create?.disabled).toBe(false);
    create?.onClick?.(CLICK);
    await vi.waitFor(() => expect(mocked.refreshUser).toHaveBeenCalled());
    expect(mocked.createWallet.mock.calls).toStrictEqual([
      [{ createAdditional: true, signers: [{ signerId: SIGNER, policyIds: [POLICY] }] }],
    ]);
  });

  it("Grant keeper permission re-reads Privy's record, then adds the signer with its policy to that wallet", async () => {
    const missing = userWith([phantom(), teeWallet(TRADING_0, 0, false)]);
    const seated = userWith([phantom(), teeWallet(TRADING_0, 0, true)]);
    mocked.privy = { ready: true, authenticated: true, user: missing };
    // As Privy does: the add refreshes its own record, which then shows the signer.
    mocked.addSigners.mockImplementation(async () => {
      mocked.privy = { ...mocked.privy, user: seated };
      return { user: seated };
    });
    render();
    const grants = buttons("Grant keeper permission");
    expect(grants).toHaveLength(1);
    grants[0]?.onClick?.(CLICK);
    await vi.waitFor(() => expect(mocked.addSigners).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(seatActivity(TRADING_0).busy).toBeNull());
    expect(mocked.addSigners.mock.calls).toStrictEqual([[{ address: TRADING_0, signers: [{ signerId: SIGNER, policyIds: [POLICY] }] }]]);
    expect(mocked.refreshUser.mock.invocationCallOrder[0]).toBeLessThan(mocked.addSigners.mock.invocationCallOrder[0] ?? 0);
  });

  it("Grant keeper permission is disabled, with the reason, where the record shows no server id: Privy could not add it", async () => {
    // A wallet Privy lists without its id (a legacy on-device wallet, or a record that dropped it with its last signer).
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), teeWallet(TRADING_0, 0, false, { id: null })]) };
    const html = render();
    const grants = buttons("Grant keeper permission");
    expect(grants.map((grant) => grant.disabled)).toStrictEqual([true]);
    expect(html).toContain(GRANT_COPY.noServerId.replaceAll("'", "&#x27;"));
    expect(html).not.toMatch(/turn on TEE/i);
    grants[0]?.onClick?.(CLICK);
    await flush();
    expect(mocked.addSigners).not.toHaveBeenCalled();
  });

  it("Grant keeper permission is held back, with the reason, for a minute after an add Privy's record may not show yet", () => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), teeWallet(TRADING_0, 0, false)]) };
    beginSeatTask(TRADING_0, "granting");
    endSeatTask(TRADING_0, { notice: GRANT_COPY.addedRecordLags, holdGrantFor: GRANT_HOLD_MS });
    const html = render();
    expect(buttons("Grant keeper permission").map((grant) => grant.disabled)).toStrictEqual([true]);
    expect(html).toContain(GRANT_COPY.held.replaceAll("'", "&#x27;"));
    expect(html).toContain(GRANT_COPY.addedRecordLags.replaceAll("'", "&#x27;"));
  });

  it("the hook's grant on a record that never shows the signer says so and holds Grant back", async () => {
    vi.useFakeTimers();
    try {
      const missing = userWith([phantom(), teeWallet(TRADING_0, 0, false)]);
      mocked.privy = { ready: true, authenticated: true, user: missing };
      mocked.addSigners.mockResolvedValue({ user: missing });
      let seat: ReturnType<typeof useKeeperSeat> | null = null;
      function Probe() {
        seat = useKeeperSeat(TRADING_0, { privySignerId: SIGNER, privyPolicyId: POLICY });
        return null;
      }
      renderToStaticMarkup(createElement(Probe));
      const granting = (seat as ReturnType<typeof useKeeperSeat> | null)?.grant();
      await vi.advanceTimersByTimeAsync(GRANT_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0));
      await granting;
      expect(mocked.addSigners).toHaveBeenCalledTimes(1);
      expect(seatActivity(TRADING_0)).toMatchObject({ busy: null, failure: null, notice: GRANT_COPY.addedRecordLags });
      expect(seatActivity(TRADING_0).holdGrantUntil).not.toBeNull();
      await vi.advanceTimersByTimeAsync(GRANT_HOLD_MS);
      expect(seatActivity(TRADING_0).holdGrantUntil).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

describe("Re-seat keeper: remove every signer on a wallet, then seat the keeper's current signer", () => {
  const seated = userWith([phantom(), teeWallet(TRADING_0, 0, true)]);
  const cleared = userWith([phantom(), teeWallet(TRADING_0, 0, false)]);

  it("is offered on a wallet with a signer, and its first press only asks: nothing is removed or added", async () => {
    mocked.privy = { ready: true, authenticated: true, user: seated };
    const html = render();
    const [row] = rows(html);
    expect(row?.body).toContain("the signer here is the old one: re-seat it.");
    const reseats = buttons(RESEAT_COPY.button);
    expect(reseats).toHaveLength(1);
    expect(reseats[0]?.disabled).toBe(false);
    // The confirmation is not on screen until asked for, and nothing in the row removes anything by itself.
    expect(buttons(RESEAT_COPY.confirm)).toHaveLength(0);
    reseats[0]?.onClick?.(CLICK);
    await flush();
    expect(mocked.removeSigners).not.toHaveBeenCalled();
    expect(mocked.addSigners).not.toHaveBeenCalled();
    expect(mocked.refreshUser).not.toHaveBeenCalled();
  });

  it("is not offered where the grant is (No seat) or where the seat cannot be read (Seat unknown)", () => {
    const flagless = { ...teeWallet(TRADING_1, 1, true), delegated: undefined } as unknown as WalletWithMetadata;
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), teeWallet(TRADING_0, 0, false), flagless]) };
    render();
    expect(buttons(RESEAT_COPY.button)).toHaveLength(0);
    expect(buttons("Grant keeper permission")).toHaveLength(1);
    expect(buttons("Check again")).toHaveLength(1);
  });

  it("is disabled, with the reason on the row, for a wallet Privy would not clear one at a time", () => {
    mocked.privy = { ready: true, authenticated: true, user: userWith([phantom(), embedded(TRADING_1, 1, true)]) };
    const html = render();
    expect(buttons(RESEAT_COPY.button).map((button) => button.disabled)).toStrictEqual([true]);
    expect(html).toContain(RESEAT_COPY.notPerWallet.replaceAll("'", "&#x27;"));
  });

  it("is disabled when the seat is not configured: it would end in a signer without its policy, or none", () => {
    mocked.config = { privySignerId: SIGNER, privyPolicyId: null };
    mocked.privy = { ready: true, authenticated: true, user: seated };
    render();
    expect(buttons(RESEAT_COPY.button).map((button) => button.disabled)).toStrictEqual([true]);
  });

  it("the hook's re-seat removes by address only, then adds exactly the keeper's signer with its policy", async () => {
    mocked.privy = { ready: true, authenticated: true, user: seated };
    mocked.refreshUser.mockReset();
    mocked.refreshUser.mockResolvedValueOnce(seated).mockResolvedValueOnce(cleared).mockResolvedValueOnce(cleared).mockResolvedValue(seated);
    mocked.removeSigners.mockResolvedValue({ user: cleared });
    mocked.addSigners.mockResolvedValue({ user: seated });
    let seat: ReturnType<typeof useKeeperSeat> | null = null;
    function Probe() {
      seat = useKeeperSeat(TRADING_0, { privySignerId: SIGNER, privyPolicyId: POLICY });
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    const captured = seat as ReturnType<typeof useKeeperSeat> | null;
    expect(captured?.seat).toBe("has-signer");
    expect(captured?.reseatBlocked).toBeNull();
    await captured?.reseat();
    expect(mocked.removeSigners.mock.calls).toStrictEqual([[{ address: TRADING_0 }]]);
    expect(mocked.addSigners.mock.calls).toStrictEqual([[{ address: TRADING_0, signers: [{ signerId: SIGNER, policyIds: [POLICY] }] }]]);
    expect(mocked.removeSigners.mock.invocationCallOrder[0]).toBeLessThan(mocked.addSigners.mock.invocationCallOrder[0] ?? 0);
  });

  it("the hook's re-seat adds through the signer methods of the render it was pressed on, even once the record drops the id", async () => {
    // After the removal Privy refreshes its own context, and a record without the wallet's server id would leave any
    // addSigners from a NEWER render unable to reach the wallet. The add must come from before the removal.
    const idless = userWith([phantom(), teeWallet(TRADING_0, 0, false, { id: null })]);
    mocked.privy = { ready: true, authenticated: true, user: seated };
    mocked.refreshUser.mockReset();
    mocked.refreshUser.mockResolvedValueOnce(seated).mockResolvedValueOnce(idless).mockResolvedValueOnce(idless).mockResolvedValue(seated);
    mocked.removeSigners.mockImplementation(async () => {
      mocked.privy = { ...mocked.privy, user: idless };
      return { user: idless };
    });
    mocked.addSigners.mockResolvedValue({ user: seated });
    let seat: ReturnType<typeof useKeeperSeat> | null = null;
    function Probe() {
      seat = useKeeperSeat(TRADING_0, { privySignerId: SIGNER, privyPolicyId: POLICY });
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    await (seat as ReturnType<typeof useKeeperSeat> | null)?.reseat();
    expect(mocked.signerRecords.map(({ method, user }) => [method, user])).toStrictEqual([
      ["remove", seated],
      ["add", seated],
    ]);
    expect(mocked.addSigners.mock.calls).toStrictEqual([[{ address: TRADING_0, signers: [{ signerId: SIGNER, policyIds: [POLICY] }] }]]);
  });

  it("a re-seat outlives its row: a row mounted again shows it running, offers no Grant beside it, then shows how it ended", async () => {
    // The Manage wallets modal closed mid-flow unmounts the row; the re-seat's promise runs on regardless.
    let release: () => void = () => undefined;
    const removal = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocked.privy = { ready: true, authenticated: true, user: seated };
    mocked.refreshUser.mockReset();
    mocked.refreshUser.mockResolvedValueOnce(seated).mockResolvedValueOnce(cleared).mockResolvedValueOnce(cleared).mockResolvedValue(seated);
    mocked.removeSigners.mockImplementation(async () => {
      await removal;
      mocked.privy = { ...mocked.privy, user: cleared };
      return { user: cleared };
    });
    mocked.addSigners.mockResolvedValue({ user: seated });
    const probe = () => {
      let seat: ReturnType<typeof useKeeperSeat> | null = null;
      function Probe() {
        seat = useKeeperSeat(TRADING_0, { privySignerId: SIGNER, privyPolicyId: POLICY });
        return null;
      }
      renderToStaticMarkup(createElement(Probe));
      return seat as ReturnType<typeof useKeeperSeat> | null;
    };
    const running = probe()?.reseat();
    await flush();
    expect(reseatRunning()).toBe(true);

    // Mounted again, halfway through: Privy's record already reads no signer, and the row must not offer Grant.
    mocked.privy = { ...mocked.privy, user: cleared };
    const midway = render();
    expect(rows(midway).map((row) => row.seat)).toStrictEqual(["missing"]);
    expect(buttons(RESEAT_COPY.running).map((button) => button.disabled)).toStrictEqual([true]);
    expect(buttons("Grant keeper permission")).toHaveLength(0);
    // And no second operation starts on that wallet from the new row.
    await probe()?.grant();
    await probe()?.reseat();
    expect(mocked.removeSigners).toHaveBeenCalledTimes(1);
    expect(mocked.addSigners).not.toHaveBeenCalled();

    release();
    await running;
    expect(reseatRunning()).toBe(false);
    mocked.privy = { ...mocked.privy, user: seated };
    const after = render();
    expect(after).toContain(RESEAT_COPY.done.replaceAll("'", "&#x27;"));
    expect(buttons(RESEAT_COPY.running)).toHaveLength(0);
    expect(mocked.addSigners).toHaveBeenCalledTimes(1);
  });

  it("the hook checks its own render's record, the one Privy's methods read: an on-device record removes nothing", async () => {
    // Were a fresh read checked instead, removeSigners would run on a record where Privy takes its legacy revoke of
    // every wallet on the account.
    const onDevice = userWith([phantom(), embedded(TRADING_0, 0, true)]);
    mocked.privy = { ready: true, authenticated: true, user: onDevice };
    mocked.refreshUser.mockReset();
    mocked.refreshUser.mockResolvedValue(seated);
    let seat: ReturnType<typeof useKeeperSeat> | null = null;
    function Probe() {
      seat = useKeeperSeat(TRADING_0, { privySignerId: SIGNER, privyPolicyId: POLICY });
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    const captured = seat as ReturnType<typeof useKeeperSeat> | null;
    expect(captured?.reseatBlocked).toBe(RESEAT_COPY.notPerWallet);
    await captured?.reseat();
    await captured?.grant();
    expect(mocked.refreshUser).not.toHaveBeenCalled();
    expect(mocked.removeSigners).not.toHaveBeenCalled();
    expect(mocked.addSigners).not.toHaveBeenCalled();
  });
});

describe("ReseatConfirm, the plain confirmation", () => {
  function confirmWith(busy: boolean, disabled = false) {
    mocked.buttons.length = 0;
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const html = renderToStaticMarkup(createElement(ReseatConfirm, { signerId: SIGNER, policyId: POLICY, busy, disabled, onConfirm, onCancel }));
    return { html, onConfirm, onCancel };
  }

  it("says it removes EVERY signer on this wallet, what goes back, and what the wallet is if the second step fails", () => {
    const { html } = confirmWith(false);
    expect(html).toContain("This removes EVERY signer on this wallet");
    expect(html).toContain("only you can sign for this wallet");
    expect(html).toContain("If the second step fails, the wallet says No seat and this row says what to do next.");
    expect(html).toContain(SIGNER);
    expect(html).toContain(POLICY);
  });

  it("only its first button goes ahead; Cancel calls nothing else", () => {
    const { onConfirm, onCancel } = confirmWith(false);
    buttons(RESEAT_COPY.cancel)[0]?.onClick?.(CLICK);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    buttons(RESEAT_COPY.confirm)[0]?.onClick?.(CLICK);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("while running it says so, and neither button can be pressed again", () => {
    confirmWith(true, true);
    expect(buttons(RESEAT_COPY.running).map((button) => button.disabled)).toStrictEqual([true]);
    expect(buttons(RESEAT_COPY.cancel).map((button) => button.disabled)).toStrictEqual([true]);
  });
});
