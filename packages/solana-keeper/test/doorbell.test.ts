// The doorbell's decisions (src/doorbell.ts), against the transactions that
// taught them.
//
// THE FIXTURES ARE REAL. Five mainnet transactions of 2026-09-23 on the owner's
// own trading wallet and vault, fetched with getTransaction(encoding "json",
// maxSupportedTransactionVersion 1) and trimmed: a RAW Helius delivery is an
// array of exactly those results plus indexWithinBlock. Two of them are why the
// ingest walks strings instead of parsing messages — the Axiom trade is a
// VERSION 1 transaction, and the 1 USDC deposit names the vault only as a token
// balance's owner, never in its account keys.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BELL_ANSWER_MARGIN_MS,
  Doorbell,
  ECHO_DEADLINE_MS,
  HOLD_MS,
  MAX_WALK_DEPTH,
  MAX_WALK_NODES,
  MAX_WALK_STRINGS,
  SAFETY_MIN_PER_SWEEP,
  SAFETY_PASS_MS,
  doorbellDeafAlert,
  investRests,
  settleRests,
  turnRests,
  type DoorLink,
  type TurnInvest,
  type TurnSettle,
} from "../src/doorbell.js";

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/helius-raw-2026-09-23.json", import.meta.url)), "utf8"),
) as Record<string, unknown[]>;

type RawTx = {
  version: number | string;
  blockTime: number;
  transaction: { signatures: string[]; message: { accountKeys: string[] } };
  meta: { preTokenBalances: { owner: string }[]; postTokenBalances: { owner: string }[] };
};
const tx = (name: string): RawTx => fixtures[name]![0] as RawTx;

/** The owner's trading wallet and vault, as watched on 2026-09-23. */
const WALLET = "9QX53J3Kbs8ogQirZq5iN11rucZAvgF4EKWw98QAkUSe";
const VAULT = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";
const VAULT_USDC = "46zCguSBbuStXvbJ3YdxVCVs72gXtDcKJEoseMFv7uof";
const OWNER: DoorLink = { link: "LinkOwner1111111111111111111111111111111111", wallet: WALLET, vault: VAULT };

const known = (links: readonly DoorLink[]): Set<string> => new Set(links.flatMap((link) => [link.wallet, link.vault]));
/** Distinct addresses; their shape does not matter to the doorbell, only their identity. */
let minted = 0;
const fresh = (): DoorLink => {
  minted += 1;
  const id = minted.toString(36).padStart(6, "0");
  return { link: `link-${id}`, wallet: `wallet-${id}`, vault: `vault-${id}` };
};
const fleet = (n: number): DoorLink[] => Array.from({ length: n }, fresh);

const T0 = Date.parse("2026-09-23T12:00:00Z");
const SWEEP = 60_000;

/**
 * A doorbell past its boot: one full pass turned every link and each rested,
 * and one event has been heard, so it is trusted. `now` is where it stands.
 */
function trustedBell(links: readonly DoorLink[], now = T0): Doorbell {
  const bell = new Doorbell(true);
  const first = bell.select({ links, now, sweepMs: SWEEP, protocolPaused: false, live: true });
  expect(first.fullReason).toBe("the first sweep after boot");
  for (const turn of first.turns) bell.recordTurn(turn.link, turn.lane, true, now, "IDLE", now);
  bell.ingest(fixtures["solDepositToVault"], new Set(), now);
  expect(bell.trust(now).trusted).toBe(true);
  return bell;
}

const lanesOf = (bell: Doorbell, links: readonly DoorLink[], now: number, over: { protocolPaused?: boolean; live?: boolean } = {}) =>
  bell.select({ links, now, sweepMs: SWEEP, protocolPaused: over.protocolPaused ?? false, live: over.live ?? true });

