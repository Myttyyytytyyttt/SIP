"use client";

import { useMemo, useSyncExternalStore } from "react";

import { readBasketChoice, readBasketStored, readOnboardingClosed, subscribeOnboarding, type BasketChoice } from "@/lib/onboarding-memory";

/**
 * Whether this tab closed this key's new-user setup. The server snapshot is
 * false, and so is the first client frame's: storage is read only after
 * hydration, so the two cannot disagree — and before Privy is ready the frame
 * does not ask anyway.
 */
export const useOnboardingClosed = (pensionKey: string | null): boolean =>
  useSyncExternalStore(subscribeOnboarding, () => readOnboardingClosed(pensionKey), () => false);

/**
 * What this key chose for its savings on the setup, or null when this browser
 * holds no choice for it. Read through the stored string, which is a stable
 * snapshot; parsed once per change.
 */
export function useBasketChoice(pensionKey: string | null): BasketChoice | null {
  const stored = useSyncExternalStore(
    subscribeOnboarding,
    () => (pensionKey === null ? null : readBasketStored(pensionKey)),
    () => null,
  );
  return useMemo(() => (pensionKey === null || stored === null ? null : readBasketChoice(pensionKey)), [pensionKey, stored]);
}
