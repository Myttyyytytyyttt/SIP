/**
 * THE MANAGE WALLETS MODAL'S SECTIONS (owner, 10-06): tabs on the left, the
 * modal opens on the overview, and each tab beside it holds one area.
 *
 * A LEAF ON PURPOSE. The opener (wallets-host.tsx) takes one of these, and so
 * do sample and live components that must not pull the wallets screen, Privy or
 * the Solana SDK into their bundle (LiveNextStep, wallet-activity). Tests that
 * mock wallets-host or WalletsScreen also lose every value those modules
 * export, so the ids live here, with no imports.
 */

/** In rail order. */
export const WALLETS_SECTIONS = ["overview", "vault", "trading", "investing", "withdraw"] as const;

export type WalletsSection = (typeof WALLETS_SECTIONS)[number];

export const DEFAULT_WALLETS_SECTION: WalletsSection = "overview";

/**
 * Whether a value is a section id. The opener is handed straight to onClick in
 * places (wallet-activity, landing), so its first argument can be a click
 * event: anything that is not a known id means "open on the overview".
 */
export function isWalletsSection(value: unknown): value is WalletsSection {
  return typeof value === "string" && (WALLETS_SECTIONS as readonly string[]).includes(value);
}
