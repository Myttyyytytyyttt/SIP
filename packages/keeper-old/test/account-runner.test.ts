// Many accounts in one process, without them touching each other.
//
// Separate processes gave isolation for free, at 73 MB each. Sharing a process
// makes that isolation something the code has to earn, and there are exactly two
// ways to lose it:
//
//   * CONFIGURATION LEAKING BETWEEN ACCOUNTS. Two accounts, one process, and a
//     shared or mutated config object is a settlement paid into a stranger's
//     vault. Every test below that compares two runners exists for that.
//   * ONE ACCOUNT'S FAILURE ENDING THE SWEEP. An unhandled throw would stop
//     every other account from being ticked, which is the blast radius the
//     processes existed to prevent, reintroduced.
//
// The advisory-lock tests need a real Postgres and skip loudly without one.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AccountRunner,
  anchorReport,
  type AccountSpec,
  type RunnerEnvironment,
} from "../src/account-runner.js";
import { createLogger, Redactor } from "../src/log.js";

const ATTESTER = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const RPC = "https://example.invalid/v2/key";

const A: AccountSpec = {
  account: "0x00000000000000000000000000000000000000a1",
  vault: "0x00000000000000000000000000000000000000d1",
  walletId: "wallet-a",
};
const B: AccountSpec = {
  account: "0x00000000000000000000000000000000000000b1",
  vault: "0x00000000000000000000000000000000000000d2",
  walletId: "wallet-b",
};

const dirs: string[] = [];
const runners: AccountRunner[] = [];

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nuvem-runner-"));
  dirs.push(dir);
  return dir;
}

function environment(over: Partial<RunnerEnvironment> = {}): RunnerEnvironment {
  return {
    baseEnv: {
      NUVEM_RPC_URL: RPC,
      NUVEM_ATTESTER_PRIVATE_KEY: ATTESTER,
      NUVEM_KEEPER_STATE_DIR: stateDir(),
    },
    broadcast: false,
    logger: createLogger({ redactor: new Redactor(), base: {} }),
    makeTradingSigner: () => null,
    makeAttesterSigner: () => null,
    firstAnchor: async () => 0n,
    ...over,
  };
}

async function claim(spec: AccountSpec, env: RunnerEnvironment): Promise<AccountRunner> {
  const result = await AccountRunner.claim(spec, env);
  if (!(result instanceof AccountRunner)) {
    throw new Error(`claim failed: ${JSON.stringify(result)}`);
  }
  runners.push(result);
  return result;
}

