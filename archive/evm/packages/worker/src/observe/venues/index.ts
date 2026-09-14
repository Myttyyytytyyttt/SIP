import type { Address, TxWithReceipt, VenueDecoder, VenueFill } from "../../types.js";
import { gmgn } from "./gmgn.js";

export { gmgn, GMGN_FEE_TOPIC, GMGN_FILL_TOPIC } from "./gmgn.js";

/** Decoders in trust order. Owner: venues. */
export const VENUES: readonly VenueDecoder[] = [gmgn];

/**
 * The first decoder that recognises the transaction wins (its name is the fill's `venue`); null
 * when none does, and the reconciler falls back to tx.value (buys) or the block residual (a lone
 * sell) — see DESIGN.md §3.
 */
export function decodeVenueFill(entry: TxWithReceipt, wallet: Address, venues: readonly VenueDecoder[] = VENUES): VenueFill | null {
  for (const venue of venues) {
    const fill = venue.decode(entry, wallet);
    if (fill !== null) return fill;
  }
  return null;
}
