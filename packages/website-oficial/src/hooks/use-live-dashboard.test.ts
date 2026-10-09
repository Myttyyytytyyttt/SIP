// THE FIRST PAINT WAITS FOR THE HISTORY (owner, 09-24). The snapshot answers
// before the history, and committing it alone drew half a second of "No
// activity yet", "0 events · 0 settlements" and a chart saying the savings were
// "not in the history loaded here" on every live load. So the first snapshot
// of a pension is held until its head page answers or fails, and until the
// settlement round answers too — for at most FIRST_PAINT_WAIT_MS.
//
// This package has no DOM to render a hook in (node environment, no jsdom), so
// the wiring is read from the hook's source, the way live-backfill.test.ts
// reads it. The behaviour itself was checked in a browser against fixture
// answers with controlled delays (see the commit that added this file).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FIRST_PAINT_WAIT_MS } from "@/hooks/use-live-dashboard";

const HOOK = fileURLToPath(new URL("./use-live-dashboard.ts", import.meta.url));

/** The file's CODE, with its prose removed: a comment about the snapshot is not a call. */
const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");

const source = code(readFileSync(HOOK, "utf8"));
const read = source.slice(source.indexOf("const read = useCallback"), source.indexOf("const loadOlder"));

describe("the first paint of a pension waits for its history", () => {
  it("sets the snapshot through the gate's commit, and only once more AFTER the gate released (its timing is lib/first-paint.test.ts's)", () => {
    expect(read.match(/setSnapshot\(/g)).toHaveLength(2);
    expect(read).toMatch(/const gate = firstPaintGate\(\{ hold: holdFirstPaint, commit: \(\) => setSnapshot\(answered\.body\), stale, waitMs: FIRST_PAINT_WAIT_MS \}\);/);
    // The second is the re-read a history ahead of its snapshot buys: never before the first paint.
    expect(read.indexOf("setSnapshot(again.body)")).toBeGreaterThan(read.search(/gate\.release\(\);/));
  });

  it("holds only the FIRST snapshot, and only when there is a history to wait for", () => {
    expect(read).toMatch(/const holdFirstPaint = snapshotRef\.current === null && wantsActivity && answered\.body\.vault\.status === "exists";/);
  });

  it("ends a previous failure as soon as a held snapshot has answered, so the error card does not outlive the answer", () => {
    expect(read).toMatch(/if \(holdFirstPaint\) \{\s*setFailures\(0\);\s*setFailure\(null\);\s*\}/);
    expect(read.search(/if \(holdFirstPaint\) \{\s*setFailures\(0\)/)).toBeLessThan(read.indexOf("api.activity("));
  });

  it("asks for the history after the gate is armed, and releases it in a finally, whatever the history did", () => {
    const armed = read.indexOf("const gate = firstPaintGate(");
    const asked = read.indexOf("api.activity(");
    const released = read.search(/\} finally \{\s*gate\.release\(\);\s*\}/);
    expect(armed).toBeGreaterThan(-1);
    expect(asked).toBeGreaterThan(armed);
    expect(released).toBeGreaterThan(asked);
  });

  it("still drops every answer a newer read has overtaken — the snapshot, the history and the settlement round", () => {
    // After each await: the snapshot, the head page, the round.
    expect(read.match(/if \(stale\(\)\) return true;/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // The source's comments are stripped first, so the check sits straight after the round.
    expect(read).toMatch(/await backfillLinkSettlements\([\s\S]*?\}\);\s*if \(stale\(\)\) return true;/);
  });

  it("says the history is still being read — never 'No activity yet' — when the bound drew the page first", () => {
    expect(source).toMatch(/const activityPending = wantsActivity && snapshot !== null && snapshot\.vault\.status === "exists" && activityMeta === null && activityTrouble === null;/);
    expect(FIRST_PAINT_WAIT_MS).toBeGreaterThan(0);
    expect(FIRST_PAINT_WAIT_MS).toBeLessThanOrEqual(2_000);
  });
});

describe("Load older is offered only when there is an older page", () => {
  it("is worked out from the cursor a head page named, never stored beside it", () => {
    expect(source).toMatch(/available: cursor !== null/);
    expect(source).toMatch(/const cursor = activityMeta\?\.nextBefore \?\? null;/);
  });
});

describe("the poll runs faster only while something is on its way", () => {
  const poll = source.slice(source.indexOf("const pendingActive ="), source.indexOf("const cursor = activityMeta"));

  it("takes 'under way' from the model the page draws, and only for a caller that draws the history", () => {
    expect(poll).toMatch(/const pendingActive = wantsActivity && view\.kind === "ready" && anyActive\(pendingSteps\(view\.data\)\);/);
  });

  it("starts the stretch's clock when a step first appears and clears it when none is left", () => {
    expect(poll).toMatch(/if \(!pendingActive\) activeSinceRef\.current = null;\s*else if \(activeSinceRef\.current === null\) activeSinceRef\.current = Date\.now\(\);/);
  });

  it("asks the schedule, bounded by the stretch's clock and the history's retry-after, and re-arms when 'under way' changes", () => {
    // The history's retry-after goes in: every read asks for the history, so the
    // 20 s cadence may not run while the route has said to wait longer.
    expect(poll).toMatch(
      /const pending = pendingPollWanted\(\{ active: pendingActive, activeSince: activeSinceRef\.current, now: Date\.now\(\), activityRetryAt: activityTrouble\?\.retryAt \?\? null \}\);/,
    );
    expect(poll).toMatch(/nextDelayMs\(\{ failures, retryAfterSeconds: null, visible, lastReadAt, now: Date\.now\(\), reading, pending, unheard \}\)/);
    expect(poll).toMatch(/\}, \[pensionKey, failures, lastReadAt, failure, activityTrouble, tick, read, reading, pendingActive, socket\]\);/);
  });
});

