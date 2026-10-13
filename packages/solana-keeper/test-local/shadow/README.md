# The local shadow (plan P3b)

`harness.ts` runs the dispatcher's real entry points against mainnet, read-only, next to production. It compares them with production once a minute. It is the gate between P3a and P3c (plan §3.3.2).

Nothing here runs in production or in an image: `.dockerignore` drops `test-local/` from every build context. Nothing here holds a key.

## What one run starts, and stops again

| piece | what it is | how it is contained |
|---|---|---|
| Postgres 16 | its own container, `--rm`, labelled with the state directory, the keeper's `sql/sip_solana.sql`. Without `--pg-volume`: `sip-shadow-pg-<hex>`, its data gone with it. With `--pg-volume sip-shadow-<x>`: the data lives in that named volume (created with the run's label, refused if it carries another), so the next session finds the same database | published on `127.0.0.1` only, trust auth, so no password exists; `docker stop` at the end removes the container and never the volume |
| census proxy | `census-proxy.mjs`, a byte-identical copy of `disp-measure/census/proxy.mjs` (sha256 `c202c262…8b96`) | loopback only; forwards to the public `https://api.mainnet-beta.solana.com` and to nothing else; **refuses every `send*` method and every websocket**; logs one line per JSON-RPC call to `rpc/calls.jsonl` |
| relay | inside the harness, in front of the proxy | one path per process (`sched-a`, `worker-a`, …), so the proxy's lines say who asked; the drills freeze a path to hold a worker mid-job |
| 2 schedulers | `bin/scheduler.mts`; one takes `sip-solana-scheduler`, one stands by | `SIP_SOLANA_DISPATCH=shadow` |
| 2 workers × 2 slots | `bin/worker.mts` | `SIP_SOLANA_DISPATCH=shadow` |
| handover | `bin/dispatch-handover.mts`: `new-vaults queue`, then `arm --all --roles=none --allow-dry` until the vaults move. A resumed database whose vaults are all in the queue skips both | — |

How every child is started:
- with `env -i`, so nothing from the shell reaches it;
- with only these variables: `PATH`, `HOME`, `SIP_SOLANA_RPC_URLS` (its relay path), `SIP_SOLANA_PROGRAM_ID`, `DATABASE_URL`, `SIP_SOLANA_DISPATCH=shadow`, plus `PORT` for a scheduler, `SIP_SOLANA_WORKER_SLOTS=2` for a worker, and `SIP_SOLANA_CUTS` when `--cuts` is given;
- with **no key and no broadcast flag**;
- with `scripts/bench-offline.mts` preloaded, so a request to any host but the loopback is refused inside the process. That includes a would-be Jupiter quote.

When the run ends, the harness:
- SIGTERMs every child and SIGKILLs any that is still running 35 s later;
- closes the relay;
- stops the proxy;
- stops the container.

It lists each of these in `stopped.json` and `report.json`. A harness that ends on an error still SIGKILLs its children and removes its container as it exits (with a named volume, after a clean `docker stop`). A harness killed with `kill -9` cannot. The next `--resume` first stops what it left: its children by pid (only if they still run this keeper's code or name the state directory), and its container (only if it carries the run's label).

## A run

On Node 22, from `packages/solana-keeper`:

```sh
export PATH=$HOME/.nvm/versions/node/v22.14.0/bin:$PATH
node --import tsx test-local/shadow/harness.ts --state <dir> --minutes 55 \
  --model <scratchpad>/disp-measure/model/model.py
```

| option | default | what it does |
|---|---|---|
| `--state <dir>` (or `--out`) | — | the state directory: every result, log and summary, and the run's settings and sessions. A directory that already holds a run needs `--resume` |
| `--resume` | off | continues the run the directory holds, **with the settings it was started with** (options that differ are ignored and listed). On an empty directory it starts a new run |
| `--minutes` / `--target-hours` | 55 min | the coverage target: the run ends when this much time is **covered** (below), not at a wall-clock instant. Setup (database, discovery, the 150-block `arm`) comes before it |
| `--pg-volume` | none | a named Docker volume (`sip-shadow-<x>`) for Postgres, so a restart resumes with the same database |
| `--drills` | `worker-kill@10,worker-sigterm@17,scheduler-kill@24,pg-pause@31,pg-outage@38` | `name@minutes` on the coverage clock, run one at a time; `week` is the long run's plan (below); `none` runs none. A drill due in the target's last 3 minutes is not started |
| `--drill-repeat-hours` | 0 | repeats a `name@minutes` schedule every so many covered hours |
| `--drill-warmup-minutes`, `--drill-spacing-minutes` | 5, 5 | no drill in a session's first minutes, nor closer than this to the end of the last one |
| `--report-every-minutes` | 30 | the rolling report: `--analyze` in a separate process, 10 minutes into each session and then this often |
| `--model` | none | disp-measure's `model.py`. Without it, the credits are measured but not compared with the model |
| `--cuts` | none | the token set, the same on both kinds of process (plan design detail 4). The model's prediction follows it |
| `--proxy` | `census-proxy.mjs` here | — |
| `--production` | both Railway `/status` URLs | `none` skips the comparison |
| `--analyze <dir>` | — | recomputes `report.json` and `summary.txt` from a run's files, with no process started; safe while the run goes on |

