// A trading wallet carries exactly the keeper's signer with exactly its policy, or it is not created,
// and its seat is read from Privy's record. Privy is mocked by handing these functions plain vi.fn()s;
// the record comes from test/fixtures/privy-user.ts, typed against the installed SDK.

import type { WalletWithMetadata } from "@privy-io/react-auth";
import { describe, expect, it, vi } from "vitest";

import {
  GRANT_BACKOFF_MS,
  NotATradingWallet,
  SeatNotConfigured,
  createTradingWallet,
  exportTradingWallet,
  failureText,
  grantKeeperSeat,
  keeperSigners,
  seatOf,
  seatProblem,
  tradingWalletsOf,
  type AddSignersFn,
  type CreateWalletFn,
  type ExportWalletFn,
  type RefreshUserFn,
  type SeatConfig,
} from "@/lib/trading-wallets";

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
} from "../../test/fixtures/privy-user";

const SEAT: SeatConfig = { privySignerId: SIGNER, privyPolicyId: POLICY };
const EXACT_SIGNERS = [{ signerId: SIGNER, policyIds: [POLICY] }];

/** Every way the seat can be unconfigured, with the variables each refusal must name. */
const UNSEATED: ReadonlyArray<readonly [string, SeatConfig, readonly string[]]> = [
  ["both unset", { privySignerId: null, privyPolicyId: null }, ["SIP_SOLANA_PRIVY_SIGNER_ID", "SIP_SOLANA_PRIVY_POLICY_ID"]],
  ["policy unset", { privySignerId: SIGNER, privyPolicyId: null }, ["SIP_SOLANA_PRIVY_POLICY_ID"]],
  ["signer unset", { privySignerId: null, privyPolicyId: POLICY }, ["SIP_SOLANA_PRIVY_SIGNER_ID"]],
  ["policy blank", { privySignerId: SIGNER, privyPolicyId: "   " }, ["SIP_SOLANA_PRIVY_POLICY_ID"]],
  ["signer empty", { privySignerId: "", privyPolicyId: POLICY }, ["SIP_SOLANA_PRIVY_SIGNER_ID"]],
  ["the same id twice", { privySignerId: SIGNER, privyPolicyId: SIGNER }, ["SIP_SOLANA_PRIVY_SIGNER_ID", "SIP_SOLANA_PRIVY_POLICY_ID"]],
];

const NOT_ASSOCIATED = "Address to add signers too is not associated with current user.";

describe("keeperSigners", () => {
  it("is exactly the keeper's signer with exactly its one policy", () => {
    expect(keeperSigners(SEAT)).toStrictEqual(EXACT_SIGNERS);
  });

  it.each(UNSEATED)("is null — never a signer without its policy — when %s", (_, config) => {
    expect(keeperSigners(config)).toBeNull();
  });

  it("trims the ids, and hands out a fresh array every call", () => {
    const first = keeperSigners({ privySignerId: ` ${SIGNER} `, privyPolicyId: `${POLICY}\n` });
    expect(first).toStrictEqual(EXACT_SIGNERS);
    first?.[0]?.policyIds.push("mutated-by-a-caller");
    expect(keeperSigners(SEAT)).toStrictEqual(EXACT_SIGNERS);
  });
});

describe("seatProblem", () => {
  it("is null when the seat is configured", () => {
    expect(seatProblem(SEAT)).toBeNull();
  });

  it.each(UNSEATED)("names the variables to fix when %s", (_, config, variables) => {
    const problem = seatProblem(config);
    expect(problem).not.toBeNull();
    for (const variable of variables) expect(problem).toContain(variable);
  });
});

