"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A flag that switches itself off. "Copied", "Rule updated" — the same two
 * seconds, the same timer bookkeeping, the same cleanup on unmount, written
 * once. `flash()` restarts the clock if it is already running.
 */
export function useFlash(ms: number): readonly [on: boolean, flash: () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const flash = useCallback(() => {
    clear();
    setOn(true);
    timer.current = setTimeout(() => {
      setOn(false);
      timer.current = null;
    }, ms);
  }, [clear, ms]);

  useEffect(() => clear, [clear]);

  return [on, flash] as const;
}