Exit codes:
- 0: the target was reached, or a signal stopped it cleanly;
- 1: setup failed;
- 2: options, or a state directory, it will not use;
- 3: another harness runs on the same directory.

A process that exits on its own (not a drill's victim) is written to `exits.jsonl` and replaced, as Railway's ON_FAILURE would, at most ten times an hour.

## What it writes into `<dir>`

| file | contents |
|---|---|
| `summary.txt`, `report.json` | the gate's numbers (below) |
| `compare.jsonl` | the live loop's row per wallet per minute: production's settle and invest beside the shadow's, the verdict, and each side's frontier slot |
| `production.jsonl` | production's two `/status` bodies, trimmed to the role, the sweep clock and the per-wallet rows |
| `jobs.jsonl`, `ticks.jsonl` | every worker job line and every scheduler tick line |
| `audit.jsonl` | each minute: the overlap audit, the intents by state, `vault_work`, the `worker` rows and the `fleet` row |
| `drills.jsonl` | each drill's measurements and pass/fail |
| `rpc/calls.jsonl` | the proxy's log, one line per call |
| `logs/<process>.log` | each child's own output |
| `final-db.json` | the end state: the audit, the intents, `rpc_usage` as the processes metered it |
| `run.json`, `events.jsonl`, `stopped.json` | the run's settings and sessions, its timeline, and what its last session stopped |
| `coverage.jsonl` | one beat a minute: the session, whether the fleet was up, the drill running. The coverage clock is read from these |
| `status.json` | rewritten every minute: covered hours, gaps, overlap, drills, the next drill. What `mac/status.sh` shows |
| `exits.jsonl` | each process that exited on its own, which the harness then replaced |
| `harness.pid`, `children.json` | who runs now: one harness per directory, and the children a `--resume` stops if a killed harness left them |

What `report.json` measures, against the gate in plan §3.3.2 (its `gate` block says PASS, FAIL or PENDING for each check):
- **coverage**: the sum of the steps between consecutive beats that belong to one session, with the fleet up (≥ 1 scheduler and ≥ 1 worker alive) at both, and no longer than 135 s (one skipped beat). Every other step is a **gap**, listed with its cause (`src/shadow-compare.ts`, `coverageOf`):
  - across two sessions, the cause the resumed session recorded: stopped cleanly; ended without stopping (killed, crashed, the power); or the Mac restarted (the machine's boot time is after the last beat);
  - a long step inside one session: the Mac slept, or the process was frozen;
  - the fleet down at a beat.

  Agreement, listings and credits are counted over the covered time only.
- **agreement**: rows where settle **and** invest are equal, divided by the rows compared. Rows where a side had nothing fresh within 150 s are listed as gaps and never counted as agreement. Each mismatch is labelled:
  - `dry-run`: the shadow's detail says what it would have sent;
  - `timing`: for each half that differs (settle, invest), each side showed the other's value within two minutes;
  - `transient`: one side's settle failed (THREW, INCOMPLETE or RETRY) and the next minute agrees;
  - `unexplained`.

  Production's decision for a wallet is the settle of the keeper that serves the wallet's mode, plus the invest of the profit keeper **for the wallet's vault**. The legacy keeper invests on each link's turn, so on a two-link vault one wallet shows the buy and the other shows IDLE in the same sweep; a worker invests once per vault. The shadow's decision is the newest completed job of the wallet's vault. The report replays the comparison from `production.jsonl` and `jobs.jsonl`, so `--analyze` re-reads a finished run under the current rules.
- **overlap**: the audit over the `shadow` intents, every minute and at the end. Must be 0.
- **discovery**: `getProgramAccounts(V2)` calls on the schedulers' paths, per whole covered UTC minute. Must be exactly 1 in every quiet minute. The minutes a drill touched are counted apart: a takeover puts two holders' listings into one minute, a blocked scheduler none. The gaps between listings are shown beside it.
- **credits**: the proxy's calls priced by `src/rpc-usage.ts` at archival 1 and 10, scaled to a day. They sit beside the model's prediction for the same token set:
  - the scheduler's chain snapshot;
  - one `getMultipleAccounts` per job;
  - each link's resting settle and each vault's resting invest, from `model.py`'s own per-turn costs;
  - the listing.

  The gate is within +15 %. The processes' own `rpc_usage` totals are in `report.json` for a cross-check.
- **drills**: each with its timings, each judged by the checks written in `harness.ts`, each with an id that is the same in every session. A drill with a result is never run again; one the harness stopped in the middle of is written as `interrupted` and owed again, once. The worker drills:
  - `worker-kill`: SIGKILL a worker held mid-job. The successor waits the lease out, then takes the vault at a higher fence.
  - `worker-sigterm-0`: Railway's draining at 0 s, SIGTERM and SIGKILL in the same instant. No release can happen, so it must look exactly like `worker-kill` (ADR §4.9 row 27).
  - `worker-sigterm-30` (`worker-sigterm` is the same): SIGTERM, then SIGKILL at 30 s if the worker still runs, as Railway does with `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`. The 20 s drain runs out, the vault is released due now, the process exits 0 inside the 30 s, and the other worker takes the vault without the 45 s wait.

  The scheduler drills:
  - `scheduler-kill`: the standby takes the lock at its next tick, with a full pass.
  - `scheduler-blocked`: every call the lock holder makes is held by the relay and never answered, for 240 s. The bound is the RPC pool's 30 s per call. A tick whose every call is held makes about four of them one after another (measured: two for the chain snapshot, the listing, keeper_link's re-read), so it takes about 120 s, and 240 s holds a whole one. It passes if no call stays held past the bound, a tick ends inside the freeze (failed, or on keeper_link's last-known-good list), and the process lives (or its watchdog exits it with code 3 and the standby takes the lock). After the thaw, a fresh listing and a completed job must come back. The watchdog's 10-minute exit, for a wedge no timeout covers, stays `test/watchdog.test.ts`'s.

  The two database drills prove different things:
  - `pg-pause` (20 s) is a **brief** outage. It is shorter than a held lease's 35 s past the gate's 10 s margin, so no lease lapses and no gate is refused because of it, and the scheduler's lock check falls inside it only when a tick happens to. It proves: nothing commits while the database is away, every process lives, and everything recovers on its own.
  - `pg-outage` (75 s) is the **long** one. A worker is first held mid-job, then the database is paused past every held lease and over a whole scheduler tick, and the worker's job is let go into it. It passes only if nothing commits; each held vault's lease ran out inside the pause and the vault was worked again after it (claimed at a higher fence, or completed at its own); the lock holder's session check failed inside the pause; a scheduler then took the lock with a full pass; a job completed; every process lived; nothing was parked; and the overlap audit is empty.

## The 7-day version (P3b's gate; the owner chose his Mac, decision O3)

`mac/start.sh`, `mac/status.sh` and `mac/stop.sh` run it. They are copied into a folder that survives a reboot (`/private/tmp` does not), with the code and the model beside them:

```
~/sip-shadow-7d/
  start.sh status.sh stop.sh
  code/            a detached git worktree of this branch, with pnpm install done
  model/model.py   disp-measure's cost model
  state/           the run: everything above, plus harness.out
```

```sh
~/sip-shadow-7d/start.sh    # starts, or resumes the run in state/
~/sip-shadow-7d/status.sh   # one screen, in Spanish
~/sip-shadow-7d/stop.sh     # stops cleanly; the state and the database stay
```

- `start.sh` refuses to start twice. It says plainly when Docker is not running, and warns when the Mac is on battery.
- It starts a loop under `nohup` and `caffeinate -i -s`. The loop runs `harness.ts --state state --pg-volume sip-shadow-7d-pgdata --target-hours 168 --drills week --model model/model.py`, adding `--resume` whenever `state/run.json` exists. If the harness exits with an error, the loop waits for Docker and resumes it, up to 50 times.
- `--drills week` owes each of the seven drills once per covered day, 49 in all. Day d's slots are covered hours 1, 4, 7, 10, 13, 16 and 19, and drill k takes slot (k + d) mod 7, so every drill meets every slot once over the week.
- A night the Mac slept, a crash or a reboot does not move the target: the run ends when 168 hours are **covered**, and every gap is listed with its cause.
- After a reboot nothing starts by itself. Open Docker Desktop, then run `start.sh` again: it resumes, and the gap shows as "the Mac restarted".
- `caffeinate -s` holds only on AC power, and a closed lid sleeps the Mac anyway. Keep it plugged in with the lid open.
- At today's fleet a run writes about 1.3 MB an hour, about 220 MB over 7 days. `start.sh` refuses with less than 2 GB free.

The gate (plan §3.3.2):
- ≥ 7 × 24 h of covered ticks, gaps listed;
- agreement ≥ 99 %, with every mismatch explained;
- overlap 0;
- exactly one listing a minute;
- credits within +15 % of the model;
- every drill passed.

What this cannot prove:
- Railway's webhook routing;
- the drain variable as Railway applies it;
- Supabase's pool;
- Privy signing;
- real sends on mainnet;
- Helius's own bill.

`test-local/fence-local.local.test.ts` holds the money proof, on a throwaway validator.