describe("the real deliveries of 2026-09-23", () => {
  it("are the shapes the design was measured on", () => {
    // VERSION 1: the public RPC throws unless maxSupportedTransactionVersion >= 1.
    expect(tx("axiomTradeV1").version).toBe(1);
    expect(tx("keeperConvertV0").version).toBe(0);
    expect(Object.keys(tx("keeperSettle")).sort()).toEqual(["blockTime", "indexWithinBlock", "meta", "slot", "transaction", "version"]);
    // THE DEPOSIT THAT NAMES THE VAULT NOWHERE A PARSER WOULD LOOK: not in the
    // account keys, only as the owner of its USDC account's balances.
    const deposit = tx("usdcDepositToVault");
    expect(deposit.transaction.message.accountKeys).not.toContain(VAULT);
    expect(deposit.transaction.message.accountKeys).toContain(VAULT_USDC);
    expect(deposit.meta.preTokenBalances.map((balance) => balance.owner)).toContain(VAULT);
  });

  it("ring exactly the addresses each one touched, whatever the message version", () => {
    const cases: [string, string[]][] = [
      ["usdcDepositToVault", [VAULT]],
      ["axiomTradeV1", [WALLET]],
      ["keeperSettle", [WALLET, VAULT]],
      ["solDepositToVault", [VAULT]],
      ["keeperConvertV0", [VAULT]],
    ];
    for (const [name, expected] of cases) {
      const bell = new Doorbell(true);
      const report = bell.ingest(fixtures[name], known([OWNER]), T0);
      expect(report.transactions, name).toBe(1);
      expect(report.lost, name).toBeNull();
      expect(bell.status(T0).rungAddresses, name).toBe(expected.length);
      // Which ones, through the only door that matters: the lane a link lands in.
      const onlyWallet: DoorLink = { link: "L1", wallet: WALLET, vault: "unrelated-vault" };
      const onlyVault: DoorLink = { link: "L2", wallet: "unrelated-wallet", vault: VAULT };
      bell.ingest(fixtures["axiomTradeV1"], new Set(), T0); // trust, ringing nothing new
      const links = [onlyWallet, onlyVault];
      const booted = lanesOf(bell, links, T0);
      for (const turn of booted.turns) bell.recordTurn(turn.link, turn.lane, true, T0, "IDLE", T0);
      const lanes = new Map(lanesOf(bell, links, T0 + SWEEP).turns.map((turn) => [turn.link.link, turn.lane]));
      expect(lanes.get("L1") === "bell", `${name} rings the wallet`).toBe(expected.includes(WALLET));
      expect(lanes.get("L2") === "bell", `${name} rings the vault`).toBe(expected.includes(VAULT));
    }
  });

  it("hold nothing a stranger sent: unknown strings ring nothing and are not kept", () => {
    const bell = new Doorbell(true);
    const report = bell.ingest([{ transaction: { signatures: ["x"], message: { accountKeys: fleet(50).map((l) => l.wallet) } } }], known([OWNER]), T0);
    expect(report.rung).toBe(0);
    expect(bell.status(T0).rungAddresses).toBe(0);
  });

  it("take the keeper's own settle back as its echo", () => {
    const bell = new Doorbell(true);
    bell.expectEcho(tx("keeperSettle").transaction.signatures[0]!, T0, [WALLET, VAULT]);
    expect(bell.status(T0).echoesPending).toBe(1);
    expect(bell.ingest(fixtures["keeperSettle"], known([OWNER]), T0 + 2_000).echoes).toBe(1);
    expect(bell.status(T0 + 2_000).echoesPending).toBe(0);
    // And an enhanced-shape delivery's top-level signature counts too.
    bell.expectEcho("enhanced-signature", T0, [VAULT]);
    expect(bell.ingest([{ signature: "enhanced-signature", slot: 449756519 }], new Set(), T0).echoes).toBe(1);
  });

  it("report the lag from the block to the delivery", () => {
    const bell = new Doorbell(true);
    const settle = tx("keeperSettle");
    bell.ingest(fixtures["keeperSettle"], known([OWNER]), settle.blockTime * 1000 + 2_500);
    expect(bell.status(settle.blockTime * 1000 + 2_500).lastEventLagMs).toBe(2_500);
  });
});

