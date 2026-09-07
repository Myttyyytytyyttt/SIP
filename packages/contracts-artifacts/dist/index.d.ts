import type { Abi } from "viem";

export type Hex = `0x${string}`;
export type ContractName = "AdapterRegistry" | "AttesterRegistry" | "FeeCollector" | "FeeController" | "NuvemStockAdapter" | "PersonalVault" | "ProtocolPauseController" | "SettlementExecutor" | "VaultFactory" | "VaultLens";
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
export const packageVersion: "0.1.0";
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
export const AdapterRegistryArtifact: ContractArtifact<"AdapterRegistry">;
export const AttesterRegistryArtifact: ContractArtifact<"AttesterRegistry">;
export const FeeCollectorArtifact: ContractArtifact<"FeeCollector">;
export const FeeControllerArtifact: ContractArtifact<"FeeController">;
export const NuvemStockAdapterArtifact: ContractArtifact<"NuvemStockAdapter">;
export const PersonalVaultArtifact: ContractArtifact<"PersonalVault">;
export const ProtocolPauseControllerArtifact: ContractArtifact<"ProtocolPauseController">;
export const SettlementExecutorArtifact: ContractArtifact<"SettlementExecutor">;
export const VaultFactoryArtifact: ContractArtifact<"VaultFactory">;
export const VaultLensArtifact: ContractArtifact<"VaultLens">;
export default artifacts;
