/**
 * How long Privy may take to become ready before a screen stops pretending it is
 * about to.
 *
 * Its own module because two screens wait on it now — the wallets screen and the
 * dashboard — and a skeleton that pulses forever on one of them while the other
 * has given up is the kind of difference nobody notices until a user reports
 * "it just spins". WalletsScreen re-exports it, so its old import still works.
 */
export const PRIVY_PATIENCE_MS = 15_000;