describe("a delivery that cannot be read whole", () => {
  it("is lost, and the next sweep is a full pass: not JSON", () => {
    const links = fleet(80);
    const bell = trustedBell(links);
    expect(bell.ingestBody("{not json", known(links), T0).lost).toContain("not JSON");
    const next = lanesOf(bell, links, T0 + SWEEP);
    expect(next.fullReason).toContain("not JSON");
    expect(next.turns).toHaveLength(80);
    expect(bell.status(T0).eventsLost).toBe(1);
    // Served once: the sweep after is a selection again.
    expect(lanesOf(bell, links, T0 + 2 * SWEEP).fullReason).toBeNull();
  });

  it("is lost when it nests deeper than the walk goes, or carries more strings than it reads", () => {
    const links = fleet(80);
    const deep = trustedBell(links);
    let nested: unknown = links[0]!.wallet;
    for (let i = 0; i < MAX_WALK_DEPTH + 5; i += 1) nested = [nested];
    expect(deep.ingest(nested, known(links), T0).lost).toContain("deeper");
    expect(lanesOf(deep, links, T0 + SWEEP).fullReason).toContain("deeper");

    const wide = trustedBell(links);
    const many = Array.from({ length: MAX_WALK_STRINGS + 1 }, () => "x");
    expect(wide.ingest(many, known(links), T0).lost).toContain("strings");
    expect(lanesOf(wide, links, T0 + SWEEP).fullReason).toContain("strings");
  });

  it("is also what the receiver reports for an oversize body", () => {
    const links = fleet(80);
    const bell = trustedBell(links);
    bell.lost("a delivery over 4 MiB was refused");
    expect(lanesOf(bell, links, T0 + SWEEP).fullReason).toBe("a delivery over 4 MiB was refused");
  });
});

describe("trust", () => {
  it("is withheld until the first event, and every sweep until then is a full pass", () => {
    const links = fleet(80);
    const bell = new Doorbell(true);
    expect(lanesOf(bell, links, T0).fullReason).toBe("the first sweep after boot");
    const second = lanesOf(bell, links, T0 + SWEEP);
    expect(second.fullReason).toContain("no event has arrived");
    expect(second.turns).toHaveLength(80);
    bell.ingest(fixtures["axiomTradeV1"], known(links), T0 + SWEEP);
    expect(lanesOf(bell, links, T0 + 2 * SWEEP).fullReason).toBeNull();
  });

  it("is lost when the keeper's own transaction does not come back, and regained at the next event", () => {
    const links = fleet(80);
    const bell = trustedBell(links);
    bell.expectEcho("sent-and-never-echoed", T0, [links[0]!.wallet]);
    expect(bell.trust(T0 + ECHO_DEADLINE_MS).trusted).toBe(true);
    const deaf = bell.trust(T0 + ECHO_DEADLINE_MS + 1);
    expect(deaf.trusted).toBe(false);
    expect(deaf.reason).toContain("did not come back");
    const pass = lanesOf(bell, links, T0 + ECHO_DEADLINE_MS + 2);
    expect(pass.fullReason).toContain("did not come back");
    expect(pass.turns).toHaveLength(80);
    expect(bell.status(T0 + ECHO_DEADLINE_MS + 2)).toMatchObject({ echoesPending: 0, echoesMissed: 1, trusted: false });
    // HEARD AGAIN.
    bell.ingest(fixtures["solDepositToVault"], known(links), T0 + ECHO_DEADLINE_MS + 3);
    expect(bell.trust(T0 + ECHO_DEADLINE_MS + 3).trusted).toBe(true);
  });

  it("expects no echo for a transaction on addresses the managed webhook does not hold yet", () => {
    const links = fleet(80);
    const bell = trustedBell(links);
    const newcomer = fresh();
    bell.setWatched(known(links));
    // A new link's first settle, sent before the debounced edit added its wallet.
    bell.expectEcho("first-settle-of-a-new-link", T0, [newcomer.wallet, newcomer.vault]);
    expect(bell.status(T0).echoesPending).toBe(0);
    expect(bell.trust(T0 + ECHO_DEADLINE_MS + 1).trusted).toBe(true);
    // One of the addresses watched is enough: the transaction touches it, so Helius delivers it.
    bell.expectEcho("settle-of-a-watched-wallet", T0, [links[3]!.wallet, newcomer.vault]);
    expect(bell.status(T0).echoesPending).toBe(1);
  });

  it("turns everyone after a sweep that failed before it turned what it selected, without counting a lost event", () => {
    const links = fleet(80);
    const bell = trustedBell(links);
    bell.requestFullPass("the previous sweep failed before it turned every link it selected");
    expect(lanesOf(bell, links, T0 + SWEEP).fullReason).toContain("previous sweep failed");
    expect(bell.status(T0 + SWEEP).eventsLost).toBe(0);
  });

  it("is never given to a doorbell that is off", () => {
    const links = fleet(80);
    const bell = new Doorbell(false);
    bell.ingest(fixtures["axiomTradeV1"], known(links), T0);
    for (let i = 0; i < 3; i += 1) {
      const pass = lanesOf(bell, links, T0 + i * SWEEP);
      expect(pass.fullReason).toContain("off");
      expect(pass.turns).toHaveLength(80);
    }
  });

  it("raises doorbell-deaf only for a doorbell that was trusted, and clears it when regained", () => {
    expect(doorbellDeafAlert({ trusted: false, reason: "no event yet" }, false)).toEqual({ fire: null, clear: false });
    expect(doorbellDeafAlert({ trusted: false, reason: "echo overdue" }, true).fire).toMatchObject({ key: "doorbell-deaf", severity: "warn" });
    expect(doorbellDeafAlert({ trusted: true, reason: null }, true)).toEqual({ fire: null, clear: true });
  });
});

