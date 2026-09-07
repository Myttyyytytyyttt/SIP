# @nuvem/contracts-artifacts

Versioned, deterministic client artifacts for Nuvem's first-party contracts.
The package exports ABI, creation bytecode, deployed bytecode, function/error
selectors, and event topics generated from Foundry output.

It intentionally contains no chain addresses or deployment manifests. Consumers
must obtain addresses from a real, verified deployment and keep the deployment
environment explicit.

## Build and test

```powershell
pnpm --dir packages/contracts-artifacts build
pnpm --dir packages/contracts-artifacts test
```

`build` runs `forge build` in `packages/contracts` before exporting. In the root
pipeline, `build:from-out` reuses the immediately preceding Foundry build. The
exporter deletes and recreates only this package's validated `dist` directory.
It omits timestamps and hashes canonical artifact content so identical compiler
output produces byte-for-byte identical package output.

The package version must be bumped whenever a published ABI or bytecode change
is intentional.

## TypeScript consumption

```ts
import {
  SettlementExecutorArtifact,
  abis,
  bytecodes,
  selectors,
} from "@nuvem/contracts-artifacts";

const settlementAbi = abis.SettlementExecutor;
const factoryCreationCode = bytecodes.VaultFactory;
const settleSelector =
  selectors.SettlementExecutor.functions[
    "settle((address,address,address,uint256,uint64,uint64,uint64,uint64,uint64,uint64,bytes32,bytes32,bytes32,uint64,uint64,uint256,uint256,uint256,uint256,int256,uint256,uint32,uint48,uint48),bytes)"
  ];

// The complete artifact is also available.
console.log(SettlementExecutorArtifact.sourceName);
```

JSON-only consumers can import `@nuvem/contracts-artifacts/index.json` or an
individual `@nuvem/contracts-artifacts/artifacts/SettlementExecutor` export
after the package has been built.