describe("createTradingWallet", () => {
  it("asks Privy once, with createAdditional and exactly the keeper's signer and policy", async () => {
    const createWallet = vi.fn<CreateWalletFn>(async () => ({ wallet: { address: TRADING_0 } }));
    await expect(createTradingWallet(createWallet, SEAT)).resolves.toBe(TRADING_0);
    expect(createWallet.mock.calls).toStrictEqual([[{ createAdditional: true, signers: EXACT_SIGNERS }]]);
  });

  it.each(UNSEATED)("refuses before Privy is called when %s", async (_, config, variables) => {
    const createWallet = vi.fn<CreateWalletFn>(async () => ({ wallet: { address: TRADING_0 } }));
    const refused = createTradingWallet(createWallet, config);
    await expect(refused).rejects.toBeInstanceOf(SeatNotConfigured);
    await expect(refused).rejects.toThrow(variables[0]);
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("returns null when Privy reports no address, so the caller reads the record instead", async () => {
    await expect(createTradingWallet(async () => ({}), SEAT)).resolves.toBeNull();
    await expect(createTradingWallet(async () => undefined, SEAT)).resolves.toBeNull();
  });
});

describe("tradingWalletsOf, on a record shaped like the installed types", () => {
  it("lists every Privy embedded Solana wallet once, in HD order with imported ones last", () => {
    expect(tradingWalletsOf(RECORD)).toStrictEqual([
      { address: TRADING_0, id: null, walletIndex: 0, imported: false },
      { address: TRADING_1, id: "wallet-id-tradingone", walletIndex: 1, imported: false },
      { address: TRADING_2, id: "wallet-id-tradingtwo", walletIndex: 2, imported: false },
      { address: IMPORTED, id: null, walletIndex: null, imported: true },
    ]);
  });

  it("never lists the pension key, an EVM embedded wallet, or anything but a wallet", () => {
    const addresses = tradingWalletsOf(RECORD).map((wallet) => wallet.address);
    expect(addresses).not.toContain(PENSION_KEY);
    expect(addresses).not.toContain(EVM_EMBEDDED);
    expect(tradingWalletsOf(userWith([phantom()]))).toStrictEqual([]);
    expect(tradingWalletsOf(null)).toStrictEqual([]);
  });
});

describe("seatOf, read from Privy's record", () => {
  it("is seated for delegated: true, missing for delegated: false", () => {
    expect(seatOf(RECORD, TRADING_1)).toBe("seated");
    expect(seatOf(RECORD, TRADING_2)).toBe("seated");
    expect(seatOf(RECORD, TRADING_0)).toBe("missing");
    expect(seatOf(RECORD, IMPORTED)).toBe("missing");
  });

  it("is unknown for an address the record does not list as a trading wallet — never missing, so no grant is offered", () => {
    expect(seatOf(RECORD, "NotListedP1aceho1der111111111111111111111")).toBe("unknown");
    expect(seatOf(RECORD, PENSION_KEY)).toBe("unknown");
    expect(seatOf(RECORD, EVM_EMBEDDED)).toBe("unknown");
    expect(seatOf(null, TRADING_0)).toBe("unknown");
  });

  it("is unknown when the record lists the wallet without a delegated flag", () => {
    const flagless = { ...embedded(TRADING_0, 0, false), delegated: undefined } as unknown as WalletWithMetadata;
    expect(seatOf(userWith([phantom(), flagless]), TRADING_0)).toBe("unknown");
  });
});

describe("grantKeeperSeat", () => {
  const missing = userWith([phantom(), embedded(TRADING_0, 0, false)]);
  const seated = userWith([phantom(), embedded(TRADING_0, 0, true)]);
  const noWait = (_ms: number): Promise<void> => Promise.resolve();

  it("re-reads Privy's record, then adds exactly the keeper's signer with its policy", async () => {
    const refreshUser = vi.fn<RefreshUserFn>().mockResolvedValueOnce(missing).mockResolvedValueOnce(seated);
    const addSigners = vi.fn<AddSignersFn>(async () => ({ user: seated }));

    await expect(grantKeeperSeat({ address: TRADING_0, config: SEAT, addSigners, refreshUser, wait: noWait })).resolves.toBe("granted");

    expect(addSigners.mock.calls).toStrictEqual([[{ address: TRADING_0, signers: EXACT_SIGNERS }]]);
    expect(refreshUser).toHaveBeenCalledTimes(2);
    expect(refreshUser.mock.invocationCallOrder[0]).toBeLessThan(addSigners.mock.invocationCallOrder[0] ?? 0);
  });

  it("adds nothing when the re-read record already shows the seat, because addSigners appends", async () => {
    const refreshUser = vi.fn<RefreshUserFn>(async () => seated);
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(grantKeeperSeat({ address: TRADING_0, config: SEAT, addSigners, refreshUser, wait: noWait })).resolves.toBe("already-seated");
    expect(addSigners).not.toHaveBeenCalled();
  });

  it.each(UNSEATED)("refuses without asking Privy anything when %s", async (_, config) => {
    const refreshUser = vi.fn<RefreshUserFn>(async () => missing);
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(grantKeeperSeat({ address: TRADING_0, config, addSigners, refreshUser, wait: noWait })).rejects.toBeInstanceOf(SeatNotConfigured);
    expect(refreshUser).not.toHaveBeenCalled();
    expect(addSigners).not.toHaveBeenCalled();
  });

  it("grants nothing when the re-read fails", async () => {
    const refreshUser = vi.fn<RefreshUserFn>(async () => {
      throw new Error("too_many_requests");
    });
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(grantKeeperSeat({ address: TRADING_0, config: SEAT, addSigners, refreshUser, wait: noWait })).rejects.toThrow("too_many_requests");
    expect(addSigners).not.toHaveBeenCalled();
  });

  it("waits out the propagation race with the same signer and policy each time", async () => {
    const refreshUser = vi.fn<RefreshUserFn>(async () => missing);
    const addSigners = vi
      .fn<AddSignersFn>()
      .mockRejectedValueOnce(new Error(NOT_ASSOCIATED))
      .mockRejectedValueOnce(new Error("User must be authenticated and have an embedded wallet to add a session signer."))
      .mockResolvedValueOnce({});
    const wait = vi.fn(noWait);

    await expect(grantKeeperSeat({ address: TRADING_0, config: SEAT, addSigners, refreshUser, wait })).resolves.toBe("granted");

    expect(wait.mock.calls).toStrictEqual([[GRANT_BACKOFF_MS[0]], [GRANT_BACKOFF_MS[1]]]);
    expect(addSigners.mock.calls).toStrictEqual([
      [{ address: TRADING_0, signers: EXACT_SIGNERS }],
      [{ address: TRADING_0, signers: EXACT_SIGNERS }],
      [{ address: TRADING_0, signers: EXACT_SIGNERS }],
    ]);
  });

  it("returns any other refusal at once, and gives up on the race after the last wait", async () => {
    const refreshUser = vi.fn<RefreshUserFn>(async () => missing);

    const refusedPolicy = vi.fn<AddSignersFn>().mockRejectedValue(new Error("Invalid policy id"));
    const wait = vi.fn(noWait);
    await expect(grantKeeperSeat({ address: TRADING_0, config: SEAT, addSigners: refusedPolicy, refreshUser, wait })).rejects.toThrow("Invalid policy id");
    expect(refusedPolicy).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();

    const neverListed = vi.fn<AddSignersFn>().mockRejectedValue(new Error(NOT_ASSOCIATED));
    const waits = vi.fn(noWait);
    await expect(grantKeeperSeat({ address: TRADING_0, config: SEAT, addSigners: neverListed, refreshUser, wait: waits })).rejects.toThrow(NOT_ASSOCIATED);
    expect(neverListed).toHaveBeenCalledTimes(GRANT_BACKOFF_MS.length + 1);
    expect(waits.mock.calls.map(([ms]) => ms)).toStrictEqual([...GRANT_BACKOFF_MS]);
  });
});

describe("exportTradingWallet", () => {
  it("opens Privy's export for exactly that trading wallet's address", async () => {
    const exportWallet = vi.fn<ExportWalletFn>(async () => undefined);
    await exportTradingWallet({ exportWallet, user: RECORD, address: TRADING_1 });
    expect(exportWallet.mock.calls).toStrictEqual([[{ address: TRADING_1 }]]);
  });

  it("never exports the pension key, an EVM wallet, or an address the account does not hold", async () => {
    const exportWallet = vi.fn<ExportWalletFn>(async () => undefined);
    for (const address of [PENSION_KEY, EVM_EMBEDDED, "NotListedP1aceho1der111111111111111111111"]) {
      await expect(exportTradingWallet({ exportWallet, user: RECORD, address })).rejects.toBeInstanceOf(NotATradingWallet);
    }
    await expect(exportTradingWallet({ exportWallet, user: null, address: TRADING_0 })).rejects.toBeInstanceOf(NotATradingWallet);
    expect(exportWallet).not.toHaveBeenCalled();
  });
});

describe("failureText", () => {
  it("keeps this module's refusals as written, words Privy's, and says nothing when the dialog was closed", () => {
    expect(failureText(new SeatNotConfigured("SIP_SOLANA_PRIVY_POLICY_ID is unset."))).toBe("SIP_SOLANA_PRIVY_POLICY_ID is unset.");
    expect(failureText(new NotATradingWallet("Only a trading wallet."))).toBe("Only a trading wallet.");
    expect(failureText("exited_auth_flow")).toBeNull();
    expect(failureText(new Error("Wallet proxy not initialized."))).toContain("auth.privy.io");
  });
});