describe("the selection", () => {
  it("turns every link every sweep at fifty or fewer — zero change at hackathon scale", () => {
    const links = fleet(SAFETY_MIN_PER_SWEEP);
    const bell = trustedBell(links);
    for (let i = 1; i <= 5; i += 1) {
      const sweep = lanesOf(bell, links, T0 + i * SWEEP);
      expect(sweep.fullReason).toBeNull();
      expect(sweep.turns).toHaveLength(SAFETY_MIN_PER_SWEEP);
      for (const turn of sweep.turns) bell.recordTurn(turn.link, turn.lane, true, T0 + i * SWEEP, "IDLE", T0 + i * SWEEP);
    }
  });

  it("reaches every one of 10,000 resting links within thirty minutes, and no more than it needs per sweep", () => {
    const links = fleet(10_000);
    const bell = trustedBell(links);
    const k = Math.ceil((10_000 * SWEEP) / SAFETY_PASS_MS);
    expect(k).toBe(334);
    const seen = new Set<string>();
    const sweeps = SAFETY_PASS_MS / SWEEP;
    for (let i = 1; i <= sweeps; i += 1) {
      const now = T0 + i * SWEEP;
      const sweep = lanesOf(bell, links, now);
      expect(sweep.lanes).toEqual({ full: 0, bell: 0, busy: 0, new: 0, safety: k });
      for (const turn of sweep.turns) {
        seen.add(turn.link.link);
        bell.recordTurn(turn.link, turn.lane, true, now, "IDLE", now);
      }
    }
    expect(seen.size).toBe(10_000);
  });

  it("keeps a link that did not rest in the busy lane, sweep after sweep, and treats a never-turned one the same", () => {
    const links = fleet(200);
    const bell = trustedBell(links);
    const stuck = links[7]!;
    bell.recordTurn(stuck, "full", false, T0, "PENDING_FINALITY", T0);
    for (let i = 1; i <= 10; i += 1) {
      const sweep = lanesOf(bell, links, T0 + i * SWEEP);
      expect(sweep.turns.find((turn) => turn.link.link === stuck.link)?.lane).toBe("busy");
      bell.recordTurn(stuck, "busy", false, T0 + i * SWEEP, "RETRY", T0 + i * SWEEP);
    }
  });

  it("rings every link of a rung vault, and lets the bell go after the hold once a turn has answered it", () => {
    const links = fleet(200);
    const shared = links[0]!.vault;
    const second: DoorLink = { link: "zzSecondLinkOfSameVault", wallet: "wallet-of-the-second-link", vault: shared };
    const all = [...links, second];
    const bell = trustedBell(all);
    bell.ingest([{ meta: { postTokenBalances: [{ owner: shared }] } }], known(all), T0 + 10_000);
    const rung = lanesOf(bell, all, T0 + SWEEP);
    const bellLane = rung.turns.filter((turn) => turn.lane === "bell").map((turn) => turn.link.link).sort();
    expect(bellLane).toEqual([links[0]!.link, second.link].sort());
    // Both turns began 50 s after the ring and rested: the ring is answered.
    for (const turn of rung.turns.filter((turn) => turn.lane === "bell")) bell.recordTurn(turn.link, "bell", true, T0 + SWEEP, "IDLE", T0 + SWEEP);
    expect(lanesOf(bell, all, T0 + 10_000 + HOLD_MS).turns.filter((turn) => turn.lane === "bell")).toHaveLength(2);
    expect(lanesOf(bell, all, T0 + 10_000 + HOLD_MS + 1).turns.filter((turn) => turn.lane === "bell")).toHaveLength(0);
  });

  it("turns a newly discovered link at once, and one whose addresses the webhook does not hold yet on every sweep", () => {
    const links = fleet(200);
    const bell = trustedBell(links);
    const newcomer = fresh();
    const withNew = [...links, newcomer];
    expect(lanesOf(bell, withNew, T0 + SWEEP).turns.find((turn) => turn.link.link === newcomer.link)?.lane).toBe("new");
    bell.recordTurn(newcomer, "new", true, T0 + SWEEP, "IDLE", T0 + SWEEP);
    // RESTING, AND UNWATCHED: the managed webhook has not taken its addresses yet.
    bell.setWatched(known(links));
    for (let i = 2; i <= 4; i += 1) {
      expect(lanesOf(bell, withNew, T0 + i * SWEEP).turns.find((turn) => turn.link.link === newcomer.link)?.lane).toBe("new");
    }
    bell.setWatched(known(withNew));
    const watchedNow = lanesOf(bell, withNew, T0 + 5 * SWEEP).turns.find((turn) => turn.link.link === newcomer.link);
    expect(watchedNow?.lane === "new").toBe(false);
  });

  it("turns everyone when the protocol is unpaused, and when this instance takes over the claim", () => {
    const links = fleet(200);
    const bell = trustedBell(links);
    lanesOf(bell, links, T0 + SWEEP, { protocolPaused: true });
    expect(lanesOf(bell, links, T0 + 2 * SWEEP, { protocolPaused: false }).fullReason).toBe("the protocol was unpaused");
    expect(lanesOf(bell, links, T0 + 3 * SWEEP, { live: false }).fullReason).toBeNull();
    const takeover = lanesOf(bell, links, T0 + 4 * SWEEP, { live: true });
    expect(takeover.fullReason).toBe("this instance just became the acting keeper");
    expect(takeover.turns).toHaveLength(200);
  });

  it("counts a safety-lane turn that came out busy with no bell as a possible miss, and a rung one as nothing", () => {
    const links = fleet(200);
    const bell = trustedBell(links);
    const sweep = lanesOf(bell, links, T0 + SWEEP);
    const [first, second] = sweep.turns.filter((turn) => turn.lane === "safety");
    bell.recordTurn(first!.link, "safety", false, T0 + SWEEP, "SETTLED", T0 + SWEEP);
    expect(bell.status(T0 + SWEEP)).toMatchObject({ possibleMisses: 1, lastPossibleMiss: { wallet: first!.link.wallet, outcome: "SETTLED" } });
    // The bell arrived while the turn ran: late, not missed.
    bell.ingest([{ transaction: { signatures: ["late"], message: { accountKeys: [second!.link.wallet] } } }], known(links), T0 + SWEEP);
    bell.recordTurn(second!.link, "safety", false, T0 + SWEEP, "PENDING_FINALITY", T0 + SWEEP);
    // A resting safety turn is the net doing its job quietly.
    bell.recordTurn(first!.link, "safety", true, T0 + SWEEP, "IDLE", T0 + SWEEP);
    expect(bell.status(T0 + SWEEP).possibleMisses).toBe(1);
  });

  it("orders turns by link address, whatever order discovery returned", () => {
    const links = fleet(30);
    const bell = new Doorbell(true);
    const turns = lanesOf(bell, [...links].reverse(), T0).turns.map((turn) => turn.link.link);
    expect(turns).toEqual([...turns].sort());
  });
});

