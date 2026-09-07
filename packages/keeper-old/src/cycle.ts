// Running a periodic body without letting two of them overlap.
//
// `setInterval` fires on the clock whether or not the last firing finished, and
// the supervisor's cycle can outrun its interval: `tickAll` ticks every held
// account, and this deployment's own logs carry 44 ticks longer than 60 seconds
// against a 60-second interval. Two cycles in flight means `runTick` running
// twice concurrently against the same runner and the same journal.
//
// SKIPPED, NOT QUEUED. The next firing is one interval away and a backlog of
// identical sweeps accomplishes nothing — it would only guarantee the overlap it
// is meant to prevent, one interval later.
//
// IT LIVES HERE RATHER THAN AS A FLAG IN THE BINARY because of how it fails. A
// latch that is taken and not released does not crash and does not log: the
// supervisor simply never sweeps again, holding every account it already had,
// reporting nothing wrong. The binary has no tests; this does.

/**
 * Wraps `body` so a call arriving while a previous one is still running is
 * skipped.
 *
 * `onSkip` is called instead, so the caller can say so out loud — a skipped
 * cycle is worth a line, since a run of them means the interval is too short for
 * the work.
 */
export function skipWhileRunning(
  body: () => Promise<void>,
  onSkip: () => void,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      onSkip();
      return;
    }
    running = true;
    try {
      await body();
    } finally {
      // IN A `finally`. A body that throws past its own handler would otherwise
      // leave this latched forever, which is the silent mute described above.
      running = false;
    }
  };
}
