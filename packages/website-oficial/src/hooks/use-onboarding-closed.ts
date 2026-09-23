"use client";

import { useSyncExternalStore } from "react";

import { readOnboardingClosed, subscribeOnboarding } from "@/lib/onboarding-memory";

/**
 * Whether this tab closed this key's new-user setup. The server snapshot is
 * false, and so is the first client frame's: storage is read only after
 * hydration, so the two cannot disagree — and before Privy is ready the frame
 * does not ask anyway.
 */
export const useOnboardingClosed = (pensionKey: string | null): boolean =>
  useSyncExternalStore(subscribeOnboarding, () => readOnboardingClosed(pensionKey), () => false);