describe("which finished turns may rest", () => {
  // TYPED AS A RECORD OVER EVERY MEMBER, so this table stops compiling the day
  // an outcome is added — the same guarantee the switch in doorbell.ts gives.
  const settle: Record<TurnSettle, boolean> = {
    IDLE: true,
    PENDING_FINALITY: false,
    SETTLED: false,
    NO_PROFIT: true,
    INCOMPLETE: false,
    NO_SIGNER: false,
    UNSUPPORTED_MODE: true,
    PAUSED: true,
    BELOW_RESERVE: true,
    RETRY: false,
    FAILED: false,
    THREW: false,
  };
  const invest: Record<TurnInvest, boolean> = {
    IDLE: true,
    NO_POLICY: true,
    PAUSED: true,
    INVESTED: false,
    REFUSED: false,
    FAILED: false,
    THREW: false,
  };

  it("classifies every settle outcome", () => {
    for (const [outcome, rests] of Object.entries(settle)) expect(settleRests(outcome as TurnSettle), outcome).toBe(rests);
  });

  it("classifies every invest outcome", () => {
    for (const [outcome, rests] of Object.entries(invest)) expect(investRests(outcome as TurnInvest), outcome).toBe(rests);
  });

  it("calls an outcome this build does not know busy, the direction that loses nothing", () => {
    expect(settleRests("SOMETHING_NEWER" as TurnSettle)).toBe(false);
    expect(investRests("SOMETHING_NEWER" as TurnInvest)).toBe(false);
  });

  it("rests a turn only when both halves rest, the invest half ran, and the crank was not short", () => {
    expect(turnRests({ settle: "IDLE", invest: "IDLE" })).toBe(true);
    expect(turnRests({ settle: "IDLE", invest: "INVESTED" })).toBe(false);
    expect(turnRests({ settle: "SETTLED", invest: "IDLE" })).toBe(false);
    expect(turnRests({ settle: "THREW", invest: null })).toBe(false);
    expect(turnRests({ settle: "IDLE", invest: null })).toBe(false);
    // A CRANK TOO SHORT TO WRAP comes back IDLE, and a crank refill rings no bell.
    expect(turnRests({ settle: "IDLE", invest: "IDLE", wrapShort: true })).toBe(false);
  });
});

