// A claim lost in the middle of a sweep takes the keys away from the very next
// turn.
//
// The keeper once read isLive() once per sweep and handed that value to every
// wallet turn. The claim's database session can drop mid-sweep, and its callback
// releases the claim, but the stored value stayed true, so the rest of the sweep
// kept signing and investing while another instance could take over. keysForTurn
// is how bin/keeper.mts hands a tick its keys; this drives it through the real
// KeeperClaim and missingLiveCondition, the same pair keeper.mts composes.

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { keysForTurn, missingLiveCondition, type LiveVerification } from "../src/chain-state.js";
import { KEEPER_LOCK_NAME, KeeperClaim } from "../src/singleton.js";

const settleKey = Keypair.generate();
const walletSigner = Keypair.generate();

describe("the keys a turn is handed", () => {
  it("are taken away from the next turn when the claim is lost mid-sweep", async () => {
    let released = 0;
    const claim = new KeeperClaim({
      armed: true,
      attempt: async () => ({ held: true, release: () => void (released += 1) }),
    });
    const verification: LiveVerification = { kind: "verified" };
    const isLive = (): boolean => missingLiveCondition({ armed: true, verification, claimLive: claim.live }) === null;

    expect(await claim.ensure()).toBe(true);
    // The first wallet's turn, while the claim is held.
    expect(keysForTurn(isLive, { settleKey, walletSigner })).toEqual({ live: true, settleKey, walletSigner });

    // What the claim's onLost callback does when its session drops.
    claim.release();
    expect(released).toBe(1);

    // The next wallet's turn, in the same sweep: dry, and no key in reach.
    expect(keysForTurn(isLive, { settleKey, walletSigner })).toEqual({ live: false, settleKey: null, walletSigner: null });
    expect(keysForTurn(isLive, { settleKey, walletSigner: null })).toEqual({ live: false, settleKey: null, walletSigner: null });
    expect(missingLiveCondition({ armed: true, verification, claimLive: claim.live })).toContain(KEEPER_LOCK_NAME);
  });

  it("are never handed to an unarmed or unverified keeper", () => {
    const unarmed = (): boolean => missingLiveCondition({ armed: false, verification: { kind: "verified" }, claimLive: true }) === null;
    expect(keysForTurn(unarmed, { settleKey, walletSigner })).toEqual({ live: false, settleKey: null, walletSigner: null });

    const unverified = (): boolean =>
      missingLiveCondition({ armed: true, verification: { kind: "unreadable", detail: "rpc" }, claimLive: true }) === null;
    expect(keysForTurn(unverified, { settleKey, walletSigner })).toEqual({ live: false, settleKey: null, walletSigner: null });
  });

  it("asks isLive at every call, never caching it", () => {
    let calls = 0;
    const isLive = (): boolean => {
      calls += 1;
      return calls === 1;
    };
    expect(keysForTurn(isLive, { settleKey, walletSigner }).live).toBe(true);
    expect(keysForTurn(isLive, { settleKey, walletSigner }).live).toBe(false);
    expect(calls).toBe(2);
  });
});
