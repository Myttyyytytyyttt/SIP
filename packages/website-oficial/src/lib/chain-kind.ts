/**
 * Client-safe narrowing on PublicConfig.chain. Type-only imports, so nothing from
 * the server configuration enters a client bundle through this file.
 */
import type { AnyPublicConfig, SolanaPublicConfig } from "@/lib/config";

export const isSolana = (config: AnyPublicConfig): config is SolanaPublicConfig => config.chain === "solana";
