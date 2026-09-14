// Which in-asset this keeper can invest from, whether it may invest at all, and
// whether it may convert the vault's SOL to get there, as pure decisions.
//
// NEW IN SIP. sip-vault's InvestmentPolicy pins `in_mint`: the only mint convert
// may fill into and invest may spend from, chosen by the owner, with every floor
// and cap in the policy denominated in it. Nuvem's keeper hardcoded USDC and
// never looked. Against a policy pinned to anything else it would have wrapped
// and market-sold the vault's SOL toward USDC, and convert would then have been
// refused on chain with WrongInMint — the SOL exposure gone, nothing bought.
//
// The keeper has routes for exactly one in-asset (the wSOL/USDC pool and USDC
// pools per leg), so any other in_mint is refused BEFORE anything moves, naming
// both mints so the operator can see which side must change.

import { PublicKey } from "@solana/web3.js";

/** USDC on mainnet: the only in-asset the keeper has routes for. */
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export function inMintDecision(inMint: PublicKey): { readonly outcome: "REFUSED"; readonly detail: string } | null {
  if (inMint.equals(USDC_MINT)) return null;
  return {
    outcome: "REFUSED",
    detail:
      `the policy's in_mint is ${inMint.toBase58()}, but the only in-asset this keeper has routes for is USDC ` +
      `(${USDC_MINT.toBase58()}) — refusing to wrap, convert or invest toward it`,
  };
}

/**
 * Whether either pause switch stops this investment turn, decided before any
 * balance, ATA or wrap.
 *
 * THE VAULT'S OWN SWITCH WAS THE DANGEROUS ONE. convert and invest always refused
 * a paused vault (VaultPaused), but wrap_sol once checked only the protocol switch
 * — so a keeper that did not look would wrap a paused vault's free SOL, have the
 * convert refused, and leave the owner's SOL sitting as wSOL that only
 * withdraw_token recovers, again on every sweep. wrap_sol refuses a paused vault
 * too now; resting here first still spares a failed transaction. A paused vault
 * is a RESTING state: nothing is wrapped or bought, and nothing is alerted as a
 * failure.
 */
export function investPauseDecision(input: {
  readonly vaultPaused: boolean;
  readonly protocolPaused: boolean;
}): { readonly outcome: "PAUSED"; readonly detail: string } | null {
  if (!input.vaultPaused && !input.protocolPaused) return null;
  const switches = [
    input.vaultPaused ? "the vault's owner paused it (wrap_sol, convert and invest refuse with VaultPaused)" : null,
    input.protocolPaused ? "the protocol's authority paused every vault (wrap_sol, convert and invest refuse with ProtocolPaused)" : null,
  ].filter((part): part is string => part !== null);
  return { outcome: "PAUSED", detail: `${switches.join(" and ")} — nothing is wrapped, converted or bought` };
}

/** Whether a turn may wrap and convert; when it may not, why, in words for the turn's detail. */
export type ConvertDecision = { readonly convert: true } | { readonly convert: false; readonly detail: string };

/**
 * Whether this investment turn may wrap and convert the vault's SOL, decided
 * from the policy alone, before any ATA or wrap.
 *
 * A ZERO FLOOR MEANS THE OWNER NEVER TURNED CONVERSION ON, and wrap_sol and
 * convert both refuse it with FloorTooLow: "accept any price" is not a policy.
 * The tick once checked only `enabled` before wrapping, so a vault whose owner
 * enabled investing without ever signing a conversion floor had its ATAs
 * re-created and a refused wrap_sol sent on every sweep, reported as FAILED.
 *
 * NOT A REFUSAL. The owner chose to keep the SOL as SOL, and USDC already in
 * the vault is still invested against the legs as usual, so the turn goes on
 * without wrap and convert, says so in its detail, and alerts nobody.
 */
export function convertDecision(policy: { readonly minConvertRateWad: bigint }): ConvertDecision {
  if (policy.minConvertRateWad > 0n) return { convert: true };
  return {
    convert: false,
    detail:
      "conversion is off: the policy's min_convert_rate_wad is 0, which wrap_sol and convert refuse with FloorTooLow, " +
      "so the vault's SOL is not wrapped or converted and only USDC already in the vault is invested",
  };
}
