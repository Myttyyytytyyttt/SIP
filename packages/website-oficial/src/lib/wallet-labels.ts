/**
 * A TRADING WALLET'S NAME, THE SAME ON EVERY SCREEN.
 *
 * The Wallets tab's rows and the live dashboard (its wallet column, activity
 * rows, chip tooltips, next-step notes) name the same wallets, so they take the
 * name from here. Wallets created here are counted among themselves in the order
 * given ("Trading wallet 1", "2"…); imported ones are counted among themselves
 * after them ("Imported wallet", or "Imported wallet 1", "2"… when there are
 * several).
 *
 * NOT BY PRIVY'S INDEX. Privy records an imported Solana wallet with walletIndex
 * 0 (react-auth 3.36.0, seen in production 10-08), the same number as the first
 * wallet created here, so an index-based name called both "Trading wallet 1".
 *
 * A LEAF, with no imports: the live dashboard's sample renders these names too
 * and must not pull Privy in with them.
 */

export interface LabelledWallet {
  readonly address: string;
  readonly imported: boolean;
}

export function tradingWalletLabels(wallets: readonly LabelledWallet[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  const imported = wallets.filter((wallet) => wallet.imported).length;
  let createdSeen = 0;
  let importedSeen = 0;
  for (const wallet of wallets) {
    if (labels.has(wallet.address)) continue;
    if (wallet.imported) {
      importedSeen += 1;
      labels.set(wallet.address, imported === 1 ? "Imported wallet" : `Imported wallet ${importedSeen}`);
    } else {
      createdSeen += 1;
      labels.set(wallet.address, `Trading wallet ${createdSeen}`);
    }
  }
  return labels;
}
