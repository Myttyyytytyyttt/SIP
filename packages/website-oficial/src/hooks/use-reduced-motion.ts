"use client";

import { useSyncExternalStore } from "react";

/**
 * WHETHER THE PERSON ASKED FOR LESS MOTION — for the motion JavaScript decides:
 * whether a clip plays or its still stands in, whether a reveal waits out its
 * transition or swaps at once, whether a held mark plays its one ping. CSS stays
 * the first gate (`motion-safe:` / `motion-reduce:` and the reduced-motion
 * blocks in globals.css); this is only for what CSS cannot reach.
 *
 * Lifted from the setup's step motion (OnboardingBody.tsx) on 10-09, so the
 * live page asks the same question the same way.
 *
 * False on the server and while hydrating, so the two agree; the real answer
 * follows straight after, is read at once by anything mounted later, and
 * follows every change of the system setting.
 */

const REDUCED = "(prefers-reduced-motion: reduce)";

const subscribe = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(REDUCED);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(REDUCED).matches, () => false);
}
