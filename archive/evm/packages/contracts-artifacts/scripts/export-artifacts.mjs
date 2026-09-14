import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  toEventSelector,
  toFunctionSelector,
} from "viem";

const SCHEMA_VERSION = 1;

const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const contractsRoot = resolve(packageRoot, "..", "contracts");
const forgeOut = resolve(contractsRoot, "out");
const distRoot = resolve(packageRoot, "dist");
const artifactOutput = resolve(distRoot, "artifacts");
const packageManifest = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
);
if (
  packageManifest.name !== "@nuvem/contracts-artifacts" ||
  typeof packageManifest.version !== "string"
) {
  throw new Error(
    "[contracts-artifacts] package.json has an invalid name or version",
  );
}
const PACKAGE_VERSION = packageManifest.version;

const contracts = [
  {
    contractName: "AdapterRegistry",
    sourceName: "src/registry/AdapterRegistry.sol",
  },
  {
    contractName: "AttesterRegistry",
    sourceName: "src/registry/AttesterRegistry.sol",
  },
  {
    contractName: "FeeCollector",
    sourceName: "src/fees/FeeCollector.sol",
  },
  {
    contractName: "FeeController",
    sourceName: "src/fees/FeeController.sol",
  },
  {
    // Buys the stock tokens a vault's basket names. Exported so the keeper can
    // decode its reverts into something an operator can act on.
    contractName: "NuvemStockAdapter",
    sourceName: "src/adapters/NuvemStockAdapter.sol",
  },
  {
    contractName: "PersonalVault",
    sourceName: "src/vault/PersonalVault.sol",
  },
  {
    contractName: "ProtocolPauseController",
    sourceName: "src/governance/ProtocolPauseController.sol",
  },
  {
    contractName: "SettlementExecutor",
    sourceName: "src/settlement/SettlementExecutor.sol",
  },
  {
    contractName: "VaultFactory",
    sourceName: "src/factory/VaultFactory.sol",
  },
  {
    // Reads a vault's storage and names it. Needed off chain because the vault
    // traded twelve getters for one `extsload` to fit under EIP-170.
    contractName: "VaultLens",
    sourceName: "src/periphery/VaultLens.sol",
  },
];

function fail(message) {
  throw new Error(`[contracts-artifacts] ${message}`);
}

