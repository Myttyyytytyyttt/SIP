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
  it("draws early only the FIRST snapshot, through the gate, and only onto a store holding none (its timing is lib/first-paint.test.ts's)", () => {
    expect(read).toMatch(/const paint = \(\): void => \{\s*const at = Date\.now\(\);\s*setStore\(\(held\) => paintFirst\(held, answered\.body, at\)\);\s*\};/);
    expect(read).toMatch(/const gate = holdFirstPaint \? firstPaintGate\(\{ hold: true, commit: paint, stale, waitMs: FIRST_PAINT_WAIT_MS \}\) : null;/);
    // paintFirst refuses a store that already holds a snapshot (live-commit.test.ts).
    expect(read.match(/paintFirst\(/g)).toHaveLength(1);
  });

  it("holds only the FIRST snapshot, and only when there is a history to wait for", () => {
    expect(read).toMatch(/const holdFirstPaint = snapshotRef\.current === null && wantsActivity && answered\.body\.vault\.status === "exists";/);
  });

  it("ends a previous failure as soon as a held snapshot has answered, so the error card does not outlive the answer", () => {
    expect(read).toMatch(/if \(holdFirstPaint\) \{\s*setFailures\(0\);\s*setFailure\(null\);\s*\}/);
    expect(read.search(/if \(holdFirstPaint\) \{\s*setFailures\(0\)/)).toBeLessThan(read.indexOf("api.activity("));
  });

  it("asks for the history after the gate is armed, cancels it at the read's own commit, and releases it in a finally for a read that ended without one", () => {
    const armed = read.indexOf("const gate = holdFirstPaint");
    const asked = read.indexOf("api.activity(");
    const cancelled = read.indexOf("gate?.cancel();");
    const released = read.search(/\} finally \{\s*gate\?\.release\(\);\s*\}/);
    expect(armed).toBeGreaterThan(-1);
    expect(asked).toBeGreaterThan(armed);
    expect(cancelled).toBeGreaterThan(asked);
    expect(released).toBeGreaterThan(cancelled);
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

/**
 * EVERY READ COMMITS ONCE (UI plan 10-09, §5 item 7). The rule of the commit
 * is live-commit.ts's, tested there with the converting and buying lines; what
 * is pinned here is that the read makes no other: the first paint's early draw
 * aside, nothing of what it read reaches the screen before its last answer, and
 * then all of it does in one update.
 */
describe("every read commits once", () => {
  const commitAt = read.search(/setStore\(\(held\) => commitRead\(/);

  it("writes the store in two places only: the first paint's early draw and the read's one commit", () => {
    expect(read.match(/setStore\(/g)).toHaveLength(2);
    expect(read).toMatch(/gate\?\.cancel\(\);\s*const at = Date\.now\(\);\s*setStore\(\(held\) => commitRead\(held, \{ snapshot: current, history, linkRows, at \}\)\);/);
    // No setter of its own for any part of what a read brings, anywhere in the hook.
    expect(source).not.toMatch(/\bset(Snapshot|Entries|LinkEntries|ActivityMeta|ActivityTrouble|LastGoodAt)\(/);
  });

  it("commits after its LAST answer — the head page, the settlement round and the snapshot's re-read — and awaits nothing after", () => {
    expect(commitAt).toBeGreaterThan(read.indexOf("api.activity("));
    expect(commitAt).toBeGreaterThan(read.search(/await backfillLinkSettlements\(/));
    expect(commitAt).toBeGreaterThan(read.lastIndexOf("api.snapshot("));
    const after = read.slice(commitAt, read.search(/\} finally \{\s*gate\?\.release\(\);/));
    expect(after).not.toMatch(/\bawait\b/);
    // The failure cleared, the push's coverage and the floor's clock land in the same render.
    expect(after).toMatch(/setFailures\(0\);\s*setFailure\(null\);\s*setUnheardRefused\(false\);/);
    expect(after).toContain("setPush((held) => afterRead(");
    expect(after).toContain("setLastReadAt(Date.now());");
  });

  it("gathers the history it read for that commit instead of drawing it", () => {
    expect(read).toMatch(/history = \{ page, until, early, answeredAt: Date\.now\(\) \};/);
    expect(read).toMatch(/linkRows\.push\(\.\.\.filled\.entries\);/);
  });

  it("forgets a pension's store when the key changes, and keeps the read count going; Load older appends without counting", () => {
    expect(source).toMatch(/request\.current \+= 1;\s*setStore\(forgottenData\);/);
    expect(source).toMatch(/setStore\(\(held\) => withOlderPage\(held, page\.body\)\);/);
    expect(source.match(/setStore\(/g)).toHaveLength(4);
  });
});

/**
 * WHAT WAS ASKED FOR A PENSION ENDS WITH IT (review 2026-10-09): on a key
 * change and on unmount. A refresh deferred to the floor could fire afterwards
 * with the old key and the newest request number, and commit pension A into
 * pension B's store; a Load older page answering late appended A's rows and
 * cursor to B's forgotten store.
 */
describe("what was asked for a pension ends with it", () => {
  const reset = source.slice(source.indexOf("request.current += 1;\n    setStore(forgottenData);"), source.indexOf("const read = useCallback"));
  const refresh = source.slice(source.indexOf("const refresh = useCallback"), source.indexOf("const loadOlder"));
  const older = source.slice(source.indexOf("const loadOlder"), source.indexOf("const walletChanges"));

  it("moves the key's epoch, drops the read out and clears the deferred refresh in the reset's cleanup — which runs on a key change and on unmount", () => {
    expect(reset).toMatch(
      /return \(\) => \{\s*keyEpoch\.current \+= 1;\s*request\.current \+= 1;\s*if \(deferred\.current !== null\) window\.clearTimeout\(deferred\.current\.timer\);\s*deferred\.current = null;\s*\};\s*\}, \[pensionKey, wantsActivity\]\);/,
    );
    // Nowhere else: an epoch that moved on a read would drop the older page a poll landed beside.
    expect(source.match(/keyEpoch\.current \+= 1/g)).toHaveLength(1);
  });

  it("keeps ONE deferred refresh, in a ref the reset can clear, and reads from it only for the pension it was armed for", () => {
    // No bare timer the reset cannot reach.
    expect(refresh).not.toMatch(/window\.setTimeout\(\(\) => void read\(/);
    expect(refresh).toMatch(/const epoch = keyEpoch\.current;/);
    expect(refresh).toMatch(/if \(epoch !== keyEpoch\.current\) return;\s*void read\(armed\.discover\);/);
    expect(refresh).toMatch(/deferred\.current = armed;/);
    // A press inside the floor joins the one waiting, and keeps its re-listing.
    expect(refresh).toMatch(/if \(deferred\.current !== null\) \{\s*deferred\.current\.discover \|\|= discover;\s*return;\s*\}/);
    expect(refresh.match(/window\.setTimeout\(/g)).toHaveLength(1);
  });

  it("drops a Load older page of a pension no longer on screen before it touches the store, the cursor or `busy`", () => {
    expect(older.indexOf("const epoch = keyEpoch.current;")).toBeGreaterThan(-1);
    expect(older.indexOf("const epoch = keyEpoch.current;")).toBeLessThan(older.indexOf("api.activity("));
    expect(older).toMatch(/\.then\(\(page\) => \{\s*if \(epoch !== keyEpoch\.current\) return;\s*olderBusyRef\.current = false;/);
  });
});

describe("Load older is offered only when there is an older page", () => {
  it("is worked out from the cursor a head page named, never stored beside it — and so is 'complete'", () => {
    expect(source).toMatch(/available: cursor !== null/);
    expect(source).toMatch(/const cursor = activityMeta\?\.nextBefore \?\? null;/);
    expect(source).toMatch(/const complete = historyComplete\(store\);/);
    expect(source).not.toMatch(/complete: (false|page|cursor)/);
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
    expect(poll).toMatch(/\}, \[pensionKey, failures, lastReadAt, failure, activityTrouble, tick, read, reading, visible, pendingActive, socket, unheardRefused\]\);/);
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
    expect(read).toMatch(/if \(again\.ok && again\.body\.vault\.status === "exists" && \(again\.body\.slot \?\? 0\) >= \(current\.slot \?\? 0\)\) \{\s*current = again\.body;\s*\}/);
    // And it is what the read commits, with the page that bought it (§5 item 7).
    expect(read.indexOf("snapshot: current, history, linkRows")).toBeGreaterThan(read.indexOf("current = again.body;"));
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
 * live"; UI plan 10-09, §5 items 1-7). The socket's state, a read out, what
 * was heard and not yet read, the last good commit, when a refresh stops
 * waiting, when the next read is due, whether the reads back off, and the read
 * count — handed to whatever draws them — and the socket brought back by the
 * page's own events. The rules are live-push.ts's and live-schedule.ts's.
 */
describe("live", () => {
  it("hands the page every signal in one object, returned as `live`", () => {
    expect(source).toMatch(
      /const live = useMemo\(\s*\(\): LiveLiveness => \(\{ socket, reading, heard, lastReadAt: committedAt, refreshReadyAt, nextReadAt, backingOff, readId \}\),\s*\[socket, reading, heard, committedAt, refreshReadyAt, nextReadAt, backingOff, readId\],\s*\);/,
    );
    expect(source).toMatch(/live,\s*vaultStamp,\s*\};/);
    expect(source).not.toMatch(/\bliveness\b/);
  });

  it("heard: the push's outstanding urgent changes, one object while what it says is the same", () => {
    expect(source).toMatch(/const heardNow = heardOf\(push\);\s*if \(!sameHeard\(heardRef\.current, heardNow\)\) heardRef\.current = heardNow;\s*const heard = heardRef\.current;/);
  });

  it("reading: the snapshot-and-history read only — Load older has its own busy", () => {
    expect(source.match(/setReading\(/g)).toHaveLength(2);
    expect(read.match(/setReading\(/g)).toHaveLength(2);
    const older = source.slice(source.indexOf("const loadOlder"), source.indexOf("const walletChanges"));
    expect(older).not.toMatch(/setReading|readingRef/);
  });

  it("lastReadAt: the last GOOD commit's moment, from the store — a failed read never moves it, and the floor's clock is another", () => {
    expect(source).toMatch(/const \{ readId, committedAt \} = store;/);
    // The floor's clock moves on a failure and on a success, nowhere else.
    expect(read.match(/setLastReadAt\(Date\.now\(\)\)/g)).toHaveLength(2);
  });

  it("refreshReadyAt: the floor after the last read FINISHED, the one refresh() itself waits for", () => {
    expect(source).toMatch(/const refreshReadyAt = manualReadyAt\(lastReadAt\);/);
    expect(source).toMatch(/const delay = nextManualDelayMs\(\{ lastReadAt: lastReadRef\.current, now: Date\.now\(\), retryAfterSeconds: null \}\);/);
  });

  it("nextReadAt: the moment each timer was armed for, the earlier of the two, none while hidden or while a read is out", () => {
    // `reading` is this render's, handed in: the timers' moments are cleared only after it has painted.
    expect(source).toMatch(/const nextReadAt = nextReadAtOf\(\{ visible, reading, pollAt, pushAt \}\);/);
    expect(source).toMatch(/setPollAt\(Date\.now\(\) \+ when\);\s*const timer = window\.setTimeout\(/);
    expect(source).toMatch(/setPushAt\(delay === null \? null : Date\.now\(\) \+ delay\);\s*if \(delay === null\) return undefined;\s*const timer = window\.setTimeout\(/);
    // Every way out of either effect without a timer says so.
    expect(source.match(/setPollAt\(null\);/g)).toHaveLength(2);
    expect(source.match(/setPushAt\(null\);/g)).toHaveLength(1);
  });

  it("arms and clears both timers with the tab's visibility, kept as state", () => {
    expect(source).toMatch(/const onVisibility = \(\): void => setVisible\(document\.visibilityState === "visible"\);/);
    expect(source).toMatch(/\}, \[pensionKey, push\.dirty, lastReadAt, visible, reading, failures, retryAt, tick, read\]\);/);
    // Neither effect reads the document for it any more.
    expect(source).not.toMatch(/const visible = typeof document/);
  });

  it("backingOff: a failure's backoff, or a refusal the 20 s cadence earned", () => {
    expect(source).toMatch(/const backingOff = backingOffOf\(\{ failures, refused: unheardRefused \}\);/);
  });

  it("readId: the store's count of reads committed whole", () => {
    expect(source).not.toMatch(/readId\s*[+-]=|setReadId/);
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
    expect(source).toMatch(
      /const unheard = unheardPollWanted\(\{ socket, activityRetryAt: activityTrouble\?\.retryAt \?\? null, now: Date\.now\(\), refused: unheardRefused \}\);\s*unheardRef\.current = unheard;/,
    );
  });

  it("does not let a 429 that cadence earned back the tab off: it goes back to the minute until a read succeeds", () => {
    // Review 2026-10-09: the bucket is per client, and three tabs behind one NAT on 20 s overspend it.
    expect(read).toMatch(
      /if \(refusalBacksOff\(\{ rateLimited, unheard: unheardRef\.current, failures: failuresRef\.current \}\)\) setFailures\(\(count\) => count \+ 1\);\s*else setUnheardRefused\(true\);/,
    );
    expect(read).toMatch(/setFailures\(0\);\s*setFailure\(null\);\s*setUnheardRefused\(false\);/);
    expect(read.match(/setFailures\(\(count\) => count \+ 1\)/g)).toHaveLength(1);
  });

  it("brings the socket back on returning to the tab, on focus and when the network returns", () => {
    const wake = source.slice(source.indexOf("const wake = (): void =>"), source.indexOf("const socketWanted ="));
    expect(wake).toMatch(/if \(document\.visibilityState === "visible"\) watchRef\.current\?\.reconnect\(\);/);
    for (const [target, event] of [
      ["document", "visibilitychange"],
      ["window", "focus"],
    ] as const) {
      expect(wake).toContain(`${target}.addEventListener("${event}", wake);`);
      expect(wake).toContain(`${target}.removeEventListener("${event}", wake);`);
    }
    // Only the network coming back starts the socket's count again (review 2026-10-09: a focus used to, and outran the backoff).
    expect(wake).toMatch(/const online = \(\): void => watchRef\.current\?\.reconnect\(\{ network: true \}\);/);
    expect(wake).toContain(`window.addEventListener("online", online);`);
    expect(wake).toContain(`window.removeEventListener("online", online);`);
    expect(source.match(/reconnect\(\{ network: true \}\)/g)).toHaveLength(1);
  });

  it("stamps each committed snapshot for the vault screen to follow", () => {
    expect(source).toMatch(/const vaultStamp = useMemo\(\(\) => vaultStampOf\(snapshot\), \[snapshot\]\);/);
  });
});
