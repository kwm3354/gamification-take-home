# Brief 15: outbox lease and workers

Wave 7. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
Fix a design mistake in a working NestJS + PostgreSQL + TigerBeetle prototype (a gamification backend for casino operators), found by a performance measurement. It has 281 passing backend tests. You work in your own git worktree on your own branch. Time box: 30 minutes.

The mistake: the outbox runs a job's handler WHILE HOLDING the job row's lock, i.e. with a database transaction open and a pooled connection held, and the handlers call the casino platform over HTTP and the ledger over the network. The same happens in the request path of a redemption (`runInline` in src/store/redemption.ts takes the job row lock in a transaction and runs the steps inside it, limited to 2 at a time by `new Slots(2)` in src/store/store.service.ts). The rule that was broken: no network call inside a database transaction. Measured effect (docs/performance.md): redemptions capped at about 30 per second at any concurrency; `pg_stat_activity` showed sessions "idle in transaction"; outbox jobs run strictly one after another, so under load platform B redemptions took 34-42 s to become final.

Another agent works in parallel on web/**, src/admin/**, docs/architecture.md, README.md: do not touch those. 

## Read first
CLAUDE.md; docs/contracts.md ("Shape", "Outbox", "Redemption: one intent, two steps", "Tracing", "Logs"); docs/performance.md (sections on where the time goes); src/outbox/outbox.ts and outbox.module.ts; src/store/redemption.ts (ALL of it: `step`, `advance`, `confirm`, `applyNotice`, `runInline`, `Slots`, and the comments about lock order between the job row and the redemption row) and store.service.ts; src/events/rewards.controller.ts; src/admin/resolve.ts; src/wheel/spin.ts and wheel.controller.ts; src/db.ts (pool size 5, the tracing wrapper) and src/config.ts; src/schema.sql (table outbox); src/ledger/coin-ledger.tigerbeetle.ts; test/outbox.test.ts, test/store.test.ts (especially test 21, the timer-against-request race, and tests 13, 15), test/admin.test.ts test 8, test/tracing.test.ts.

## Machine setup (first, exactly)
```
npm ci
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle     # in every shell that runs tests
npm run verify      # must be green (281 tests) before you change anything
```
The CPU has no AVX2 (the script swaps in a local TigerBeetle client build). The disk is nearly full and the machine is busy: do not run docker compose; delete your own /tmp/tb-* directories if a run is killed. Do not stop containers you did not start.

## The fix (three commits, in this order; a failing test first for each)

### Commit 1: the outbox claims by lease, runs the handler with no transaction, finishes with a fence
- Schema (edit the CREATE TABLE in place; the file is the only migration; keep it safe to run twice): add to `outbox` `claimed_until timestamptz` and `claim_token uuid`. Adjust the partial index if the claim query needs it; check with EXPLAIN that the claim can use an index and say what you saw.
- Claim, one short transaction (or one statement): pick due jobs (`done_at IS NULL AND dead_at IS NULL AND run_at <= now AND (claimed_until IS NULL OR claimed_until <= now)`, ordered by run_at, id, `LIMIT n`, `FOR UPDATE SKIP LOCKED`) and set `claimed_until = now + lease` and a fresh `claim_token`; commit; THEN run the handlers with no transaction and no connection held. `now` from the injected clock. Lease length: a constructor option, default 60 s; it must be longer than the longest handler (platform time limit + ledger time limit, both 2 s by default); say so in a comment.
- Finish: write the outcome (done / retry with run_at and attempts / dead) with `WHERE id = $1 AND claim_token = $2`, and clear the claim. If no row matches, the lease was lost to another worker: write nothing, log `outbox.lease_lost` (warn) { kind, refId }. This is the fence: a slow worker cannot overwrite the outcome of the worker that took over.
- A worker that dies mid-handler leaves a claimed row; after `claimed_until` passes, the job is due again. Handlers are already safe to repeat (that was always the contract).
- `runDue()` claims up to `batch` jobs (constructor option, default 16) and runs their handlers concurrently, loops until nothing is due, returns how many ran. `enqueue` on an existing row keeps working as documented (re-arm, revive) and also clears a claim? No: do NOT clear a live claim on re-enqueue (the running worker's finish would be fenced out and the job would run twice at once); instead, when the row is claimed and the claim is live, set a flag column `rerun boolean NOT NULL DEFAULT false` to true, and at finish, if `rerun` is true, the job is made due again immediately instead of done (and the flag cleared). Test this precisely: an enqueue that arrives while the handler runs leads to exactly one more run after it, never a concurrent one.
- Expose `claimOne(kind, refId)` -> a claim handle or null, and `finish(handle, outcome)`, so a request can run its own job under the same lease rules (used in commit 2). Keep `drain()`.
- Tracing and logs: keep the `outbox <kind>` root span around the handler and the existing log events; add `outbox.lease_lost`.
- Tests (test/outbox.test.ts; keep all existing ones meaningful, adapt where the mechanism changed): (1) while a handler is awaiting a promise the test controls, NO session of this database is "idle in transaction" and none holds a row lock on outbox (query `pg_stat_activity` / `pg_locks` from a separate connection); this test must FAIL on the old code. (2) Two `runDue()` calls at once run a slow job once. (3) N=10 due jobs with a handler that waits on one shared promise: all 10 are running at the same time (count entered before releasing). (4) Lease expiry: worker A claims and hangs; the clock passes `claimed_until`; worker B runs the job; A then finishes: A's outcome is not written (fenced), `outbox.lease_lost` is logged, the row shows B's outcome. (5) Re-enqueue during a run -> exactly one more run, after, never concurrent. (6) Retry backoff, dead after 10, `{ retryInMs }`, revive: unchanged behaviour.

### Commit 2: the redemption request path stops holding a transaction across calls
- `runInline` (and any other place that takes the job row lock in a transaction and then calls `step`): claim the redemption's own job with `claimOne`, run the steps with no transaction open, `finish` with the outcome. If the claim is not available (the timer's worker has it), do not wait on a lock: return the current state of the redemption (the worker will finish it; the client polls). Remove `Slots` and the `new Slots(2)` limit entirely; if a bound on concurrent inline runs is still wanted, make it a plain counter from config (`INLINE_MAX`, default 32) that, when exceeded, skips the inline run and leaves the job to the outbox, never queues behind a lock.
- `confirm`, the rewards webhook and the admin resolve: re-read their lock-order comments. They used "job row, then redemption row" to avoid a deadlock with a running job. With leases there is no long-held job row lock any more: simplify to what is now true, keep the one guarantee that matters (a redemption becomes final exactly once: `confirm` acts only when status is `submitting`, under the redemption row lock, in a short transaction) and make sure the job is re-armed with `enqueue` in that same transaction (which, if a worker currently holds the claim, sets `rerun`). No transaction in src/store or src/admin or src/events may contain an `await` of a platform or ledger call: check by reading every `transaction(` call in those folders and list them in your report with what runs inside.
- The spin path (src/wheel): check the same rule; fix if it breaks it; say what you found.
- Tests: the existing store tests 1-21, admin test 8 and the wheel tests must pass and still mean what they say (test 21 raced the timer against the request through the row lock; rewrite it for the lease: the request and a `runDue()` started together result in one grant and one settle; and add: while the casino's answer is delayed with `slow_answer`, `pg_stat_activity` shows no session "idle in transaction"). Add: 40 redemptions for 40 players started at once on platform A all end "issued" with one grant each and no request waits behind another's platform call (assert the wall time is far below 40 x the slow answer delay by making the fake answer each grant after 200 ms: total must be under 2 s; use the real clock only for this wall-time assertion and say why).

### Commit 3: the pool
- `DB_POOL_MAX` env in src/config.ts (default 20) passed to `connect`; test/app.ts keeps its own value (add one line only if needed). One line in docker-compose.yml is NOT needed (default applies).
- Ledger: `ensure accounts exist` is a network round trip before every transfer. Remember in memory (a Set on the ledger object) which account ids this process has already seen created or existing, and skip the call for those. Test: the second prize for a player makes one ledger request, not two (count calls with a wrapper around the client in the test); a fresh process (new ledger object) still works when accounts exist.

## Docs
Rewrite the "Outbox" section of docs/contracts.md to describe the lease, the fence, `rerun`, concurrency and the rule in one bold line: no network call inside a database transaction. Update docs/failure-table.md rows that mention the row lock; add rows: "a worker dies while running a job" (lease expires, another worker runs it; test name) and "a slow worker finishes after its lease was taken over" (its result is not written; test name). Add at the end of docs/performance.md a short section "Change made after this measurement" stating what was changed and that the numbers above are from BEFORE it (do not edit the measured numbers; a new measurement will be added by someone else).

## Rules
- A failing test first for each commit; then the fix; `npm run verify` green before each commit. Never make a test pass with a sleep, a retry or a skip. `npx biome check --write src test` fixes formatting.
- Mutation checks (restore each; report which test caught it; fix the tests if one is not caught): (a) remove the token from the finish WHERE clause; (b) run the handler inside the claim transaction again; (c) clear a live claim on re-enqueue; (d) ignore `claimed_until` in the claim query; (e) make `confirm` act in any status.
- No `new Date()` / `Date.now()` in src for business time. Imports end in `.ts`; injected classes are plain imports, never `import type`. Plain English comments, short sentences. No new dependencies.
- Commit messages: "Found by measurement: ..." what was wrong, what the test shows, the fix, how it was checked. No tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md: append one row per commit at the end: `| HH:MM | what | who decided | how it was checked |`, time from `date +%H:%M`; "who decided": "Author (no network call inside a transaction); agent (lease with a fencing token)".

## Report back (read by a person who does not read the code; under 35 lines)
Branch and three commit hashes; total tests; for each commit what the failing test showed and what changed; the list of every `transaction(` in src/store, src/admin, src/events, src/wheel with what runs inside it; mutation check results; what the claim query's plan showed; anything that became riskier (be honest: e.g. two workers can now overlap if a handler outlives its lease; what protects the money then); what is not tested.
````

## Follow-up message 1, sent while the agent was working

````text
One more commit after your three (commit 4), from the owner: "workers must scale". With the lease, several worker processes can claim different jobs; make that a real deployment shape.
- Config: env `ROLE` = `all` (default: HTTP API and the outbox timer in one process, as today), `api` (HTTP API; the outbox TIMER is off; a request still runs its own job inline under the lease), `worker` (the outbox timer on; the HTTP server listens too but serves only `GET /health`: simplest is to keep the app as it is and just not treat it as a public entry; do not build route filtering, say in a comment that a worker is not published). Keep `OUTBOX_TIMER=off` working as before (tests use it). Also `OUTBOX_BATCH` (default 16) and `OUTBOX_POLL_MS` (default 500).
- docker-compose.yml: the `app` service gets `ROLE: api`; add a `worker` service from the same image with `ROLE: worker`, the same env as app (DATABASE_URL, TB_ADDRESS, FAKE_CASINO_URL, SEED_DEMO off for the worker, ADMIN_TOKEN_SECRET, the OTEL variables with `OTEL_SERVICE_NAME: gamification-worker`), `security_opt: ["seccomp=unconfined"]`, no published ports, a healthcheck on /health, depends on postgres and tigerbeetle healthy, and `deploy: { replicas: 2 }` so `docker compose up` starts two; `docker compose up --scale worker=4` must work (so: no `container_name`, no host ports on it). Another agent may add lines to the `app` service: keep your edit to that service to the single `ROLE` line.
- Only one process should run the schema and the demo seed at start without racing: the schema file is safe to run twice, but two processes running it at the same moment can collide on CREATE TABLE / CREATE TRIGGER. Wrap `migrate` in a PostgreSQL advisory lock (`pg_advisory_lock` on a fixed key, taken and released on one connection) and add a test that starts migrate from two connections at once on a fresh database without error.
- Test at the outbox level (no docker): three `Outbox` objects on the same database with a slow handler and 30 due jobs: every job runs exactly once, and at least two different workers ran jobs (record which object ran which); and the wall-clock-free assertion that the maximum number of handlers running at one time was greater than one worker's batch share would allow alone, or simpler: that jobs from all three workers overlapped in time.
- Docs: in the "Outbox" section of docs/contracts.md add "Workers scale by count" with the roles, and say plainly what was and was not run (you cannot run compose here: say "the compose file was not run by this change"; the main session will run it).
- docs/ai-log.md row: who decided = "Author (workers must scale); agent (roles and the compose shape)".
Do not let this delay commits 1-3: finish and commit those first.
````

## The agent's report

````text
The outbox and the redemption request no longer hold a transaction across casino or ledger calls. `npm run verify` is green on all four commits; the final count is 293 tests, up from 281.

Branch `worktree-agent-a9471ab3ef24a2ec2` has four commits and nothing is pushed or merged:

| # | Hash | Subject |
|---|---|---|
| 1 | 9db8826 | Outbox: lease, handlers run with no transaction, fenced finish |
| 2 | b7c080f | Redemption request path |
| 3 | 428a119 | Pool and ledger account cache |
| 4 | a2ac3eb | Roles, workers, schema advisory lock |

**What each failing test showed on the old code**
- **Commit 1:** during a handler there was 1 idle-in-transaction session and 1 lock on `outbox`. Ten due jobs never ran at the same time.
- **Commit 2:** one session was idle in a transaction while the casino delayed its answer. Forty redemptions with 200 ms answers took 5.3 s instead of under 2 s (the 2 s limit is a real-clock assertion, because the calls must overlap in real time).
- **Commit 3:** the second prize for a player made 2 create-accounts calls; it now makes 1.
- **Commit 4:** two processes applying the schema at once on a fresh database failed with a duplicate key in `pg_type`.

**What changed**
- **Lease and fence:** `claimed_until`, `claim_token` and `rerun` were added to `outbox`. A job is claimed in one statement, the handler runs with nothing open, and the outcome is written `WHERE claim_token = ours`. A lost lease writes nothing and logs `outbox.lease_lost`.
- **Re-enqueue during a run:** it sets `rerun` and gives exactly one more run, after the first.
- **Request path:** `runInline` uses `claimOne` and `finish`. If a worker holds the lease it returns the current state and never waits. `Slots` is gone; `INLINE_MAX` (default 32) skips the inline run when exceeded.
- **`confirm`:** it still acts only on `submitting`, under the redemption row lock, in one short transaction. Its lock-order comments are simplified.
- **Pool and ledger:** `DB_POOL_MAX` defaults to 20. The ledger remembers account ids it has seen.
- **Roles:** `ROLE` is `all`, `api` or `worker`, plus `OUTBOX_BATCH` and `OUTBOX_POLL_MS`. The schema runs under a PostgreSQL advisory lock. Compose has `app` as `ROLE: api` and a `worker` service with 2 replicas, no port and no container name.
- **Docs:** the Outbox section of `docs/contracts.md`, the failure-table rows, a closing section in `docs/performance.md` (measured numbers untouched) and one row per commit in `docs/ai-log.md`.

**Every `transaction(` in src/store, src/admin, src/events and src/wheel**
None contains a platform or ledger call.
- **store:**
  - `createRedemption`: insert row and enqueue.
  - `confirm`: status update, audit and enqueue.
  - `applyNotice` ignored-notice audit.
  - `observed` audit write.
  - pending `platform_ref` update.
  - `move` and `settle` status updates.
- **events:**
  - `rewards.controller` reject audit.
  - `events.controller` three event ingests (dedup and rows).
- **admin:** `login` ×2, `settings-change` ×2.
- **wheel (spin path):** the spin tx is update plus enqueue, the re-enqueue tx is enqueue only, and `creditSpin` calls the ledger outside any tx and then does a short update. No violation found there.

**Mutation checks**

| Mutation | Result |
|---|---|
| (a) no token in the finish WHERE | caught by the lease-expiry test |
| (b) handler run inside an open transaction | not caught cleanly (see "not tested") |
| (c) re-enqueue clears a live claim | caught by the re-enqueue test, which timed out at 60 s |
| (d) claim query ignores `claimed_until` | caught: 7 tests failed |
| (e) `confirm` acts in any status | caught by store test 13 and admin tests 7 and 8 |

**Claim query plan:** an Index Scan on `outbox_due` with an incremental sort on `id`, and the done, dead and claim columns as filters. This was seen with seqscan off on an empty table. It shows the index can be used, not that the planner picks it at size.

**Riskier now**
- A handler that outlives its lease (60 s default, against 2 s plus 2 s limits) lets two workers overlap on one job. What protects the money then:
  - ledger transfer ids are fixed, so repeats move nothing;
  - `findReward` runs before every grant;
  - `confirm` acts only on `submitting`.
- The fence stops the late worker from overwriting the outcome, but not from making its own calls.
- `rerun` is set whenever a claim token exists, including an expired claim, so a re-enqueue after a dead worker can cause one harmless extra run.
- Inline errors now go dead after 10 attempts, like timer runs; before, inline never marked a job dead.

**Not tested**
- The `INLINE_MAX` bound.
- Compose: it was parsed only, never run.
- Mutation (b) is not cleanly shown. The run hung on cleanup, so no assertion failure was reported. The idle-in-transaction test did fail on the old code, which is the same condition.
- Throughput was not re-measured, and nothing was tried on a real multi-process setup.
- `docs/architecture.md` still describes the old row-lock behaviour; I left it because the other agent owns that file.
- Six `/tmp/tb-*` directories remain. I could not tell which are mine, so I left them.
````
