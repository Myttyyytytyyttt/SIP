/**
 * THE VAULT'S TWO LIMITS, READ FROM WHAT SOMEONE TYPED — one rule, one place.
 *
 * Three forms ask for them: the vault card's create form, its "Change these
 * limits" form, and the new-user setup (src/components/onboarding). A figure
 * that one of them accepts and another refuses would be the same vault read two
 * ways, so all three read through this.
 *
 * Pure and client-safe: amounts are bigints of lamports, and a refusal carries
 * the sentence the form shows.
 */

import { SIGNATURE_FEE_LAMPORTS, ownerComputeBudget, priorityFeeLamports } from "@sip/solana-core/client";

import { AmountError, SOL_DECIMALS, parseUnits } from "@/lib/amounts";
import { VAULT_COPY } from "@/lib/vault-copy";

export type Limits = { readonly ok: true; readonly maxContribution: bigint; readonly walletReserve: bigint } | { readonly ok: false; readonly message: string };

export function readLimits(maxText: string, reserveText: string): Limits {
  try {
    const maxContribution = parseUnits(maxText, SOL_DECIMALS, VAULT_COPY.mostPerSettlement);
    const walletReserve = parseUnits(reserveText, SOL_DECIMALS, VAULT_COPY.alwaysLeft);
    if (maxContribution === 0n) return { ok: false, message: VAULT_COPY.zeroSettlement };
    return { ok: true, maxContribution, walletReserve };
  } catch (error) {
    if (error instanceof AmountError) return { ok: false, message: error.message };
    throw error;
  }
}

/** The network fees of creating a vault: one signature and the priority fee its compute budget carries. */
export const CREATE_VAULT_FEE_LAMPORTS: bigint = SIGNATURE_FEE_LAMPORTS + priorityFeeLamports(ownerComputeBudget("create_vault_v2"));