// ── what the review of 2026-09-23 found ──────────────────────────────────────

describe("a bell is answered by a turn, not by the clock", () => {
  // THE INCIDENT: a bell pruned 180 s after it rang, whatever had happened in
  // between. Three sweeps that threw in readChainSnapshot (or one full pass that
  // took longer than the hold, which at the measured 210 ms per idle user is
  // any fleet past ~850 links) and the trade's bell was gone before any select
  // could act on it; the link had rested IDLE, so it waited for the safety lane.
  it("still turns a rung link at the first select after an outage longer than the hold", () => {
    const links = fleet(1_000);
    const bell = trustedBell(links);
    const traded = links[500]!;
    bell.ingest([{ slot: 1, transaction: { signatures: ["trade"], message: { accountKeys: [traded.wallet] } } }], known(links), T0 + 10_000);
    // The sweeps at +60, +120 and +180 threw before select; this is the next one.
    const after = lanesOf(bell, links, T0 + 10_000 + HOLD_MS + 50_000);
    expect(after.turns.find((turn) => turn.link.link === traded.link)?.lane).toBe("bell");
  });

  it("keeps the bell through a turn that started before it rang, or too soon after it to see the trade", () => {
    const links = fleet(200);
    const bell = trustedBell(links);
    const traded = links[42]!;
    const rungAt = T0 + 30_000;
    bell.ingest([{ slot: 1, transaction: { signatures: ["trade"], message: { accountKeys: [traded.wallet] } } }], known(links), rungAt);
    // A turn that began before the ring and came out IDLE: it cannot have seen the trade.
    bell.recordTurn(traded, "safety", true, rungAt + 5_000, "IDLE", rungAt - 1_000);
    // One that began a moment after the ring, before the keeper's endpoint could show it.
    bell.recordTurn(traded, "bell", true, rungAt + 6_000, "IDLE", rungAt + 1_000);
    const later = lanesOf(bell, links, rungAt + HOLD_MS + 60_000);
    expect(later.turns.find((turn) => turn.link.link === traded.link)?.lane).toBe("bell");
    // A resting turn that began well after the ring answers it; past the hold, it is let go.
    const answeredAt = rungAt + HOLD_MS + 60_000;
    bell.recordTurn(traded, "bell", true, answeredAt + 2_000, "IDLE", answeredAt);
    const next = lanesOf(bell, links, answeredAt + SWEEP);
    expect(next.turns.find((turn) => turn.link.link === traded.link)?.lane === "bell").toBe(false);
  });

  it("keeps the bell for at least the hold even when answered at once", () => {
    const links = fleet(200);
    const bell = trustedBell(links);
    const traded = links[9]!;
    bell.ingest([{ slot: 1, transaction: { signatures: ["trade"], message: { accountKeys: [traded.wallet] } } }], known(links), T0);
    bell.recordTurn(traded, "bell", true, T0 + 45_000, "IDLE", T0 + 40_000);
    expect(lanesOf(bell, links, T0 + HOLD_MS).turns.find((turn) => turn.link.link === traded.link)?.lane).toBe("bell");
    expect(lanesOf(bell, links, T0 + HOLD_MS + 1).turns.find((turn) => turn.link.link === traded.link)?.lane === "bell").toBe(false);
  });

  it("forgets the bell of an address no longer discovered", () => {
    const links = fleet(200);
    const bell = trustedBell(links);
    const leaving = links[3]!;
    bell.ingest([{ slot: 1, transaction: { signatures: ["x"], message: { accountKeys: [leaving.wallet] } } }], known(links), T0);
    lanesOf(bell, links.filter((link) => link !== leaving), T0 + SWEEP);
    expect(bell.status(T0 + SWEEP).rungAddresses).toBe(0);
  });
});

