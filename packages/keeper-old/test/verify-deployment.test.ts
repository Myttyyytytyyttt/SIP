// The check that would have caught a months-long silent outage.
//
// config.ts's MAINNET constants are consulted only when their environment
// variable is absent. After a redeployment that means the unset ones keep
// pointing at the previous release — every value plausible, nothing comparing
// them to anything — until settlement starts deferring with ATTESTER_MISMATCH
// and the cause is four layers away from the symptom.
//
// The tests that matter here are the PARTIAL ones: a configuration where the
// factory and executor were updated and the other two were forgotten is exactly
// what an operator produces when they change the two variables they remember.

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_CONFIGURATION_ABI,
  describeVerdict,
  resolveExpectation,
  verifyDeployment,
  type DeploymentExpectation,
  type OnChainConfiguration,
} from "../src/verify-deployment.js";
import { MAINNET } from "../src/config.js";

/** The drill deployment that went out on 2026-08-16. */
const NEW = {
  factory: "0x783BDF0281090f21928398cC3Da19cFb64Fed15E",
  executor: "0xfA92ABF15dFAf470Cc8833Cb01464bD6CA139e16",
  pauseController: "0x418B3406BC483eB66ca5570b6fF91cE9d090E8a7",
  attesterRegistry: "0x1a96be4a757e065fb8928a2e5ab2Ab24790Ec7de",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
} as const satisfies DeploymentExpectation;

/** The August deployment, whose addresses are still the constants in config.ts. */
const OLD = {
  executor: "0x5D037fE7Fd65745BA51DDb433Aa5B17E965D46Ac",
  pauseController: "0x390FA085C9D7fe78763685039249AA724eA56cf5",
  attesterRegistry: "0x3d23f31A31Ec52aD84A45B35BBAF11b535DE8204",
} as const;

const onChain: OnChainConfiguration = {
  weth: NEW.weth,
  pauseController: NEW.pauseController,
  attesterRegistry: NEW.attesterRegistry,
  settlementExecutor: NEW.executor,
};

describe("verifying a configuration against its factory", () => {
  it("accepts a configuration that matches", () => {
    expect(verifyDeployment(NEW, onChain)).toEqual({ kind: "MATCHES" });
  });

  /** Addresses are compared case-insensitively; checksums are presentation. */
  it("does not care about checksum casing", () => {
    const lowered: DeploymentExpectation = {
      ...NEW,
      executor: NEW.executor.toLowerCase() as `0x${string}`,
      attesterRegistry: NEW.attesterRegistry.toUpperCase().replace("0X", "0x") as `0x${string}`,
    };
    expect(verifyDeployment(lowered, onChain).kind).toBe("MATCHES");
  });

  /**
   * THE REAL FAILURE, REPRODUCED. An operator moves NUVEM_VAULT_FACTORY and
   * NUVEM_SETTLEMENT_EXECUTOR — the two they think of — and leaves the pause
   * controller and attester registry unset, so both fall back to constants from
   * the previous release. Nothing about this looks wrong from the outside.
   */
  it("catches the two variables an operator forgets", () => {
    const half: DeploymentExpectation = {
      ...NEW,
      pauseController: OLD.pauseController,
      attesterRegistry: OLD.attesterRegistry,
    };
    const verdict = verifyDeployment(half, onChain);
    expect(verdict.kind).toBe("MISMATCH");
    if (verdict.kind !== "MISMATCH") return;
    expect(verdict.problems).toHaveLength(2);
    expect(verdict.problems.join(" ")).toContain("attester registry");
    expect(verdict.problems.join(" ")).toContain("pause controller");
  });

  /**
   * EVERY mismatch, not just the first. An operator who fixes one address and
   * restarts into the next failure learns nothing about the shape of the problem
   * — and after a redeployment there are usually three.
   */
  it("reports all four when nothing was updated", () => {
    const stale: DeploymentExpectation = { ...NEW, ...OLD, weth: "0xdead000000000000000000000000000000000000" };
    const verdict = verifyDeployment(stale, onChain);
    expect(verdict.kind).toBe("MISMATCH");
    if (verdict.kind !== "MISMATCH") return;
    expect(verdict.problems).toHaveLength(4);
  });

  /** Each problem names the variable to set AND the value to set it to. */
  it("tells the operator exactly what to change", () => {
    const verdict = verifyDeployment({ ...NEW, attesterRegistry: OLD.attesterRegistry }, onChain);
    if (verdict.kind !== "MISMATCH") throw new Error("expected a mismatch");
    expect(verdict.problems[0]).toContain(`NUVEM_ATTESTER_REGISTRY=${NEW.attesterRegistry}`);
    expect(verdict.problems[0]).toContain(OLD.attesterRegistry);
  });

  /**
   * WETH is checked too, and that is not redundant. It is the one address that
   * happened to survive the last redeployment unchanged, which is precisely why
   * nobody noticed the other four had not.
   */
  it("checks WETH, the field that survived last time and hid the rest", () => {
    const verdict = verifyDeployment({ ...NEW, weth: "0xdead000000000000000000000000000000000000" }, onChain);
    expect(verdict.kind).toBe("MISMATCH");
  });
});

