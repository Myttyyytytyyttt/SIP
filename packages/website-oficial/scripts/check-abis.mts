/**
 * Proves that every ABI fragment in src/lib/abi.ts is byte-identical to the
 * corresponding entry in @nuvem/contracts-artifacts, which is generated from the
 * compiled Solidity. `internalType` is ignored because it is annotation only.
 * Ported from the Nuvem dashboard's scripts/check-abis.mts (HEAD fd927b0).
 *
 * Run: ../../node_modules/.bin/tsx scripts/check-abis.mts   (from this package)
 *
 * The artifacts are read from the sibling package's dist directory through the
 * filesystem rather than imported, so this package takes no dependency on it —
 * the ABI fragments below are the only part of it that may reach a browser.
 *
 * A failure here means the contracts moved and the page would be decoding stale
 * data — which, for a page whose job is to say whether a wallet is linked and
 * at what rate, is the worst possible bug. Re-copy the fragment from the
 * artifacts package; never relax this check.
 *
 * It also reconstructs and compares `vaultInitializationParam`, which no
 * artifact publishes directly because `initData` is `bytes`. See the block at
 * the bottom of this file: a selector comparison cannot catch that drift, only
 * a fragment comparison can.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  personalVaultAbi,
  tradingAccountActivatedEvent,
  tradingAccountInvitedEvent,
  tradingAccountRevokedEvent,
  vaultFactoryAbi,
  vaultInitializationParam,
} from "../src/lib/abi.ts";
import { PROTOCOL_CONFIGURATION_WORDS } from "../src/lib/vault.ts";

type ContractName = "VaultFactory" | "PersonalVault" | "VaultLens";
type AbiEntry = { readonly type: string; readonly name?: string };
type AbiParam = { readonly type: string; readonly name?: string; readonly components?: readonly AbiParam[] };
type AbiFunction = AbiEntry & { readonly inputs: readonly AbiParam[]; readonly outputs: readonly AbiParam[] };

const ARTIFACTS_DIR = path.resolve(import.meta.dirname, "../../contracts-artifacts/dist/artifacts");

function artifactAbi(contract: ContractName): readonly AbiEntry[] {
  const file = path.join(ARTIFACTS_DIR, `${contract}.json`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(
      `[web] ${file} is missing. Build the artifacts first: pnpm --dir packages/contracts-artifacts run build`,
    );
    process.exit(1);
  }
  const parsed = JSON.parse(text) as { readonly abi?: unknown };
  if (!Array.isArray(parsed.abi)) {
    console.error(`[web] ${file} has no abi array.`);
    process.exit(1);
  }
  return parsed.abi as readonly AbiEntry[];
}

const abis: Readonly<Record<ContractName, readonly AbiEntry[]>> = {
  VaultFactory: artifactAbi("VaultFactory"),
  PersonalVault: artifactAbi("PersonalVault"),
  VaultLens: artifactAbi("VaultLens"),
};

const groups: ReadonlyArray<{ contract: ContractName; fragments: readonly AbiEntry[] }> = [
  { contract: "VaultFactory", fragments: vaultFactoryAbi },
  {
    contract: "PersonalVault",
    fragments: [...personalVaultAbi, tradingAccountInvitedEvent, tradingAccountActivatedEvent, tradingAccountRevokedEvent],
  },
];

function stripInternalType(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInternalType);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === "internalType") continue;
      out[key] = stripInternalType(inner);
    }
    return out;
  }
  return value;
}

const canonical = (value: unknown): string => JSON.stringify(stripInternalType(value));

const failures: string[] = [];
let compared = 0;

for (const { contract, fragments } of groups) {
  const source = abis[contract];
  for (const fragment of fragments) {
    const label = `${contract}.${fragment.type} ${fragment.name ?? "(anonymous)"}`;
    const matches = source.filter((entry) => entry.type === fragment.type && entry.name === fragment.name);
    if (matches.length === 0) {
      failures.push(`${label}: not present in @nuvem/contracts-artifacts any more.`);
      continue;
    }
    if (matches.length > 1) {
      failures.push(`${label}: ${matches.length} overloads in the artifact; this checker cannot disambiguate.`);
      continue;
    }
    compared += 1;
    const expected = canonical(matches[0]);
    const actual = canonical(fragment);
    if (expected !== actual) {
      failures.push(`${label}: DRIFTED.\n      artifact: ${expected}\n      abi.ts:   ${actual}`);
    }
  }
}

// Every error the artifact publishes must travel with its functions: viem only
// names a revert it can decode, and the page shows reverts by name.
for (const [contract, fragments] of [
  ["VaultFactory", vaultFactoryAbi],
  ["PersonalVault", personalVaultAbi],
] as const) {
  const published = abis[contract].filter((entry) => entry.type === "error").map((entry) => entry.name ?? "");
  const carried = new Set<string>(fragments.filter((entry) => entry.type === "error").map((entry) => entry.name));
  const missing = published.filter((name) => !carried.has(name));
  compared += 1;
  if (missing.length > 0) {
    failures.push(`${contract}: error fragment(s) missing from abi.ts, so those reverts would show as hex: ${missing.join(", ")}.`);
  }
}

// ---------------------------------------------------------------------------
// The initData tuple, which the compiled ABI does NOT publish
// ---------------------------------------------------------------------------
//
// `VaultFactory.createVault(bytes32,uint32,bytes)` and
// `PersonalVault.initialize(bytes32,address,address,uint32,bytes)` both take
// initData as opaque `bytes`, so both keep their selectors across any reshape of
// NuvemTypes.VaultInitialization and the loop above can never see this drift.
// The create-vault route nevertheless has to encode that struct byte-exactly,
// or createVault reverts (best case) on a decode that happens to succeed.
//
// The struct is reconstructed from two fragments the contracts DO publish, and
// which the contracts themselves derive it from:
//   - PersonalVault._validateInitialization passes the first four fields, in
//     order, to VaultFactory.isProtocolConfiguration — so those four must equal
//     that function's inputs; and
//   - `policy` is a NuvemTypes.VaultPolicy, which VaultLens.getVaultPolicy
//     returns — so it must equal that function's output tuple.
//
// This is a proxy, not a direct read of the struct, and it is the strongest
// check available from the artifacts alone. If the contracts stop deriving
// initData from those two, this guard must be replaced, not deleted.
function fragment(contract: ContractName, name: string): AbiFunction | null {
  const found = abis[contract].filter((entry) => entry.type === "function" && entry.name === name);
  return found.length === 1 ? (found[0] as AbiFunction) : null;
}

const shape = (params: readonly AbiParam[]): string =>
  JSON.stringify(params.map((p) => ({ name: p.name ?? "", type: p.type, components: p.components ? shape(p.components) : null })));

{
  const label = "initData tuple (NuvemTypes.VaultInitialization)";
  const gate = fragment("VaultFactory", "isProtocolConfiguration");
  // ON VaultLens, NOT PersonalVault: the vault traded its getters for one
  // `extsload` to fit under EIP-170, and the lens is where getVaultPolicy lives
  // now. Following a function to its new home is still comparing against the
  // compiled artifact, just the right one.
  const policy = fragment("VaultLens", "getVaultPolicy");
  if (gate === null || policy === null) {
    failures.push(
      `${label}: cannot be reconstructed — VaultFactory.isProtocolConfiguration and/or ` +
        `VaultLens.getVaultPolicy is missing or overloaded in the artifacts.`,
    );
  } else {
    compared += 1;
    const components = vaultInitializationParam.components as unknown as readonly AbiParam[];
    const expected = shape([
      ...gate.inputs,
      { name: "policy", type: "tuple", components: policy.outputs[0]?.components ?? [] },
    ]);
    const actual = shape(components);
    if (expected !== actual) {
      failures.push(
        `${label}: DRIFTED. The first ${gate.inputs.length} field(s) must match ` +
          `isProtocolConfiguration's inputs and the last must be getVaultPolicy's return tuple.\n` +
          `      contracts: ${expected}\n      abi.ts:    ${actual}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The returndata width src/lib/vault.ts refuses to decode past
// ---------------------------------------------------------------------------
//
// readStaticStruct rejects a struct-shaped return whose returndata is not
// exactly N words wide, which is the only thing standing between this page and
// a factory from a previous deployment answering with SIX addresses where four
// are expected — viem decodes the first four, drops the rest, and reports
// success. That N is a plain integer in vault.ts, so nothing but this compares
// it with reality. Too large and the guard rejects the correct deployment; too
// small and it admits the very shape it exists to reject.
{
  const label = "VaultFactory.protocolConfiguration";
  const params = fragment("VaultFactory", "protocolConfiguration")?.outputs;
  if (params === undefined) {
    failures.push(`${label}: missing or overloaded in the artifacts, so its returndata width cannot be pinned.`);
  } else {
    compared += 1;
    const dynamic = params.filter((p) => p.type.includes("[") || p.type === "bytes" || p.type === "string");
    if (dynamic.length > 0) {
      failures.push(
        `${label}: now has dynamic field(s) (${dynamic.map((p) => p.type).join(", ")}). ` +
          `"one field = one word" no longer holds, so readStaticStruct's width guard in src/lib/vault.ts is wrong ` +
          `and must be reworked, not renumbered.`,
      );
    } else if (params.length !== PROTOCOL_CONFIGURATION_WORDS) {
      failures.push(
        `${label}: has ${params.length} field(s), but src/lib/vault.ts guards its returndata at ` +
          `${PROTOCOL_CONFIGURATION_WORDS} word(s). Update that constant — as written the guard would reject the ` +
          `deployment this build targets.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`[web] ABI drift detected in src/lib/abi.ts (${failures.length} of ${compared + failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nFor a DRIFTED fragment, re-copy the entry from @nuvem/contracts-artifacts " +
      "(pnpm --dir packages/contracts-artifacts run build first) — never edit this checker to agree with abi.ts.\n" +
      "For a returndata-width failure the fix is in src/lib/vault.ts, not in abi.ts.",
  );
  process.exit(1);
}

console.log(
  `[web] ABI check passed: ${compared} comparisons against @nuvem/contracts-artifacts — every fragment ` +
    `byte-identical, every published error carried, the reconstructed initData tuple, and the returndata-width guard.`,
);
