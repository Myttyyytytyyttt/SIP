// A trading wallet carries exactly the keeper's signer with exactly its policy, or it is not created,
// and its seat is read from Privy's record. Privy is mocked by handing these functions plain vi.fn()s;
// the record comes from test/fixtures/privy-user.ts, typed against the installed SDK.

import type { User, WalletWithMetadata } from "@privy-io/react-auth";
import { describe, expect, it, vi } from "vitest";

import {
  GRANT_BACKOFF_MS,
  GRANT_COPY,
  GrantRefused,
  NotATradingWallet,
  RESEAT_COPY,
  ReseatIncomplete,
  ReseatRefused,
  SeatNotConfigured,
  createTradingWallet,
  exportTradingWallet,
  failureText,
  grantKeeperSeat,
  grantRefusal,
  keeperSigners,
  reseatKeeperSeat,
  reseatRefusal,
  seatOf,
  seatProblem,
  teeWalletId,
  tradingWalletsOf,
  type AddSignersFn,
  type CreateWalletFn,
  type ExportWalletFn,
  type RefreshUserFn,
  type RemoveSignersFn,
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
  teeWallet,
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
  it("has a signer for delegated: true, missing for delegated: false", () => {
    expect(seatOf(RECORD, TRADING_1)).toBe("has-signer");
    expect(seatOf(RECORD, TRADING_2)).toBe("has-signer");
    expect(seatOf(RECORD, TRADING_0)).toBe("missing");
    expect(seatOf(RECORD, IMPORTED)).toBe("missing");
  });

  it("never says seated: delegated: true is Privy's flag for any signer, not for the keeper's with its policy", () => {
    // Privy's record of a wallet carries delegated and an id, never additional_signers. The keeper's signer with its
    // policy, the keeper's without it, and another key quorum are all this same entry, so no status may claim more.
    const anySigner = userWith([phantom(), embedded(TRADING_1, 1, true)]);
    const statuses: string[] = [TRADING_0, TRADING_1, TRADING_2, IMPORTED].map((address) => seatOf(RECORD, address));
    expect([...statuses, seatOf(anySigner, TRADING_1)]).not.toContain("seated");
    expect(seatOf(anySigner, TRADING_1)).toBe("has-signer");
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
  // A TEE wallet, as this Privy app makes them: the record addSigners reads must show its server id (grantRefusal).
  const missing = userWith([phantom(), teeWallet(TRADING_0, 0, false)]);
  const withSigner = userWith([phantom(), teeWallet(TRADING_0, 0, true)]);
  const noWait = (_ms: number): Promise<void> => Promise.resolve();

  it("re-reads Privy's record, then adds exactly the keeper's signer with its policy", async () => {
    const refreshUser = vi.fn<RefreshUserFn>().mockResolvedValueOnce(missing).mockResolvedValueOnce(withSigner);
    const addSigners = vi.fn<AddSignersFn>(async () => ({ user: withSigner }));

    await expect(grantKeeperSeat({ address: TRADING_0, renderedUser: missing, config: SEAT, addSigners, refreshUser, wait: noWait })).resolves.toBe("granted");

    expect(addSigners.mock.calls).toStrictEqual([[{ address: TRADING_0, signers: EXACT_SIGNERS }]]);
    expect(refreshUser).toHaveBeenCalledTimes(2);
    expect(refreshUser.mock.invocationCallOrder[0]).toBeLessThan(addSigners.mock.invocationCallOrder[0] ?? 0);
  });

  it("adds nothing when the re-read record shows any signer, because addSigners appends — and answers has-signer, not seated", async () => {
    const refreshUser = vi.fn<RefreshUserFn>(async () => withSigner);
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(grantKeeperSeat({ address: TRADING_0, renderedUser: missing, config: SEAT, addSigners, refreshUser, wait: noWait })).resolves.toBe("has-signer");
    expect(addSigners).not.toHaveBeenCalled();
  });

  it.each(UNSEATED)("refuses without asking Privy anything when %s", async (_, config) => {
    const refreshUser = vi.fn<RefreshUserFn>(async () => missing);
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(grantKeeperSeat({ address: TRADING_0, renderedUser: missing, config, addSigners, refreshUser, wait: noWait })).rejects.toBeInstanceOf(SeatNotConfigured);
    expect(refreshUser).not.toHaveBeenCalled();
    expect(addSigners).not.toHaveBeenCalled();
  });

  it("grants nothing when the re-read fails", async () => {
    const refreshUser = vi.fn<RefreshUserFn>(async () => {
      throw new Error("too_many_requests");
    });
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(grantKeeperSeat({ address: TRADING_0, renderedUser: missing, config: SEAT, addSigners, refreshUser, wait: noWait })).rejects.toThrow("too_many_requests");
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

    await expect(grantKeeperSeat({ address: TRADING_0, renderedUser: missing, config: SEAT, addSigners, refreshUser, wait })).resolves.toBe("granted");

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
    await expect(grantKeeperSeat({ address: TRADING_0, renderedUser: missing, config: SEAT, addSigners: refusedPolicy, refreshUser, wait })).rejects.toThrow("Invalid policy id");
    expect(refusedPolicy).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();

    const neverListed = vi.fn<AddSignersFn>().mockRejectedValue(new Error(NOT_ASSOCIATED));
    const waits = vi.fn(noWait);
    await expect(grantKeeperSeat({ address: TRADING_0, renderedUser: missing, config: SEAT, addSigners: neverListed, refreshUser, wait: waits })).rejects.toThrow(NOT_ASSOCIATED);
    expect(neverListed).toHaveBeenCalledTimes(GRANT_BACKOFF_MS.length + 1);
    expect(waits.mock.calls.map(([ms]) => ms)).toStrictEqual([...GRANT_BACKOFF_MS]);
  });

  it("refuses, sending nothing, when the record addSigners reads does not show the wallet's server id — and never says to turn on TEE", async () => {
    // Privy's addSigners would take its on-device branch and throw "only supported for TEE execution and this app uses
    // On-device execution" — about the record, not the app, which runs TEE.
    const idless = userWith([phantom(), teeWallet(TRADING_0, 0, false, { id: null })]);
    const onDevice = userWith([phantom(), embedded(TRADING_0, 0, false)]);
    for (const renderedUser of [idless, onDevice]) {
      const refreshUser = vi.fn<RefreshUserFn>(async () => missing);
      const addSigners = vi.fn<AddSignersFn>(async () => ({}));
      const refused = grantKeeperSeat({ address: TRADING_0, renderedUser, config: SEAT, addSigners, refreshUser, wait: noWait });
      await expect(refused).rejects.toBeInstanceOf(GrantRefused);
      const message = failureText(await refused.catch((error: unknown) => error)) ?? "";
      expect(message).toBe(GRANT_COPY.noServerId);
      expect(message).not.toMatch(/turn on TEE/i);
      expect(message).not.toContain("SIP_SOLANA_PRIVY");
      expect(refreshUser).not.toHaveBeenCalled();
      expect(addSigners).not.toHaveBeenCalled();
    }
    expect(grantRefusal(userWith([phantom()]), TRADING_0)).toBe(GRANT_COPY.notListed);
    expect(grantRefusal(missing, TRADING_0)).toBeNull();
  });

  it("checks the RENDERED record, the one addSigners reads, not a fresh read: a fresh record without the id still grants", async () => {
    // The re-seat's case: its addSigners comes from before the removal, and still reaches the wallet by that record's id.
    const refreshUser = vi
      .fn<RefreshUserFn>()
      .mockResolvedValueOnce(userWith([phantom(), teeWallet(TRADING_0, 0, false, { id: null })]))
      .mockResolvedValue(withSigner);
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(grantKeeperSeat({ address: TRADING_0, renderedUser: missing, config: SEAT, addSigners, refreshUser, wait: noWait })).resolves.toBe(
      "granted",
    );
    expect(addSigners.mock.calls).toStrictEqual([[{ address: TRADING_0, signers: EXACT_SIGNERS }]]);
  });
});

describe("teeWalletId: the wallet Privy's signer methods act on, found the way Privy finds it", () => {
  it("is the server id of a TEE wallet: walletClientType privy, an id, recoveryMethod privy-v2, on Solana", () => {
    expect(teeWalletId(userWith([phantom(), teeWallet(TRADING_0, 0, true)]), TRADING_0)).toBe("wallet-id-tradingzer");
    expect(teeWalletId(userWith([phantom(), teeWallet(TRADING_0, 0, false)]), TRADING_0)).toBe("wallet-id-tradingzer");
  });

  it("is null wherever Privy would not act on that wallet alone, or would not find it", () => {
    const cases: WalletWithMetadata[] = [
      teeWallet(TRADING_0, 0, false, { id: null }),
      teeWallet(TRADING_0, 0, true, { id: "" }),
      teeWallet(TRADING_0, 0, true, { recoveryMethod: "privy" }),
      teeWallet(TRADING_0, 0, true, { recoveryMethod: undefined }),
      teeWallet(TRADING_0, 0, true, { walletClientType: "privy-v2" }),
      teeWallet(TRADING_0, 0, true, { chainType: "ethereum" }),
      embedded(TRADING_0, 0, true),
    ];
    for (const wallet of cases) expect(teeWalletId(userWith([phantom(), wallet]), TRADING_0)).toBeNull();
    expect(teeWalletId(null, TRADING_0)).toBeNull();
    expect(teeWalletId(userWith([phantom(), teeWallet(TRADING_0, 0, true)]), TRADING_1)).toBeNull();
  });

  it("reads the FIRST privy entry at the address, as Privy does, even when a later one is a TEE wallet", () => {
    const record = userWith([phantom(), embedded(TRADING_0, 0, true), teeWallet(TRADING_0, 0, true)]);
    expect(teeWalletId(record, TRADING_0)).toBeNull();
    expect(reseatRefusal(record, TRADING_0)).toBe(RESEAT_COPY.notPerWallet);
  });
});

describe("reseatRefusal: whether Privy would remove the signers of THIS wallet only", () => {
  it("allows a TEE wallet: walletClientType privy, a server id, recoveryMethod privy-v2", () => {
    expect(reseatRefusal(userWith([phantom(), teeWallet(TRADING_0, 0, true)]), TRADING_0)).toBeNull();
  });

  it("refuses any other wallet, where Privy's removal would revoke every wallet on the account or find none", () => {
    // Privy 3.36.0: not isUnifiedWallet -> its legacy revoke, which takes no address; not walletClientType privy -> not found.
    const cases: WalletWithMetadata[] = [
      embedded(TRADING_0, 0, true),
      teeWallet(TRADING_0, 0, true, { recoveryMethod: "privy" }),
      teeWallet(TRADING_0, 0, true, { id: null }),
      teeWallet(TRADING_0, 0, true, { id: "" }),
      teeWallet(TRADING_0, 0, true, { walletClientType: "privy-v2" }),
    ];
    for (const wallet of cases) expect(reseatRefusal(userWith([phantom(), wallet]), TRADING_0)).toBe(RESEAT_COPY.notPerWallet);
  });

  it("refuses the pension key, an EVM wallet, an address the account does not hold, and no user at all", () => {
    const user = userWith([phantom(), teeWallet(EVM_EMBEDDED, 0, true, { chainType: "ethereum" })]);
    for (const address of [PENSION_KEY, EVM_EMBEDDED, TRADING_0]) expect(reseatRefusal(user, address)).toBe(RESEAT_COPY.notATradingWallet);
    expect(reseatRefusal(null, TRADING_0)).toBe(RESEAT_COPY.notATradingWallet);
  });
});

describe("reseatKeeperSeat", () => {
  const seated = userWith([phantom(), teeWallet(TRADING_0, 0, true)]);
  const cleared = userWith([phantom(), teeWallet(TRADING_0, 0, false)]);
  const noWait = (_ms: number): Promise<void> => Promise.resolve();
  /** Privy's record as each read returns it, in order; the last one repeats. */
  const reads = (...users: User[]) => {
    const fn = vi.fn<RefreshUserFn>();
    for (const user of users) fn.mockResolvedValueOnce(user);
    return fn.mockResolvedValue(users.at(-1) ?? null);
  };

  it("removes every signer, waits for the record to show none, then seats exactly the keeper's signer with its policy", async () => {
    const refreshUser = reads(seated, cleared, cleared, seated);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({ user: cleared }));
    const addSigners = vi.fn<AddSignersFn>(async () => ({ user: seated }));
    const wait = vi.fn(noWait);

    await expect(reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait })).resolves.toBe("reseated");

    // Exactly the address, never a click event or anything else Privy might read as options.
    expect(removeSigners.mock.calls).toStrictEqual([[{ address: TRADING_0 }]]);
    expect(addSigners.mock.calls).toStrictEqual([[{ address: TRADING_0, signers: EXACT_SIGNERS }]]);
    expect(removeSigners.mock.invocationCallOrder[0]).toBeLessThan(addSigners.mock.invocationCallOrder[0] ?? 0);
    // A read before the removal, one after it that shows no signer, the grant's own re-read, and its read after.
    expect(refreshUser).toHaveBeenCalledTimes(4);
    expect(refreshUser.mock.invocationCallOrder[1]).toBeGreaterThan(removeSigners.mock.invocationCallOrder[0] ?? 0);
    expect(refreshUser.mock.invocationCallOrder[1]).toBeLessThan(addSigners.mock.invocationCallOrder[0] ?? 0);
    expect(wait).not.toHaveBeenCalled();
  });

  it.each(UNSEATED)("refuses without asking Privy anything when %s: no signer without its policy", async (_, config) => {
    const refreshUser = reads(seated);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config, removeSigners, addSigners, refreshUser, wait: noWait })).rejects.toBeInstanceOf(
      SeatNotConfigured,
    );
    expect(refreshUser).not.toHaveBeenCalled();
    expect(removeSigners).not.toHaveBeenCalled();
    expect(addSigners).not.toHaveBeenCalled();
  });

  it("removes nothing from a wallet Privy would not clear on its own, or from an address that is not a trading wallet", async () => {
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    const onDevice = reads(userWith([phantom(), embedded(TRADING_0, 0, true)]));
    await expect(reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser: onDevice, wait: noWait })).rejects.toThrow(
      RESEAT_COPY.notPerWallet,
    );
    for (const address of [PENSION_KEY, TRADING_1]) {
      await expect(reseatKeeperSeat({ renderedUser: seated, address, config: SEAT, removeSigners, addSigners, refreshUser: reads(seated), wait: noWait })).rejects.toBeInstanceOf(
        ReseatRefused,
      );
    }
    const flagless = { ...teeWallet(TRADING_0, 0, true), delegated: undefined } as unknown as WalletWithMetadata;
    await expect(
      reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser: reads(userWith([phantom(), flagless])), wait: noWait }),
    ).rejects.toThrow(RESEAT_COPY.notListed);
    expect(removeSigners).not.toHaveBeenCalled();
    expect(addSigners).not.toHaveBeenCalled();
  });

  it("sends nothing when the first read of the record fails", async () => {
    const refreshUser = vi.fn<RefreshUserFn>(async () => {
      throw new Error("too_many_requests");
    });
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait: noWait })).rejects.toThrow("too_many_requests");
    expect(removeSigners).not.toHaveBeenCalled();
    expect(addSigners).not.toHaveBeenCalled();
  });

  it("waits on the grant's backoff for a record still catching up with the removal, then seats", async () => {
    const refreshUser = reads(seated, seated, seated, cleared, cleared, seated);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    const wait = vi.fn(noWait);
    await expect(reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait })).resolves.toBe("reseated");
    expect(wait.mock.calls).toStrictEqual([[GRANT_BACKOFF_MS[0]], [GRANT_BACKOFF_MS[1]]]);
    expect(addSigners).toHaveBeenCalledTimes(1);
  });

  it("adds nothing while the record still lists a signer after every wait, and says to press again — never done", async () => {
    const refreshUser = reads(seated);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    const wait = vi.fn(noWait);
    const stop = reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait });
    await expect(stop).rejects.toBeInstanceOf(ReseatIncomplete);
    await expect(stop).rejects.toMatchObject({ stage: "record-still-lists-a-signer", message: RESEAT_COPY.recordLags });
    expect(wait.mock.calls.map(([ms]) => ms)).toStrictEqual([...GRANT_BACKOFF_MS]);
    expect(addSigners).not.toHaveBeenCalled();
  });

  it("a removal Privy refused, with the signer still on the record: nothing added, Privy's words, no waiting", async () => {
    const refreshUser = reads(seated);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => {
      throw new Error("Wallet proxy not initialized.");
    });
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    const wait = vi.fn(noWait);
    const stop = reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait });
    await expect(stop).rejects.toMatchObject({ stage: "removal-unconfirmed" });
    const message = failureText(await stop.catch((error: unknown) => error)) ?? "";
    expect(message).toContain(RESEAT_COPY.removalUnconfirmed);
    expect(message).toContain(RESEAT_COPY.recordShowsSigner);
    expect(message).toContain("auth.privy.io");
    expect(addSigners).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("a removal whose answer failed and whose record cannot be read says it cannot tell, and adds nothing", async () => {
    const refreshUser = vi
      .fn<RefreshUserFn>()
      .mockResolvedValueOnce(seated)
      .mockRejectedValue(new Error("network down"));
    const removeSigners = vi.fn<RemoveSignersFn>(async () => {
      throw new Error("Could not refresh user");
    });
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    const stop = reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait: noWait });
    await expect(stop).rejects.toMatchObject({ stage: "removal-unconfirmed" });
    expect(failureText(await stop.catch((error: unknown) => error))).toContain(RESEAT_COPY.recordUnreadable);
    expect(addSigners).not.toHaveBeenCalled();
  });

  it("goes on to the grant when removeSigners failed AFTER the removal landed — the record is what decides", async () => {
    // Privy's removeSigners patches the wallet, then re-reads the user and throws "Could not refresh user" if that fails.
    const refreshUser = reads(seated, cleared, cleared, seated);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => {
      throw new Error("Could not refresh user");
    });
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait: noWait })).resolves.toBe("reseated");
    expect(addSigners.mock.calls).toStrictEqual([[{ address: TRADING_0, signers: EXACT_SIGNERS }]]);
  });

  it("REMOVED BUT NOT ADDED: says so first, names Grant keeper permission, keeps Privy's words, and is never done", async () => {
    const refreshUser = reads(seated, cleared);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>().mockRejectedValue(new Error("Invalid policy id"));
    const stop = reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait: noWait });
    await expect(stop).rejects.toMatchObject({ stage: "removed-not-added" });
    const message = failureText(await stop.catch((error: unknown) => error)) ?? "";
    expect(message.startsWith(RESEAT_COPY.removedNotAdded)).toBe(true);
    expect(message).toContain("Invalid policy id");
    expect(message).toContain("Grant keeper permission");
    expect(message).not.toContain(RESEAT_COPY.done);
    // The record now reads "missing", which is exactly what puts the row's one-press Grant back on screen.
    expect(seatOf(cleared, TRADING_0)).toBe("missing");
  });

  it("a stop after the removal is described even when Privy's own answer would say nothing (a closed dialog)", async () => {
    const refreshUser = reads(seated, cleared);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>().mockRejectedValue(new Error("exited_auth_flow"));
    const stop = reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait: noWait });
    const message = failureText(await stop.catch((error: unknown) => error));
    expect(message).toBe(`${RESEAT_COPY.removedNotAdded} ${RESEAT_COPY.removedNotAddedNext}`);
  });

  it("keeps the grant's propagation backoff after the removal", async () => {
    const refreshUser = reads(seated, cleared);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>().mockRejectedValueOnce(new Error(NOT_ASSOCIATED)).mockResolvedValueOnce({});
    const wait = vi.fn(noWait);
    await expect(reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait })).resolves.toBe("reseated");
    expect(wait.mock.calls).toStrictEqual([[GRANT_BACKOFF_MS[0]]]);
    expect(addSigners).toHaveBeenCalledTimes(2);
  });

  it("adds nothing when a signer this page did not add appears between the removal and the grant", async () => {
    const refreshUser = reads(seated, cleared, seated);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait: noWait })).rejects.toMatchObject({
      stage: "signer-reappeared",
      message: RESEAT_COPY.signerReappeared,
    });
    expect(addSigners).not.toHaveBeenCalled();
  });

  it("removes nothing when the record Privy's signer methods read is not a TEE wallet, however the fresh read looks", async () => {
    // removeSigners would take Privy's legacy revoke, which revokes the signers of EVERY wallet on the account.
    const onDevice = userWith([phantom(), embedded(TRADING_0, 0, true)]);
    const refreshUser = reads(seated);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(
      reseatKeeperSeat({ renderedUser: onDevice, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait: noWait }),
    ).rejects.toThrow(RESEAT_COPY.notPerWallet);
    expect(refreshUser).not.toHaveBeenCalled();
    expect(removeSigners).not.toHaveBeenCalled();
    expect(addSigners).not.toHaveBeenCalled();
  });

  it("removes nothing when the rendered record and the fresh read name different server ids for the wallet", async () => {
    const refreshUser = reads(userWith([phantom(), teeWallet(TRADING_0, 0, true, { id: "another-wallet-id" })]));
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait: noWait })).rejects.toThrow(
      RESEAT_COPY.recordsDisagree,
    );
    expect(removeSigners).not.toHaveBeenCalled();
    expect(addSigners).not.toHaveBeenCalled();
  });

  describe("ID DROPPED: Privy's record loses the wallet's server id with its last signer", () => {
    const WALLET_ID = teeWalletId(seated, TRADING_0) ?? "";
    const idless = userWith([phantom(), teeWallet(TRADING_0, 0, false, { id: null })]);
    const unrecovered = userWith([phantom(), teeWallet(TRADING_0, 0, false, { recoveryMethod: undefined })]);

    it("still sends the add at once, through the addSigners from before the removal, and stops naming the id and the check", async () => {
      for (const cleared of [idless, unrecovered]) {
        const refreshUser = reads(seated, cleared, cleared, seated);
        const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
        const addSigners = vi.fn<AddSignersFn>(async () => ({}));
        const stop = reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait: noWait });
        await expect(stop).rejects.toMatchObject({ stage: "id-dropped" });
        const message = failureText(await stop.catch((error: unknown) => error)) ?? "";
        expect(message).toContain(RESEAT_COPY.idDropped(WALLET_ID));
        expect(message).toContain(`privy-policy verify --wallet ${WALLET_ID} --policy ${POLICY}`);
        expect(message).not.toContain(RESEAT_COPY.done);
        expect(message).not.toMatch(/press Grant keeper permission/i);
        expect(addSigners.mock.calls).toStrictEqual([[{ address: TRADING_0, signers: EXACT_SIGNERS }]]);
        expect(removeSigners.mock.invocationCallOrder[0]).toBeLessThan(addSigners.mock.invocationCallOrder[0] ?? 0);
      }
    });

    it("an add Privy refused: says the seat was NOT added, and never sends the owner to a Grant that cannot reach the wallet", async () => {
      const refreshUser = reads(seated, idless);
      const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
      const addSigners = vi.fn<AddSignersFn>().mockRejectedValue(new Error("Invalid policy id"));
      const stop = reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait: noWait });
      await expect(stop).rejects.toMatchObject({ stage: "id-dropped" });
      const message = failureText(await stop.catch((error: unknown) => error)) ?? "";
      expect(message.startsWith(RESEAT_COPY.idDropped(WALLET_ID))).toBe(true);
      expect(message).toContain(RESEAT_COPY.idDroppedNotAdded);
      expect(message).toContain("Invalid policy id");
      expect(message).not.toMatch(/press Grant keeper permission/i);
      expect(addSigners).toHaveBeenCalledTimes(1);
      // The row agrees: on that record Grant is refused before anything is sent.
      expect(grantRefusal(idless, TRADING_0)).toBe(GRANT_COPY.noServerId);
    });
  });

  it("sends the add again when the grant stopped before reaching Privy — its own read of the record failed — rather than leave it to a later press", async () => {
    const refreshUser = vi
      .fn<RefreshUserFn>()
      .mockResolvedValueOnce(seated)
      .mockResolvedValueOnce(cleared)
      .mockRejectedValueOnce(new Error("too_many_requests"))
      .mockResolvedValueOnce(cleared)
      .mockResolvedValue(seated);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    const wait = vi.fn(noWait);
    await expect(reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait })).resolves.toBe("reseated");
    expect(wait.mock.calls).toStrictEqual([[GRANT_BACKOFF_MS[0]]]);
    expect(addSigners.mock.calls).toStrictEqual([[{ address: TRADING_0, signers: EXACT_SIGNERS }]]);
  });

  it("stops as removed-not-added only after every retry of a grant that never reached Privy", async () => {
    const refreshUser = vi.fn<RefreshUserFn>().mockResolvedValueOnce(seated).mockResolvedValueOnce(cleared).mockRejectedValue(new Error("too_many_requests"));
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    const wait = vi.fn(noWait);
    const stop = reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait });
    await expect(stop).rejects.toMatchObject({ stage: "removed-not-added" });
    expect(wait.mock.calls.map(([ms]) => ms)).toStrictEqual([...GRANT_BACKOFF_MS]);
    expect(addSigners).not.toHaveBeenCalled();
  });

  it("only grants when the record already shows no signer — a previous re-seat's removal — and removes nothing", async () => {
    const refreshUser = reads(cleared, cleared, seated);
    const removeSigners = vi.fn<RemoveSignersFn>(async () => ({}));
    const addSigners = vi.fn<AddSignersFn>(async () => ({}));
    await expect(reseatKeeperSeat({ renderedUser: seated, address: TRADING_0, config: SEAT, removeSigners, addSigners, refreshUser, wait: noWait })).resolves.toBe("granted");
    expect(removeSigners).not.toHaveBeenCalled();
    expect(addSigners.mock.calls).toStrictEqual([[{ address: TRADING_0, signers: EXACT_SIGNERS }]]);
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
    expect(failureText(new ReseatRefused(RESEAT_COPY.notPerWallet))).toBe(RESEAT_COPY.notPerWallet);
    expect(failureText(new ReseatIncomplete("removed-not-added", "Every signer is off."))).toBe("Every signer is off.");
    expect(failureText(new GrantRefused(GRANT_COPY.noServerId))).toBe(GRANT_COPY.noServerId);
  });
});