describe("resolving what the keeper will actually run with", () => {
  /**
   * THE FALLBACK IS THE WHOLE POINT. An unset variable resolves to the constant
   * in config.ts, which after a redeployment is the PREVIOUS release — so the
   * expectation this builds must contain the stale address, not the new one.
   * A resolver that quietly used the factory's own answer would verify nothing.
   */
  it("falls back to the config.ts constants, which is what makes the check bite", () => {
    const e = resolveExpectation({}, NEW.factory);
    expect(e.executor).toBe(MAINNET.executor);
    expect(e.pauseController).toBe(MAINNET.pauseController);
    expect(e.attesterRegistry).toBe(MAINNET.attesterRegistry);
    expect(e.weth).toBe(MAINNET.weth);
    expect(e.factory).toBe(NEW.factory);
  });

  it("prefers the environment when it is set", () => {
    const e = resolveExpectation(
      {
        NUVEM_SETTLEMENT_EXECUTOR: NEW.executor,
        NUVEM_PAUSE_CONTROLLER: NEW.pauseController,
        NUVEM_ATTESTER_REGISTRY: NEW.attesterRegistry,
        NUVEM_WETH: NEW.weth,
      },
      NEW.factory,
    );
    expect(verifyDeployment(e, onChain)).toEqual({ kind: "MATCHES" });
  });

  /**
   * AN EMPTY STRING IS NOT AN ADDRESS, IT IS AN UNSET VARIABLE. A dashboard that
   * clears a field writes "", and config.ts:211-217 falls through to the
   * constant. A resolver that took "" literally would report MATCHES for a
   * keeper that then ran on the stale constant — the check passing on exactly
   * the configuration it exists to catch.
   */
  it("treats an empty or blank variable as unset, exactly as loadConfig does", () => {
    for (const blank of ["", "   "]) {
      const e = resolveExpectation({ NUVEM_ATTESTER_REGISTRY: blank }, NEW.factory);
      expect(e.attesterRegistry).toBe(MAINNET.attesterRegistry);
    }
  });

  it("trims, so a value pasted with a newline still matches", () => {
    const e = resolveExpectation({ NUVEM_ATTESTER_REGISTRY: `  ${NEW.attesterRegistry}\n` }, NEW.factory);
    expect(e.attesterRegistry).toBe(NEW.attesterRegistry);
  });

  /**
   * THE REAL RAILWAY CASE, END TO END: the operator moves the factory and the
   * executor and leaves the other two alone. Every value is a real address and
   * nothing looks wrong — this is the assertion that stands between that and a
   * fortnight of ATTESTER_MISMATCH.
   */
  /**
   * THE REAL RAILWAY CASE, AND IT IS WRITTEN AGAINST THE *NEXT* DEPLOYMENT ON
   * PURPOSE. The operator moves NUVEM_VAULT_FACTORY and NUVEM_SETTLEMENT_EXECUTOR
   * — the two they think of — and leaves the pause controller and attester
   * registry unset, so both fall through to whatever config.ts currently holds.
   *
   * An earlier version of this test built that scenario out of the LIVE
   * constants, which worked only while those constants were stale. Updating them
   * broke the test, which is the wrong way round: the mechanism is what needs
   * guarding, not the accident that the constants happened to be old. So the
   * chain here answers with a deployment the constants do not describe, which is
   * true of every future redeployment by definition.
   */
  it("catches the half-moved configuration, whatever the constants happen to be", () => {
    const FUTURE = {
      factory: "0x1111111111111111111111111111111111111111",
      executor: "0x2222222222222222222222222222222222222222",
      pauseController: "0x3333333333333333333333333333333333333333",
      attesterRegistry: "0x4444444444444444444444444444444444444444",
    } as const;

    // Only the two an operator remembers were moved.
    const e = resolveExpectation({ NUVEM_SETTLEMENT_EXECUTOR: FUTURE.executor }, FUTURE.factory);

    const verdict = verifyDeployment(e, {
      weth: NEW.weth, // survives, as it has across every deployment so far
      settlementExecutor: FUTURE.executor,
      pauseController: FUTURE.pauseController,
      attesterRegistry: FUTURE.attesterRegistry,
    });

    expect(verdict.kind).toBe("MISMATCH");
    if (verdict.kind !== "MISMATCH") return;
    expect(verdict.problems).toHaveLength(2);
    expect(verdict.problems.join(" ")).toContain("attester registry");
    expect(verdict.problems.join(" ")).toContain("pause controller");
    // And it names what to set them to, which is the whole point.
    expect(verdict.problems.join(" ")).toContain(FUTURE.pauseController);
  });
});