describe("the safety lane's thirty minutes are real minutes", () => {
  // THE INCIDENT: k was sized from the CONFIGURED interval. Sweeps that overran
  // (a thousand NO_SIGNER links in the busy lane) had their ticks skipped, ran
  // every 240 s, and the rotation that should take 30 min took 120.
  it("sizes the slice from the time since the last select, so 4-minute sweeps still reach everyone within thirty minutes", () => {
    const links = fleet(10_000);
    const bell = trustedBell(links);
    const interval = 4 * SWEEP;
    const last = new Map(links.map((link) => [link.link, T0]));
    for (let now = T0 + interval; now <= T0 + 3 * SAFETY_PASS_MS; now += interval) {
      const sweep = bell.select({ links, now, sweepMs: SWEEP, protocolPaused: false, live: true });
      expect(sweep.lanes.safety).toBe(Math.ceil((10_000 * interval) / SAFETY_PASS_MS));
      for (const turn of sweep.turns) {
        bell.recordTurn(turn.link, turn.lane, true, now, "IDLE", now);
        last.set(turn.link.link, now);
      }
      for (const [link, at] of last) expect(now - at, link).toBeLessThanOrEqual(SAFETY_PASS_MS);
    }
  });
});

describe("an echo that arrives before the keeper says it expects one", () => {
  // THE INCIDENT: runSettleTick returns only after it has polled the signature
  // to confirmed and read the receipt; Helius delivers 200-500 ms after
  // confirmation. The real settle 5nGb2hqz…, delivered at T0 and expected at
  // T0 + 1.5 s, made a working webhook "deaf" five minutes later.
  it("is still an echo: the doorbell stays trusted past the deadline", () => {
    const links = fleet(80);
    const bell = trustedBell(links);
    const settle = tx("keeperSettle");
    bell.ingest(fixtures["keeperSettle"], known([...links, OWNER]), T0 + 10_000);
    bell.expectEcho(settle.transaction.signatures[0]!, T0 + 11_500, [WALLET, VAULT]);
    expect(bell.status(T0 + 11_500).echoesPending).toBe(0);
    const trust = bell.trust(T0 + 11_500 + ECHO_DEADLINE_MS + 1);
    expect(trust).toEqual({ trusted: true, reason: null });
    expect(bell.status(T0 + 11_500 + ECHO_DEADLINE_MS + 1).echoesMissed).toBe(0);
  });
});

