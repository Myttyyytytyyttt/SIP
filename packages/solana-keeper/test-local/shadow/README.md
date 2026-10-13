# The local shadow (plan P3b)

`harness.ts` runs the dispatcher's real entry points against mainnet, read-only, next to production. It compares them with production once a minute. It is the gate between P3a and P3c (plan §3.3.2).

Nothing here runs in production or in an image: `.dockerignore` drops `test-local/` from every build context. Nothing here holds a key.

## What one run starts, and stops again

| piece | what it is | how it is contained |
|---|---|---|
| Postgres 16 | its own container, `sip-shadow-pg-<hex>`, `--rm`, the keeper's `sql/sip_solana.sql` | published on `127.0.0.1` only, trust auth, so no password exists; `docker stop` at the end removes it |
| census proxy | `census-proxy.mjs`, a byte-identical copy of `disp-measure/census/proxy.mjs` (sha256 `c202c262…8b96`) | loopback only; forwards to the public `https://api.mainnet-beta.solana.com` and to nothing else; **refuses every `send*` method and every websocket**; logs one line per JSON-RPC call to `rpc/calls.jsonl` |
| relay | inside the harness, in front of the proxy | one path per process (`sched-a`, `worker-a`, …), so the proxy's lines say who asked; the drills freeze a path to hold a worker mid-job |
| 2 schedulers | `bin/scheduler.mts`; one takes `sip-solana-scheduler`, one stands by | `SIP_SOLANA_DISPATCH=shadow` |
| 2 workers × 2 slots | `bin/worker.mts` | `SIP_SOLANA_DISPATCH=shadow` |
| handover | `bin/dispatch-handover.mts`: `new-vaults queue`, then `arm --all --roles=none --allow-dry` until the vaults move | — |

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

It lists each of these in `stopped.json` and `report.json`. A harness that ends on an error still SIGKILLs its children and `docker rm -f`s its container as it exits.

## A run

On Node 22, from `packages/solana-keeper`:

```sh
export PATH=$HOME/.nvm/versions/node/v22.14.0/bin:$PATH
node --import tsx test-local/shadow/harness.ts --out <dir> --minutes 55 \
  --model <scratchpad>/disp-measure/model/model.py
```

| option | default | what it does |
|---|---|---|
| `--minutes` | 55 | the window after the fleet is up. Setup (database, discovery, the 150-block `arm`) adds about 2 minutes before it |
| `--drills` | `worker-kill@10,worker-sigterm@17,scheduler-kill@24,pg-pause@31` | minutes into the window, run one at a time. `none` runs none. A drill due in the window's last 3 minutes is skipped |
| `--drill-repeat-hours` | 0 | repeats the drill schedule every so many hours |
| `--model` | none | disp-measure's `model.py`. Without it, the credits are measured but not compared with the model |
| `--cuts` | none | the token set, the same on both kinds of process (plan design detail 4). The model's prediction follows it |
| `--proxy` | `census-proxy.mjs` here | — |
| `--production` | both Railway `/status` URLs | `none` skips the comparison |
| `--analyze <dir>` | — | recomputes `report.json` and `summary.txt` from a run's files, with no process started |

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
| `run.json`, `events.jsonl`, `stopped.json` | the run's settings, its timeline, and what it stopped |

What `report.json` measures, against the gate in plan §3.3.2:
- **agreement**: rows where settle **and** invest are equal, divided by the rows compared. Rows where a side had nothing fresh within 150 s are listed as gaps and never counted as agreement. Each mismatch is labelled:
  - `dry-run`: the shadow's detail says what it would have sent;
  - `timing`: for each half that differs (settle, invest), each side showed the other's value within two minutes;
  - `transient`: one side's settle failed (THREW, INCOMPLETE or RETRY) and the next minute agrees;
  - `unexplained`.

  Production's decision for a wallet is the settle of the keeper that serves the wallet's mode, plus the invest of the profit keeper **for the wallet's vault**. The legacy keeper invests on each link's turn, so on a two-link vault one wallet shows the buy and the other shows IDLE in the same sweep; a worker invests once per vault. The shadow's decision is the newest completed job of the wallet's vault. The report replays the comparison from `production.jsonl` and `jobs.jsonl`, so `--analyze` re-reads a finished run under the current rules.
- **overlap**: the audit over the `shadow` intents, every minute and at the end. Must be 0.
- **discovery**: `getProgramAccounts(V2)` calls on the schedulers' paths, per whole UTC minute. Must be exactly 1. A takeover can put two holders' listings into one minute; the gaps between listings are shown beside it.
- **credits**: the proxy's calls priced by `src/rpc-usage.ts` at archival 1 and 10, scaled to a day. They sit beside the model's prediction for the same token set:
  - the scheduler's chain snapshot;
  - one `getMultipleAccounts` per job;
  - each link's resting settle and each vault's resting invest, from `model.py`'s own per-turn costs;
  - the listing.

  The gate is within +15 %. The processes' own `rpc_usage` totals are in `report.json` for a cross-check.
- **drills**: each with its timings, each judged by the checks written in `harness.ts`.

## The 7-day version (P3b's gate; the owner chooses where it runs, decision O3)

On the owner's Mac, kept awake:

```sh
caffeinate -dimsu node --import tsx test-local/shadow/harness.ts --out ~/sip-shadow-7d \
  --minutes 10080 --drill-repeat-hours 24 \
  --model <path>/model.py > ~/sip-shadow-7d.out 2>&1 &
```

- `--drill-repeat-hours 24` runs the four drills once a day, at minutes 10, 17, 24 and 31 of each day.
- At today's fleet a run writes about 1.3 MB an hour in all, so about 220 MB over 7 days. Half a megabyte an hour of that is `rpc/calls.jsonl` (measured in the 2026-10-13 smoke). Check that disk space is free.
- To stop early, send the harness SIGINT or SIGTERM. It then analyses what it has, and stops and removes everything.
- `--analyze <dir>` can be re-run at any time.
- A sleeping Mac shows up as `no-shadow` and `no-production` gaps and as minutes with no listing. The gate asks for gaps to be listed, not hidden.

The gate (plan §3.3.2):
- ≥ 7 × 24 h of ticks;
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

**Drills not scripted here:**
- **A scheduler blocked on a call that never returns.** Every RPC call has a 30 s timeout (`src/rpc-pool.ts`) and every statement a 5 s one, so a frozen path fails a tick instead of hanging it. `test/watchdog.test.ts` covers the watchdog.
- **SIGTERM with the drain at 0.** That is `worker-kill`'s case: the lease runs out instead.