describe("the factory getter's ABI", () => {
  /**
   * THE ORDER IS THE STRUCT'S. `VaultFactory.ProtocolConfiguration` declares
   * {weth, pauseController, attesterRegistry, settlementExecutor}, and a public
   * struct variable's getter returns members in declaration order. Decoding them
   * in any other order does not throw — it compares the pause controller against
   * the attester registry and reports two mismatches that are both this bug.
   *
   * Verified against mainnet factory 0x783BDF02…, which returns exactly
   * (0x0Bd7D308…, 0x418B3406…, 0x1a96be4a…, 0xfA92ABF1…).
   */
  it("names the four outputs in the struct's declaration order", () => {
    const fn = PROTOCOL_CONFIGURATION_ABI[0];
    expect(fn.name).toBe("protocolConfiguration");
    expect(fn.stateMutability).toBe("view");
    expect(fn.inputs).toHaveLength(0);
    expect(fn.outputs.map((o) => o.name)).toEqual([
      "weth",
      "pauseController",
      "attesterRegistry",
      "settlementExecutor",
    ]);
    expect(fn.outputs.every((o) => o.type === "address")).toBe(true);
  });
});

describe("describing a verdict", () => {
  it("says the deployment is verified when it is", () => {
    expect(describeVerdict({ kind: "MATCHES" }, NEW.factory)).toContain("verified");
  });

  /** An unreadable factory is a different problem from a disagreeing one. */
  it("separates an unreadable factory from a mismatched one", () => {
    const unreadable = describeVerdict({ kind: "UNREADABLE", detail: "execution reverted" }, NEW.factory);
    expect(unreadable).toContain("Could not read protocolConfiguration()");
    expect(unreadable).toContain("Refusing to start");
    expect(unreadable).not.toContain("ATTESTER_MISMATCH");
  });

  it("carries the history, so nobody re-derives why this check exists", () => {
    const verdict = verifyDeployment({ ...NEW, attesterRegistry: OLD.attesterRegistry }, onChain);
    const text = describeVerdict(verdict, NEW.factory);
    expect(text).toContain("ATTESTER_MISMATCH");
    expect(text).toContain(NEW.attesterRegistry);
    expect(text).toContain("only you know which deployment you meant");
  });
});