describe("what a delivery must look like to count", () => {
  // THE INCIDENT (with the secret in hand): `[{}]` made the doorbell trusted and
  // cleared deafness while naming no transaction at all, and 4 MiB of empty
  // objects walked 1.4 million nodes without being called lost.
  it("counts as a transaction only an item with a signature and a slot", () => {
    const bell = new Doorbell(true);
    expect(bell.ingest([{}, [], 1, { transaction: {} }, { signature: "no-slot" }], new Set(), T0).transactions).toBe(0);
    expect(bell.trust(T0).trusted).toBe(false);
    expect(bell.ingest([{ slot: 7, signature: "enhanced" }], new Set(), T0).transactions).toBe(1);
    expect(bell.trust(T0).trusted).toBe(true);
  });

  it("is lost past MAX_WALK_NODES nodes of any kind, not only strings", () => {
    const links = fleet(80);
    const bell = trustedBell(links);
    const empties = Array.from({ length: MAX_WALK_NODES }, () => ({}));
    expect(bell.ingest(empties, known(links), T0).lost).toContain("nodes");
    expect(lanesOf(bell, links, T0 + SWEEP).fullReason).toContain("nodes");
  });
});

describe("a refused delivery before the webhook is known to hold the secret", () => {
  // THE INCIDENT: the secret rotated in Railway; Helius kept sending the old
  // header until the new instance's sync PUT the new one. Every delivery in
  // between was refused 403 — the one 4xx Helius never resends — and counted,
  // nothing more. The first good delivery then trusted a doorbell that had
  // silently lost those trades.
  it("makes the sweep after the first good delivery a full pass, not a selection", () => {
    const links = fleet(80);
    const bell = new Doorbell(true);
    const boot = lanesOf(bell, links, T0);
    for (const turn of boot.turns) bell.recordTurn(turn.link, turn.lane, true, T0, "IDLE", T0);
    // The boot pass has turned everyone; a trade's delivery is refused with the old header.
    bell.rejected();
    // The sync writes the new header; the first delivery with it arrives.
    bell.ingest(fixtures["solDepositToVault"], new Set(), T0 + 30_000);
    expect(bell.trust(T0 + SWEEP).trusted).toBe(true);
    const next = lanesOf(bell, links, T0 + SWEEP);
    expect(next.fullReason).toContain("refused 403");
    expect(next.turns).toHaveLength(80);
  });

  it("is noise once the header is confirmed, by an authenticated delivery or by a sync", () => {
    const links = fleet(80);
    const byDelivery = trustedBell(links);
    byDelivery.rejected();
    expect(lanesOf(byDelivery, links, T0 + SWEEP).fullReason).toBeNull();
    expect(byDelivery.status(T0).eventsRejected).toBe(1);

    const bySync = new Doorbell(true);
    lanesOf(bySync, links, T0);
    bySync.confirmAuthorization();
    bySync.rejected();
    bySync.ingest(fixtures["solDepositToVault"], new Set(), T0 + 30_000);
    expect(lanesOf(bySync, links, T0 + SWEEP).fullReason).toBeNull();
  });
});

describe("addresses the webhook starts watching", () => {
  // A new link was turned in the "new" lane until the edit landed; a trade
  // between its last turn and the landing was never delivered, and the sweep
  // after the landing let it rest. The addresses an edit ADDS ring at once.
  it("ring when the edit lands, so the link is turned after it", () => {
    const links = fleet(200);
    const bell = trustedBell(links);
    const newcomer = links[77]!;
    bell.setWatched(known(links.filter((link) => link !== newcomer)), [], T0);
    bell.setWatched(known(links), [newcomer.wallet, newcomer.vault], T0 + 30_000);
    const next = lanesOf(bell, links, T0 + SWEEP);
    expect(next.turns.find((turn) => turn.link.link === newcomer.link)?.lane).toBe("bell");
  });
});

describe("the constants the design is argued from", () => {
  // A tuning edit to any of these passes every relative test; these hold the values.
  it("holds a bell three minutes: a 60 s sweep, ~13 s of finality and a margin", () => {
    expect(HOLD_MS).toBe(180_000);
    expect(HOLD_MS).toBeGreaterThanOrEqual(2 * SWEEP + 13_000);
  });

  it("gives an echo five minutes, and answers a bell only from a turn started 20 s after it", () => {
    expect(ECHO_DEADLINE_MS).toBe(300_000);
    expect(BELL_ANSWER_MARGIN_MS).toBe(20_000);
  });
});