/**
 * THE CHAIN RINGS (owner, 2026-10-09). The decisions are live-push.ts's and
 * live-socket.ts's, tested there; what is pinned here is that the hook wires
 * them and nothing else: one socket only where a live pension is drawn, a push
 * read only through pushReadDelayMs, a wallet's change only after a read that
 * read the history, and a return to the tab on visibility AND focus.
 */
describe("the push from the chain", () => {
  const SHELL = fileURLToPath(new URL("../components/dashboard-shell.tsx", import.meta.url));
  const LEADERBOARD = fileURLToPath(new URL("../components/leaderboard-account.tsx", import.meta.url));

  it("opens a socket only for a live pension that draws its history, on the key-free WebSocket, and closes it on the way out", () => {
    expect(source).toMatch(/if \(pensionKey === null \|\| !wantsActivity \|\| !hasWatched \|\| wsUrl === null \|\| typeof WebSocket === "undefined"\) return undefined;/);
    expect(source).toMatch(/const wsUrl = useSolanaConfigOrNull\(\)\?\.solanaWsUrl \?\? null;/);
    expect(source).toMatch(/return \(\) => \{\s*watch\.close\(\);/);
    expect(source).toMatch(/\}, \[pensionKey, wantsActivity, hasWatched, wsUrl\]\);/);
    // Exactly one place opens one.
    expect(source.match(/watchAccounts\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/new WebSocket\(/);
  });

  it("never in the sample: the shell hands the hook no pension key outside live mode, and the leaderboard's chip reads no history", () => {
    expect(code(readFileSync(SHELL, "utf8"))).toMatch(/useLiveDashboard\(\{ pensionKey: state\.kind === "live" \? pensionKey : null,/);
    expect(code(readFileSync(LEADERBOARD, "utf8"))).toMatch(/useLiveDashboard\(\{ pensionKey, privyWallets, activity: false \}\)/);
  });

  it("opens nothing while there is nothing to watch: the endpoint closes a socket with no subscription, and a vault created later opens it then", () => {
    // Review 2026-10-09: a socket opened before the vault existed was closed every ~60 s, gave up after six, and never subscribed the vault.
    expect(source).toMatch(/const hasWatched = watched !== "";/);
    expect(source).toMatch(/const watched = useMemo\(\(\) => watchedAddresses\(snapshot\)\.join\(","\), \[snapshot\]\);/);
  });

  it("resubscribes a changed set instead of reopening", () => {
    expect(source).toMatch(/watchRef\.current\?\.setAddresses\(watched === "" \? \[\] : watched\.split\(","\)\);/);
  });

  it("reads for a push only when pushReadDelayMs says, with the floor's inputs, the backoff and the retry-after", () => {
    expect(source).toMatch(/const delay = pushReadDelayMs\(\{ dirty: push\.dirty, now: Date\.now\(\), lastReadAt, visible, reading, failures, retryAt \}\);/);
    expect(source).toMatch(/const retryAt = latestOf\(failure\?\.retryAt \?\? null, activityTrouble\?\.retryAt \?\? null\);/);
  });

  it("hands a wallet's change to the page only from a read that read the history", () => {
    expect(read).toMatch(/if \(page\.ok && page\.body\.status === "exists"\) \{\s*historyRead = true;/);
    expect(read).toMatch(/setPush\(\(held\) => afterRead\(heardLate\(held, moved\), \{ slot: current\.slot, historyRead, readAtMs: current\.readAtMs, ends, historySlot \}\)\);/);
    expect(read.match(/historyRead = true/g)).toHaveLength(1);
    expect(source).toMatch(/walletChanges,\s*\}\);/);
  });

  it("finds a change nobody heard from the balances against the last read's, kept per pension across a remount", () => {
    // Review 2026-10-09: a trade made while the page was on /wallets, or while a phone had dropped the socket, never showed.
    expect(read).toMatch(/const moved = movedSince\(recallPush\(pensionKey\)\.baseline, current\);\s*rememberPush\(pensionKey, \{ baseline: baselineOf\(current\) \}\);/);
    expect(read).toMatch(/const ends = walletEnds\(current, seen\);/);
    // Only the dashboard's own reads move the baseline, never the leaderboard chip's.
    expect(read).toMatch(/if \(wantsActivity\) \{\s*const moved = movedSince/);
    expect(read.match(/seen\.push\(/g)).toHaveLength(2);
    expect(source).toMatch(/useState<PushState>\(\(\) => \(pensionKey !== null && wantsActivity \? recallPush\(pensionKey\)\.push : EMPTY_PUSH\)\)/);
    expect(source).toMatch(/setPush\(pensionKey !== null && wantsActivity \? recallPush\(pensionKey\)\.push : EMPTY_PUSH\);/);
    expect(source).toMatch(/if \(pensionKey !== null && wantsActivity\) rememberPush\(pensionKey, \{ push \}\);/);
  });

  it("does not read for a push in a tab hidden since the read was armed", () => {
    const pushEffect = source.slice(source.indexOf("const delay = pushReadDelayMs("), source.indexOf("const refresh = useCallback"));
    expect(pushEffect).toMatch(/window\.setTimeout\(\(\) => \{\s*if \(typeof document !== "undefined" && document\.visibilityState !== "visible"\) return;\s*void read\(false\)/);
  });

  it("reads on returning to the tab by visibility and by focus, under showReadWanted", () => {
    expect(source).toMatch(/if \(showReadWanted\(\{ lastReadAt: lastReadRef\.current, now: Date\.now\(\), failures: failuresRef\.current, retryAt: retryAtRef\.current \}\)\) void read\(false\);/);
    expect(source).toMatch(/document\.addEventListener\("visibilitychange", onShow\);/);
    expect(source).toMatch(/window\.addEventListener\("focus", onShow\);/);
    expect(source).toMatch(/window\.removeEventListener\("focus", onShow\);/);
  });
});

/**
 * A HISTORY AHEAD OF ITS SNAPSHOT, A VAULT CHANGE THE HISTORY HAS NOT SHOWN
 * (diagnosis 10-09, inventory D4 and push D4). The rules are live-push.ts's
 * (historyAhead, afterRead's historySlot), tested there; pinned here is that
 * the read applies them: one more snapshot inside the same read, and the
 * history's newest slot handed to afterRead.
 */
describe("a read whose history and snapshot disagree", () => {
  it("reads the snapshot once more, inside the same read, when the page holds a row past the snapshot's slot", () => {
    expect(read).toMatch(/let current = answered\.body;\s*if \(historyAhead\(pageEntries, current\.slot\)\) \{/);
    expect(read).toMatch(/const again = await api\.snapshot\(\{ owner: pensionKey, wallets: wallets\.slice\(0, MAX_WALLETS\), discover \}\);\s*if \(stale\(\)\) return true;/);
    // Only a newer, readable answer replaces the first; a refusal leaves the good one on screen and is no failure.
    expect(read).toMatch(/if \(again\.ok && again\.body\.vault\.status === "exists" && \(again\.body\.slot \?\? 0\) >= \(current\.slot \?\? 0\)\) \{\s*current = again\.body;\s*setSnapshot\(again\.body\);/);
    // Once: the second answer is never checked again.
    expect(read.match(/historyAhead\(/g)).toHaveLength(1);
    expect(read.match(/api\.snapshot\(/g)).toHaveLength(2);
  });

  it("takes the page's rows, and the newest slot of the history as it stands once the page landed", () => {
    expect(read).toMatch(/historyRead = true;\s*pageEntries = page\.body\.entries;/);
    expect(read).toMatch(/const loaded = until === null \|\| page\.body\.gap \? page\.body\.entries : \[\.\.\.page\.body\.entries, \.\.\.entriesRef\.current\];\s*historySlot = newestSlotOf\(loaded\);/);
  });
});

/**
 * HOW LIVE THE PAGE IS (owner, 10-09: "necesito que la página en general sea
 * live"). The socket's state, a read out, a change heard and not yet read, and
 * the last good read — handed to whatever draws them — and the socket brought
 * back by the page's own events.
 */
describe("liveness", () => {
  it("hands the page the socket's state, the read out, the change heard, and the last GOOD read", () => {
    expect(source).toMatch(/const liveness = useMemo\(\(\): LiveLiveness => \(\{ socket, reading, heard, lastReadAt: lastGoodAt \}\), \[socket, reading, heard, lastGoodAt\]\);/);
    expect(source).toMatch(/const heard = push\.dirty !== null;/);
    expect(source).toMatch(/liveness,\s*vaultStamp,\s*\};/);
    // The last good read moves only on success: lastReadAt moves on a failure too.
    expect(read.match(/setLastGoodAt\(/g)).toHaveLength(1);
    expect(read).toMatch(/setLastReadAt\(Date\.now\(\)\);\s*setLastGoodAt\(Date\.now\(\)\);\s*return true;/);
  });

  it("says 'none' where no socket is wanted, 'off' where one is and cannot open, and otherwise what the socket said", () => {
    expect(source).toMatch(/const socketWanted = pensionKey !== null && wantsActivity && hasWatched;/);
    expect(source).toMatch(
      /const socket: SocketState \| "none" = !socketWanted \? "none" : wsUrl === null \|\| typeof WebSocket === "undefined" \? "off" : \(socketState \?\? "connecting"\);/,
    );
    expect(source).toMatch(/onState: setSocketState,/);
    // Forgotten when the socket is closed, so a new one starts from "connecting".
    expect(source).toMatch(/watch\.close\(\);\s*if \(watchRef\.current === watch\) watchRef\.current = null;\s*setSocketState\(null\);/);
  });

  it("polls every 20 s while the push is wanted and not live, under the history's retry-after", () => {
    expect(source).toMatch(/const unheard = unheardPollWanted\(\{ socket, activityRetryAt: activityTrouble\?\.retryAt \?\? null, now: Date\.now\(\) \}\);/);
  });

  it("brings the socket back on returning to the tab, on focus and when the network returns", () => {
    const wake = source.slice(source.indexOf("const wake = (): void =>"), source.indexOf("const socketWanted ="));
    expect(wake).toMatch(/if \(document\.visibilityState === "visible"\) watchRef\.current\?\.reconnect\(\);/);
    for (const [target, event] of [
      ["document", "visibilitychange"],
      ["window", "focus"],
      ["window", "online"],
    ] as const) {
      expect(wake).toContain(`${target}.addEventListener("${event}", wake);`);
      expect(wake).toContain(`${target}.removeEventListener("${event}", wake);`);
    }
  });

  it("stamps each committed snapshot for the vault screen to follow", () => {
    expect(source).toMatch(/const vaultStamp = useMemo\(\(\) => vaultStampOf\(snapshot\), \[snapshot\]\);/);
  });
});