afterEach(async () => {
  while (runners.length > 0) await runners.pop()!.release();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("two accounts sharing one process", () => {
  /**
   * THE ONE THAT MATTERS. A leaked vault reference is a settlement into someone
   * else's savings, and it would look like ordinary operation until the money
   * arrived in the wrong place.
   */
  it("gives each account its own vault, and never the other's", async () => {
    const env = environment();
    const a = await claim(A, env);
    const b = await claim(B, env);

    expect(a.config.vault.toLowerCase()).toBe(A.vault.toLowerCase());
    expect(b.config.vault.toLowerCase()).toBe(B.vault.toLowerCase());
    expect(a.config.vault).not.toBe(b.config.vault);
  });

  it("gives each account its own account address", async () => {
    const env = environment();
    const a = await claim(A, env);
    const b = await claim(B, env);
    expect(a.config.account.toLowerCase()).toBe(A.account.toLowerCase());
    expect(b.config.account.toLowerCase()).toBe(B.account.toLowerCase());
  });

  it("hands each account a config object of its own, not a shared one", async () => {
    // Same object would mean the second claim silently rewrote the first's vault.
    const env = environment();
    const a = await claim(A, env);
    const b = await claim(B, env);
    expect(a.config).not.toBe(b.config);
  });

  it("keeps each account's journal in its own directory", async () => {
    const env = environment();
    const a = await claim(A, env);
    const b = await claim(B, env);
    expect(a.config.stateDir).not.toBe(b.config.stateDir);
    expect(a.config.stateDir).toContain(A.account.toLowerCase());
    expect(b.config.stateDir).toContain(B.account.toLowerCase());
  });

  it("binds the trading signer to the account it was built for", async () => {
    // A signer shared between accounts would sign one account's settlement as
    // the other — msg.sender decides the vault, so that is the same disaster by
    // a different route.
    const seen: string[] = [];
    const env = environment({
      makeTradingSigner: (spec) => {
        seen.push(spec.walletId);
        return null;
      },
    });
    await claim(A, env);
    await claim(B, env);
    expect(seen).toEqual(["wallet-a", "wallet-b"]);
  });
});

describe("where a brand-new account starts scanning", () => {
  /**
   * THE ONE THAT COST HOURS IN PRODUCTION. `firstAnchor` was declared, was
   * defined by the supervisor, and was never called — so a fresh account fell
   * back to the keeper's default of block 0 and walked the entire chain one
   * window per tick. On Railway that showed up as an anchor of 6,330,000
   * against a head of 35,748,202, 212 ticks in.
   *
   * What makes it worth a test is that it does not look broken: every tick
   * returns NO_CANDIDATE in a few hundred milliseconds, reports healthy, and
   * costs ten RPC calls. Only the anchor says anything is wrong.
   */
  it("starts near the head, not at genesis", async () => {
    const env = environment({ firstAnchor: async () => 35_740_000n });
    const runner = await claim(A, env);
    expect(runner.config.fromBlockL2).toBe(35_740_000n);
  });

  it("asks the supervisor where to start, rather than assuming", async () => {
    let asked = 0;
    const env = environment({
      firstAnchor: async () => {
        asked += 1;
        return 1_000n;
      },
    });
    await claim(A, env);
    expect(asked).toBe(1);
  });

  it("does not re-anchor an account that already has a journal", async () => {
    // Re-anchoring a running account would skip every session between its real
    // watermark and the head — silently, and as lost savings.
    const dir = stateDir();
    const env = environment({ baseEnv: { NUVEM_RPC_URL: RPC, NUVEM_ATTESTER_PRIVATE_KEY: ATTESTER, NUVEM_KEEPER_STATE_DIR: dir }, firstAnchor: async () => 999n });
    const first = await claim(A, env);
    await first.release();
    runners.pop();

    let askedAgain = 0;
    const second = environment({
      baseEnv: { NUVEM_RPC_URL: RPC, NUVEM_ATTESTER_PRIVATE_KEY: ATTESTER, NUVEM_KEEPER_STATE_DIR: dir },
      firstAnchor: async () => {
        askedAgain += 1;
        return 5_000n;
      },
    });
    await claim(A, second);
    expect(askedAgain).toBe(0);
  });
});

describe("what the fallback anchor turned out to mean", () => {
  /**
   * THE ONE THAT CRIED WOLF. A stateless container has no local index, so every
   * redeploy computes a fallback anchor near the head — and the old code
   * announced "sessions that closed before this block are not picked up" every
   * single time. That is false whenever Postgres has history, which on a live
   * deployment is always. A warning that is usually wrong is worse than none:
   * it is the one nobody reads on the day it is right.
   */
  it("does not claim sessions were skipped when the journal had the watermark", () => {
    const report = anchorReport(35_840_519n, 35_700_000n);
    expect(report?.kind).toBe("RESUMED");
    if (report?.kind !== "RESUMED") return;
    // And it resumes from the JOURNAL, not from the fallback — settling from the
    // fallback would skip every session in between.
    expect(report.anchor).toBe(35_700_000n);
    expect(report.unusedFallback).toBe(35_840_519n);
  });

  it("still warns when there is genuinely no history", () => {
    // The case the warning was always for: no local index AND no durable log.
    const report = anchorReport(35_840_519n, null);
    expect(report?.kind).toBe("FIRST_START");
    if (report?.kind !== "FIRST_START") return;
    expect(report.anchor).toBe(35_840_519n);
  });

  it("says nothing when the local index survived", () => {
    // No fallback was computed, so there is no claim to make in either direction.
    expect(anchorReport(null, 35_700_000n)).toBeNull();
    expect(anchorReport(null, null)).toBeNull();
  });

  it("treats block zero as a real watermark, not as absent", () => {
    // 0n is falsy. A truthiness check here would report a first start for an
    // account anchored at genesis and re-scan from the fallback.
    const report = anchorReport(100n, 0n);
    expect(report?.kind).toBe("RESUMED");
  });
});

describe("a claim that cannot be granted", () => {
  it("reports a bad configuration as its own kind, with the problems", async () => {
    const env = environment({ baseEnv: { NUVEM_KEEPER_STATE_DIR: stateDir() } });
    const result = await AccountRunner.claim(A, env);
    expect(result).not.toBeInstanceOf(AccountRunner);
    if (result instanceof AccountRunner) return;
    expect(result.kind).toBe("MISCONFIGURED");
    if (result.kind !== "MISCONFIGURED") return;
    // Naming what is wrong is the difference between a fixable message and a
    // supervisor that just skips an account forever.
    expect(result.problems.join(" ")).toMatch(/NUVEM_RPC_URL/);
  });

  it("does not throw, so a sweep over many accounts can carry on", async () => {
    const env = environment({ baseEnv: { NUVEM_KEEPER_STATE_DIR: stateDir() } });
    await expect(AccountRunner.claim(A, env)).resolves.toBeDefined();
  });
});

describe("a claim refused after the journal was already open", () => {
  /**
   * THE LOCK MUST NOT SURVIVE THE REFUSAL, and this is the one claim failure
   * that can strand it. Every other one returns BEFORE `openJournal`; the
   * investment-config check runs AFTER it, so by the time an unusable pool list
   * is discovered this process already holds the account's lock.
   *
   * Leaking it is worse than it sounds. The supervisor never retries an account
   * it has marked broken, and the held lock stops any OTHER instance claiming it
   * too — so a single bad environment variable takes the account offline until
   * the process is restarted, and fixing the variable alone does not bring it
   * back.
   *
   * The local journal's lock is a file, so the test looks for the file. The
   * durable journal's is a Postgres advisory lock on the same connection, and
   * `close()` is what releases both.
   */
  it("releases the journal it opened, instead of stranding the lock", async () => {
    const base = stateDir();
    const result = await AccountRunner.claim(
      A,
      environment({
        baseEnv: {
          NUVEM_RPC_URL: RPC,
          NUVEM_ATTESTER_PRIVATE_KEY: ATTESTER,
          NUVEM_KEEPER_STATE_DIR: base,
          // Present and unusable: a pool is named, but not the pool manager it
          // would have to be quoted against.
          NUVEM_INVEST_POOLS: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC:3000:60",
        },
      }),
    );

    expect(result).not.toBeInstanceOf(AccountRunner);
    if (result instanceof AccountRunner) return;
    expect(result.kind).toBe("MISCONFIGURED");
    expect(result.kind === "MISCONFIGURED" && result.problems.join(" ")).toContain("NUVEM_POOL_MANAGER");

    expect(existsSync(join(base, A.account.toLowerCase(), "keeper.lock"))).toBe(false);
  });

  /**
   * The mirror image, so the test above is not passing because nothing ever
   * locks: a claim that SUCCEEDS holds the lock, and the file is there.
   */
  it("does hold the lock when the claim succeeds, so the check above means something", async () => {
    const base = stateDir();
    const runner = await claim(
      A,
      environment({
        baseEnv: {
          NUVEM_RPC_URL: RPC,
          NUVEM_ATTESTER_PRIVATE_KEY: ATTESTER,
          NUVEM_KEEPER_STATE_DIR: base,
        },
      }),
    );
    expect(runner).toBeInstanceOf(AccountRunner);
    expect(existsSync(join(base, A.account.toLowerCase(), "keeper.lock"))).toBe(true);
  });
});

describe("one account failing", () => {
  /**
   * With a bad RPC every tick throws. What must NOT happen is the throw escaping
   * and ending the loop that ticks everybody else.
   */
  it("contains the failure instead of ending the sweep", async () => {
    const env = environment();
    const a = await claim(A, env);
    const b = await claim(B, env);

    const first = await a.tick();
    const second = await b.tick();

    // Both were attempted; neither prevented the other.
    expect(first).toBeDefined();
    expect(second).toBeDefined();
  }, 30_000);
});
