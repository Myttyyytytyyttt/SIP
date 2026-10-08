/**
 * "IMPORT A WALLET I ALREADY USE", ASKED FOR FROM OUTSIDE THE WALLETS SCREEN.
 *
 * The live dashboard's next-step card opens the Manage wallets modal on its
 * trading tab, and the trading wallets card mounts inside it afterwards. This
 * one-shot flag carries the ask across: the card opens its import panel and
 * clears it. A LEAF, with no imports, like wallets-sections.ts: the next-step
 * card renders in the sample too and must not pull Privy or the wallets screen in.
 */

let requested = false;
const listeners = new Set<() => void>();

export function requestImport(): void {
  requested = true;
  for (const listener of listeners) listener();
}

/** Whether an import was asked for and not yet taken. */
export const importRequested = (): boolean => requested;

/** Takes the ask: true once per requestImport. */
export function takeImportRequest(): boolean {
  if (!requested) return false;
  requested = false;
  for (const listener of listeners) listener();
  return true;
}

export function subscribeImportRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