function runForgeBuild() {
  const result = spawnSync("forge", ["build"], {
    cwd: contractsRoot,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    fail(`unable to start forge build: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`forge build exited with status ${String(result.status)}`);
  }
}

function canonicalType(input) {
  if (!input.type.startsWith("tuple")) {
    return input.type;
  }
  if (!Array.isArray(input.components)) {
    fail(`tuple ABI input ${input.name ?? "<unnamed>"} has no components`);
  }
  const suffix = input.type.slice("tuple".length);
  return `(${input.components.map(canonicalType).join(",")})${suffix}`;
}

function abiSignature(item) {
  return `${item.name}(${item.inputs.map(canonicalType).join(",")})`;
}

function sortedRecord(entries) {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function deriveSelectors(abi, forgeMethodIdentifiers, contractName) {
  const functions = new Map();
  const errors = new Map();
  const events = new Map();

  for (const item of abi) {
    if (
      item.type !== "function" &&
      item.type !== "error" &&
      item.type !== "event"
    ) {
      continue;
    }
    const signature = abiSignature(item);
    if (item.type === "event") {
      events.set(signature, toEventSelector(signature));
    } else {
      const selector = toFunctionSelector(signature);
      (item.type === "function" ? functions : errors).set(
        signature,
        selector,
      );
    }
  }

  const normalizedForgeIdentifiers = sortedRecord(
    Object.entries(forgeMethodIdentifiers).map(([signature, selector]) => [
      signature,
      `0x${selector}`,
    ]),
  );
  const derivedFunctions = sortedRecord(functions);
  if (
    JSON.stringify(normalizedForgeIdentifiers) !==
    JSON.stringify(derivedFunctions)
  ) {
    fail(
      `${contractName} function selectors derived from its ABI do not match Forge methodIdentifiers`,
    );
  }

  return {
    functions: derivedFunctions,
    errors: sortedRecord(errors),
    events: sortedRecord(events),
  };
}

function requireHex(value, label, { allowEmpty = false } = {}) {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-fA-F]*$/.test(value) ||
    (!allowEmpty && value === "0x")
  ) {
    fail(`${label} is not valid non-empty hex bytecode`);
  }
  return value;
}

function readForgeArtifact({ contractName, sourceName }) {
  const sourceFile = basename(sourceName);
  const forgePath = resolve(
    forgeOut,
    sourceFile,
    `${contractName}.json`,
  );
  let raw;
  try {
    raw = JSON.parse(readFileSync(forgePath, "utf8"));
  } catch (error) {
    fail(
      `cannot read ${forgePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Array.isArray(raw.abi)) {
    fail(`${contractName} Forge output has no ABI`);
  }
  if (
    !raw.bytecode ||
    !raw.deployedBytecode ||
    !raw.methodIdentifiers ||
    !raw.metadata?.compiler
  ) {
    fail(`${contractName} Forge output is incomplete`);
  }

  return {
    artifact: {
      schemaVersion: SCHEMA_VERSION,
      contractName,
      sourceName,
      abi: raw.abi,
      bytecode: requireHex(
        raw.bytecode.object,
        `${contractName}.bytecode`,
      ),
      deployedBytecode: requireHex(
        raw.deployedBytecode.object,
        `${contractName}.deployedBytecode`,
      ),
      linkReferences: raw.bytecode.linkReferences ?? {},
      deployedLinkReferences:
        raw.deployedBytecode.linkReferences ?? {},
      // immutableReferences is DELIBERATELY NOT EXPORTED.
      //
      // It maps solc AST NODE IDs to bytecode offsets, and those ids depend on
      // which compilation unit solc happened to build — that is, on Foundry's
      // cache state, not on the source. Exporting it made this package's output
      // environment-dependent: a fresh clone re-exporting the identical Solidity
      // produced different artifact hashes, so check-dist-fresh.mjs reported the
      // committed ABIs as stale and artifacts.test.mjs failed its byte-for-byte
      // reproduction. Both were false. Diagnosed by diffing a warm-cache export
      // against a cold-clone one: deployedBytecode was IDENTICAL and this was the
      // only field that moved.
      //
      // A guard that cries wolf on every fresh checkout is worse than no guard,
      // because the first thing it teaches is to ignore it. Nothing consumes the
      // field — grep across packages/ finds only the writer and its own generated
      // type — so the honest fix is not to publish it.
      selectors: deriveSelectors(
        raw.abi,
        raw.methodIdentifiers,
        contractName,
      ),
    },
    compiler: {
      version: raw.metadata.compiler.version,
      optimizer: raw.metadata.settings?.optimizer ?? null,
      viaIR: raw.metadata.settings?.viaIR ?? false,
      evmVersion: raw.metadata.settings?.evmVersion ?? null,
    },
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildTypes(contractNames) {
  const union = contractNames.map((name) => JSON.stringify(name)).join(" | ");
  const namedExports = contractNames
    .map(
      (name) =>
        `export const ${name}Artifact: ContractArtifact<${JSON.stringify(name)}>;`,
    )
    .join("\n");

  return `import type { Abi } from "viem";

export type Hex = \`0x\${string}\`;
export type ContractName = ${union};
export type { Abi };

export interface ContractSelectors {
  readonly functions: Readonly<Record<string, Hex>>;
  readonly errors: Readonly<Record<string, Hex>>;
  readonly events: Readonly<Record<string, Hex>>;
}

export interface ContractArtifact<TName extends ContractName = ContractName> {
  readonly schemaVersion: 1;
  readonly contractName: TName;
  readonly sourceName: string;
  readonly abi: Abi;
  readonly bytecode: Hex;
  readonly deployedBytecode: Hex;
  readonly linkReferences: Readonly<Record<string, unknown>>;
  readonly deployedLinkReferences: Readonly<Record<string, unknown>>;
  readonly selectors: ContractSelectors;
}

export const artifactSchemaVersion: 1;
export const packageVersion: ${JSON.stringify(PACKAGE_VERSION)};
export const contractNames: readonly ContractName[];
export const artifacts: Readonly<{
  [TName in ContractName]: ContractArtifact<TName>;
}>;
export const abis: Readonly<{
  [TName in ContractName]: ContractArtifact<TName>["abi"];
}>;
export const bytecodes: Readonly<Record<ContractName, Hex>>;
export const deployedBytecodes: Readonly<Record<ContractName, Hex>>;
export const selectors: Readonly<Record<ContractName, ContractSelectors>>;
${namedExports}
export default artifacts;
`;
}

function buildJavaScript(artifacts) {
  const contractNames = Object.keys(artifacts);
  const namedExports = contractNames
    .map(
      (name) =>
        `export const ${name}Artifact = artifacts.${name};`,
    )
    .join("\n");

  return `// Generated by scripts/export-artifacts.mjs. Do not edit.
export const artifactSchemaVersion = ${SCHEMA_VERSION};
export const packageVersion = ${JSON.stringify(PACKAGE_VERSION)};
export const contractNames = Object.freeze(${JSON.stringify(contractNames)});
export const artifacts = Object.freeze(${JSON.stringify(artifacts, null, 2)});
export const abis = Object.freeze(Object.fromEntries(
  contractNames.map((name) => [name, artifacts[name].abi]),
));
export const bytecodes = Object.freeze(Object.fromEntries(
  contractNames.map((name) => [name, artifacts[name].bytecode]),
));
export const deployedBytecodes = Object.freeze(Object.fromEntries(
  contractNames.map((name) => [name, artifacts[name].deployedBytecode]),
));
export const selectors = Object.freeze(Object.fromEntries(
  contractNames.map((name) => [name, artifacts[name].selectors]),
));
${namedExports}
export default artifacts;
`;
}

if (!process.argv.includes("--skip-forge")) {
  runForgeBuild();
}

if (
  dirname(distRoot) !== packageRoot ||
  basename(distRoot) !== "dist"
) {
  fail(`refusing to replace unexpected output directory ${distRoot}`);
}
rmSync(distRoot, { recursive: true, force: true });
mkdirSync(artifactOutput, { recursive: true });

const exportedArtifacts = {};
const indexContracts = {};
let compiler;

for (const contract of contracts) {
  const result = readForgeArtifact(contract);
  if (
    compiler &&
    JSON.stringify(compiler) !== JSON.stringify(result.compiler)
  ) {
    fail(`${contract.contractName} was compiled with inconsistent settings`);
  }
  compiler ??= result.compiler;

  const compactArtifact = JSON.stringify(result.artifact);
  const digest = sha256(compactArtifact);
  exportedArtifacts[contract.contractName] = result.artifact;
  indexContracts[contract.contractName] = {
    sourceName: contract.sourceName,
    artifact: `./artifacts/${contract.contractName}.json`,
    sha256: digest,
    selectors: result.artifact.selectors,
  };
  writeJson(
    resolve(artifactOutput, `${contract.contractName}.json`),
    result.artifact,
  );
}

const artifactIndex = {
  schemaVersion: SCHEMA_VERSION,
  packageName: "@nuvem/contracts-artifacts",
  packageVersion: PACKAGE_VERSION,
  compiler,
  contracts: indexContracts,
};

writeJson(resolve(distRoot, "index.json"), artifactIndex);
writeFileSync(
  resolve(distRoot, "index.js"),
  buildJavaScript(exportedArtifacts),
  "utf8",
);
writeFileSync(
  resolve(distRoot, "index.d.ts"),
  buildTypes(Object.keys(exportedArtifacts)),
  "utf8",
);

process.stdout.write(
  `[contracts-artifacts] exported ${contracts.length} contracts with schema v${SCHEMA_VERSION}\n`,
);
