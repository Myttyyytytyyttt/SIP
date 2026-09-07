import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  artifacts,
  contractNames,
  selectors,
} from "../dist/index.js";
import {
  toEventSelector,
  toFunctionSelector,
} from "viem";

const packageRoot = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const distRoot = resolve(packageRoot, "dist");
const expectedContracts = [
  "AdapterRegistry",
  "AttesterRegistry",
  "FeeCollector",
  "FeeController",
  // Buys the stock tokens a vault's basket names. Exported because the keeper
  // needs its ABI to decode reverts into something an operator can act on.
  "NuvemStockAdapter",
  "PersonalVault",
  "ProtocolPauseController",
  "SettlementExecutor",
  "VaultFactory",
  // The vault traded twelve getters for one `extsload` to fit under EIP-170, so
  // everything off chain reads those fields through here.
  "VaultLens",
];

function canonicalType(input) {
  if (!input.type.startsWith("tuple")) {
    return input.type;
  }
  const suffix = input.type.slice("tuple".length);
  return `(${input.components.map(canonicalType).join(",")})${suffix}`;
}

function signature(item) {
  return `${item.name}(${item.inputs.map(canonicalType).join(",")})`;
}

function compactSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function distDigest() {
  const files = [
    "index.d.ts",
    "index.js",
    "index.json",
    ...readdirSync(resolve(distRoot, "artifacts"))
      .sort()
      .map((file) => `artifacts/${file}`),
  ];
  return createHash("sha256")
    .update(
      files
        .map((file) => `${file}\0${readFileSync(resolve(distRoot, file))}`)
        .join("\0"),
    )
    .digest("hex");
}

describe("@nuvem/contracts-artifacts", () => {
  it("exports the explicit first-party contract set with deployable bytecode", () => {
    assert.deepEqual(contractNames, expectedContracts);
    for (const name of contractNames) {
      const artifact = artifacts[name];
      assert.equal(artifact.schemaVersion, 1);
      assert.equal(artifact.contractName, name);
      assert.ok(artifact.abi.length > 0);
      assert.match(artifact.bytecode, /^0x[0-9a-f]+$/i);
      assert.match(artifact.deployedBytecode, /^0x[0-9a-f]+$/i);
    }
  });

  it("derives every function, error, and event selector from the exported ABI", () => {
    for (const name of contractNames) {
      for (const item of artifacts[name].abi) {
        if (
          item.type !== "function" &&
          item.type !== "error" &&
          item.type !== "event"
        ) {
          continue;
        }
        const itemSignature = signature(item);
        const expected =
          item.type === "event"
            ? toEventSelector(itemSignature)
            : toFunctionSelector(itemSignature);
        assert.equal(
          selectors[name][`${item.type}s`][itemSignature],
          expected,
          `${name}.${itemSignature}`,
        );
      }
    }
  });

  // The settle selector is a cross-package constant: packages/session-engine-old
  // recognises a settlement transaction by its first four bytes, and its guard
  // (scripts/check-settle-selector.mts) reads this artifact. Pinning it here
  // means a change to SettlementAttestation cannot reach a consumer without a
  // deliberate edit to this file.
  //
  // 0xf38ac34f was the selector before startBlockL2/endBlockL2 were promoted
  // from ledgerRoot payload to real attestation fields. It is still the
  // selector of every settlement in chain history up to the redeploy, which is
  // why session-engine keeps recognising it and why it is asserted GONE here
  // rather than merely replaced — a build that reports both would mean the two
  // shapes coexist, and they cannot.
  it("locks the finalized SettlementExecutor.settle selector", () => {
    const settleSignature =
      "settle((address,address,address,uint256,uint64,uint64,uint64,uint64,uint64,uint64,bytes32,bytes32,bytes32,uint64,uint64,uint64,uint64,uint256,uint256,uint256,uint256,int256,uint256,uint32,uint48,uint48),bytes)";
    assert.equal(
      selectors.SettlementExecutor.functions[settleSignature],
      "0xc8f2629d",
    );

    const legacySettleSignature =
      "settle((address,address,address,uint256,uint64,uint64,uint64,uint64,uint64,uint64,bytes32,bytes32,bytes32,uint64,uint64,uint256,uint256,uint256,uint256,int256,uint256,uint32,uint48,uint48),bytes)";
    assert.equal(
      selectors.SettlementExecutor.functions[legacySettleSignature],
      undefined,
      "the pre-L2-progression settle overload must not be back in the ABI",
    );

    // deriveSessionId also moved (7 args -> 9) because the replay key now
    // commits to the L2 window. Two L2 sessions inside one L1 block would
    // otherwise derive the same id and the second would be refused.
    assert.equal(
      selectors.SettlementExecutor.functions[
        "deriveSessionId(uint256,address,address,uint64,uint64,uint64,uint64,uint64,bytes32)"
      ],
      "0x689ad24d",
    );
  });

  it("indexes content hashes without deployment data", () => {
    const index = JSON.parse(
      readFileSync(resolve(distRoot, "index.json"), "utf8"),
    );
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    );
    assert.equal(index.packageName, manifest.name);
    assert.equal(index.packageVersion, manifest.version);
    assert.equal(index.deployments, undefined);
    assert.equal(index.addresses, undefined);
    for (const name of contractNames) {
      assert.equal(
        index.contracts[name].sha256,
        compactSha256(artifacts[name]),
      );
    }
  });

  it("reproduces byte-for-byte output from the same Forge artifacts", (t) => {
    // `--skip-forge` skips the forge SUBPROCESS, not the forge OUTPUT: the export
    // still reads every artifact out of packages/contracts/out/, which is
    // gitignored. On a fresh clone that directory does not exist, the export
    // exits 1, and this test used to report a byte-for-byte reproduction failure
    // — pointing at the committed artifacts when the real cause was that nobody
    // had run `forge build` yet.
    //
    // Skipping with the reason is the honest outcome. It matches
    // check-dist-fresh.mjs, which skips when Foundry is absent rather than
    // claiming the ABIs are stale. A missing prerequisite is not a failure, and a
    // failure that names the wrong cause is worse than a skip that names the
    // right one.
    if (!existsSync(resolve(packageRoot, "..", "contracts", "out"))) {
      t.skip(
        "packages/contracts/out/ is absent, so there are no Forge artifacts to re-export. " +
          "Run `forge build` in packages/contracts first. Requires Foundry.",
      );
      return;
    }
    const before = distDigest();
    const result = spawnSync(
      process.execPath,
      ["scripts/export-artifacts.mjs", "--skip-forge"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(distDigest(), before);
  });
});
