# Brief 20: property and process tests

Wave 8. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
Repository: NestJS backend (`src/`), PostgreSQL + TigerBeetle, a fake casino process with scripted and seeded faults (`src/fake-casino/`), tests in `test/` (vitest). Read `CLAUDE.md` and `docs/verification.md` first (the verification approach this project follows), then `docs/contracts.md` sections "What must never happen", "Outbox", "Redemption", "Fake casino", and `docs/failure-table.md`. Do NOT read `CLAUDE.local.md` or `.private/`.

Two pieces of the verification approach were skipped and you add them. You own ONLY new files under `test/` (plus tiny additions to `test/app.ts`, `test/fake.ts`, `test/judge.ts`, `vitest.config.*`, `package.json` scripts if needed), rows in `docs/failure-table.md`, a short paragraph in `docs/verification.md` ("What of this is in the project": which pieces exist, with test file names, and which do not — the differential check is NOT built; say so), and rows in `docs/ai-log.md`. Do NOT change `src/` unless a test finds a real defect; if it does: keep the failing test, make the smallest fix, and put it in its OWN commit with the finding described. Other people are editing `src/tenants/`, `src/events/`, `src/integrations/`, `src/admin/`, `src/fake-casino/server.ts`, `web/` right now — stay out of those unless a defect forces it.

Read first how existing flow tests work: `test/store.test.ts` (flow tests of redemption with faults), `test/app.ts` (`startApp`, FakeClock, config overrides, how the outbox is driven: timer off, `drain`-style helpers), `test/fake.ts` (starting the fake casino, arming faults, chaos by seed via `/control/chaos`), `test/judge.ts` (the judge: reads only the casino's record and the ledger/our public API), `test/outbox.test.ts` (lease tests, three Outbox objects on one database), `test/signing.ts`.

## Piece 1: property test over random faults — `test/properties.test.ts`
`fast-check` is already a dependency. Property: for a generated scenario, after the system is given time to finish, **the judge finds no problems**, and every redemption is in a final state (issued or refused/insufficient), and no redemption is left `submitting` or `reserved` once faults are switched off and the outbox has been drained with the clock advanced.
- Generate: a small number of players (1–3) on each of the two demo tenants (platform A and platform B); per player a sequence of actions from {deposit, the same deposit again (duplicate), spin, two spins at once, redeem an item, the same redeem request again (same idempotency key if the API has one — check), two redeems at once}; and a fault plan: either a chaos seed + fault rate for the fake casino, or a list of scripted faults (point × fault kind × count) drawn from the faults the fake really supports (grant: error_500, rate_limit, refuse, lost_request, lost_answer, slow_answer; find: error_500; platform B callback: lost, twice, delay). Also generate "outbox ticks" between actions (run due jobs, advance the fake clock by a generated amount), so retries interleave with player actions.
- After the actions: switch all faults off, then loop "advance clock, drain outbox, deliver platform B results" until nothing is due (bounded number of rounds; exceeding the bound is a failure that prints the stuck rows).
- Then assert: judge verdict clean (no bonus issued twice, every issued redemption has exactly one bonus in the casino's record, refused ones have none, no negative balance, coins add up: prizes won − coins spent on issued redemptions = balance, nothing left reserved), using the existing judge; extend the judge only if a listed check is missing.
- Fixed seed by default so `npm run verify` is deterministic; number of runs from env `FC_RUNS` (default small enough that the file takes under ~40 s on a loaded machine — measure it); a failure must print the seed and the shrunk scenario; document in the file header how to replay (`FC_SEED=… FC_RUNS=…`). Add an npm script `test:deep` that runs this file with a random seed and more runs, and make sure it stays inside the vitest timeout (set the timeout explicitly for the file).
- No sleeps: use the FakeClock. If `slow_answer` needs real time in the fake, keep its delay tiny through whatever option the fake offers, or leave that fault out and say so.
- Mutation checks (required; restore after each, report what the test printed): (a) in `src/store/redemption.ts` skip the "look first" `findReward` before repeating `issueReward`, (b) make `confirm` act in any status, (c) make the release on refuse not happen. At least (a) must be caught by the property test via a lost_answer on platform B (platform A has an idempotency key, B has not — that is the point). If a mutation is NOT caught, say so plainly and strengthen the generator if it is cheap.

## Piece 2: real processes killed while they work — `test/processes.test.ts`
The app can run as separate roles: env `ROLE=api` or `ROLE=worker` (see `src/config.ts`, `src/main.ts`, the `worker` service in `docker-compose.yml`), with `OUTBOX_POLL_MS`, `OUTBOX_BATCH`, lease length setting (find its name). Workers claim outbox jobs with a lease and a claim token.
- The test starts REAL OS processes with `child_process.spawn`: one API and two workers (the same entry the Docker image runs, or `npx tsx src/main.ts` — pick what starts fastest and say which), all against the test's own PostgreSQL database (see `test/harness.ts` for how a test file gets a database URL) and the shared test TigerBeetle (see `test/global-setup.ts` / `test/tigerbeetle.ts` for the address), plus the fake casino (in-process via `test/fake.ts` is fine, it is the outside world). Real clock here; this is the one slow suite. Short lease (a few seconds) and short poll through env.
- Scenario A (kill a worker mid-job): arm `slow_answer` or a delayed platform B result so a redemption's job is in flight, create N redemptions through the API's HTTP endpoints (N around 10, both tenants), `SIGKILL` one worker while it holds claimed jobs (detect through the `outbox` table: `claim_token IS NOT NULL`), wait (poll the database with a deadline, no fixed sleeps) until every redemption is final, then run the judge: no bonus twice, coins add up, nothing reserved. Assert also that at least one job really was claimed by the killed worker at the moment of the kill (otherwise the test proves nothing) — e.g. give each worker a distinguishable id if the outbox records one, or compare claim tokens before and after.
- Scenario B (kill the API between the PostgreSQL decision and the ledger): if there is a cheap way to make the request path die after the redemption row and job are written but before the job runs (for example start the API with inline jobs off — look for the `inlineJobs` setting — create redemptions, SIGKILL the API at once), then the workers alone must finish them; judge clean. If not cheap, skip B and say so.
- Scenario C: three workers, 30 spins' prize credit jobs and redemptions, no kills: every job done exactly once (`attempts`/done rows), judge clean. Cheap sanity that separate processes do not double-run.
- Always kill child processes in `afterAll`/`finally` (also on test failure) and fail the test with the child's stderr tail if a child dies unexpectedly. Keep the whole file under ~60 s; exclude nothing from `npm run verify` unless it is too slow — if you must make it a separate script (`npm run test:processes`), say so in the report and in `docs/verification.md`, and add it to the CI workflow in `.github/workflows/` only if that is a one-line change.
- This machine's CPU has no AVX2: after `npm install` in your worktree run `./scripts/tb-old-cpu.sh`, and `export TB_BIN=<local-tigerbeetle-build>/tigerbeetle`. Child processes need the same patched `node_modules` (they will have it if started from your worktree). Disk is tight (about 10 GB free): do not start extra TigerBeetle servers beyond what the test setup already does, and remove any `/tmp/tb-*` you created.
- Mutation check: in `src/outbox/outbox.ts` make the claim query ignore `claimed_until` (so an in-flight job is taken by a second worker at once) — scenario C or A should still have a clean judge (money is protected by other rules) but "every job ran exactly once" must fail; report what happened. Second mutation: remove the token from the finish `WHERE` — report whether any process test notices.

## Rules
`npm run verify` green with NO skipped files at each commit. Write each test so that it can fail: show for each of the two files at least one mutation that makes it fail. Do not weaken an assertion to get green; if the system really misbehaves, that is a finding — stop, write it down with the seed or the steps, fix it in its own commit if the fix is small and clearly right, otherwise leave the test marked `test.fails`/skipped WITH the reason and report it at the top of your report.

## Commits
(1) property test, (2) process test, (3+) one commit per defect found. Messages describe the change and how it was checked; no tool names, no attribution or co-author lines. Each commit adds a row at the END of the table in `docs/ai-log.md`: `| HH:MM | what | Author (asked to return to the verification approach: property test and real-process kill test were skipped); agent (design of the tests) | how checked, incl. mutation results |`, time from `date +%H:%M`. Do not push.

## Report (short, plain, findings first)
Defects found (with seed/steps) or "none"; what each test covers; mutation results as a table; run time of each file; what is not covered.
````

## The agent's report

````text
Both pieces are in and `npm run verify` is green (307 tests, 52 s). The real-process test found a real defect, now fixed in its own commit. Nothing is pushed. `/tmp/tb-UXwdgt` is not mine and I left it.

## Defect found

**Starting a process under load deadlocked on the schema script.** `migrate` runs the whole `schema.sql` at every start. That script takes exclusive table locks (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) even when nothing changes. A worker started during traffic died with `deadlock detected` in `migrate`. A redemption request got a 500 in `Outbox.enqueue`. Scenario C failed in 6 of 11 runs before the fix.

- **Test first:** `test/migrate-under-load.test.ts` failed on the old code (`migrate` was still waiting after 3 s behind a transaction holding row-exclusive locks) and passes now.
- **Fix:** it is in `src/db.ts`. `migrate` now runs the script only when its hash differs from the one stored in a new `schema_state` table.
- **Result:** the whole process file passed 4 of 4 runs after the fix.
- **Not covered:** a deploy that changes the schema still takes those locks once. This is written in `docs/contracts.md`.

## Commits (local)

1. Property test.
2. The defect fix with its test.
3. Process test.
4. A docs line correcting the `test:deep` run count.

## One `src/` change you did not ask for

The lease length was fixed at 60 s and there was no setting for it. I added `OUTBOX_LEASE_MS` (default 60000) to `src/config.ts` and `src/outbox/outbox.module.ts`, a line in `docs/contracts.md`, and `outboxLeaseMs` in the `test/app.ts` config. `freshDb` in `test/harness.ts` now also returns the database URL.

## What each test covers

**`test/properties.test.ts`**
- The generator makes 1–3 players on each tenant and 3–16 steps. Steps are: deposit, the same deposit again, spin, two spins at once, redeem, the same key again, two redeems at once, and ticks that advance the clock, run jobs and deliver platform B callbacks.
- The fault plan is either seeded chaos (rate 0.1, 0.25 or 0.4) or a script drawn from the faults the fake really supports, weighted toward the B grant and callback faults.
- After the faults are cleared, the loop advances the clock, drains the outbox and delivers B results until nothing is open. The 65 s per round is fake-clock time; no test sleeps.
- It then asserts every redemption is final and settled, no job is dead, and the judge is clean.
- At the end of each run it sends a late contradicting platform B notice and asserts nothing changes.
- I did not extend the judge. It already had every check you listed.
- `slow_answer` is in the scripted plans with a 160 ms delay against a 100 ms platform limit. It is left out of chaos, which uses a fixed 5 s delay.

**`test/processes.test.ts`**
- It compiles the app with `tsc` into `node_modules/.cache/processes-dist` and runs `node main.js`, as the image does. I did not use `tsx`: it does not emit the decorator metadata Nest needs.
- Each child runs with a 3 s lease and a 50 ms poll.
- A: SIGKILL a worker that holds claimed jobs. In my runs 4 jobs were left claimed. Two new workers finish them, and the judge is clean.
- B: SIGKILL the API after the requests committed and before any job ran. Workers alone finish platform A. A restarted API on the same port takes the platform B callbacks.
- C: three workers, 30 spins and 30 redemptions, no kills. Every redemption has exactly one `issue` call, no job is dead, and no `outbox.lease_lost` is logged.
- D (extra): a handler that outlives its lease. The first worker is fenced out, and platform A still has one grant each.
- The outbox does not record who holds a claim. So in A the killed worker is the only one running while it claims, and the two that finish the work start after the kill. That is a weaker setup than "kill one of two running workers".
- Children are killed in `afterEach` and `afterAll`, and a child that dies on its own fails the test with its last 40 output lines.

## Mutation results

| Mutation | Result |
|---|---|
| (a) Skip `findReward` before every `issueReward` | Caught at run 4 (B referenced granted twice), with no B fault needed. |
| (a) Skip `findReward` only on a repeat with no platform reference (closest to your lost-answer case) | Caught at run 20, shrunk to a chaos plan. I did not craft a pure `b.grant:lost_answer` script. |
| (b) `confirm` acts in any status | Not caught in 200 random-seed runs, because the fake never contradicts itself. I added the late contradicting B notice at the end of each run, and it is now caught at run 4 (`issued -> refused`). |
| (c) No `release` on refuse | Caught at run 9 (available 900, expected 1000, 100 still reserved). |
| Outbox claim query ignores `claimed_until` | A, B and C all fail. In each the judge reports B references granted 2 or 3 times, so the money is not protected by other rules on B, which has no idempotency key. The "one `issue` call each" check in C was not the first to fire. |
| Outbox finish write without the token | A, B and C stay green. Only D fails (no `outbox.lease_lost`), and the existing unit test in `test/outbox.test.ts` also fails. |

## Run times

- `properties.test.ts`: 24–38 s for 60 runs (about 0.4 s per run). `npm run test:deep` (150 runs, random seed): 62 s.
- `processes.test.ts`: 39–42 s. It is part of `npm run verify`, so no separate script and no CI change.
- `migrate-under-load.test.ts`: 0.3 s.

## Not covered

- No differential check in general. `docs/verification.md` says so; only test 20 in `test/store.test.ts` does it, for a few named faults.
- Kills land wherever a claim shows in the `outbox` table, not at a chosen line.
- PostgreSQL and TigerBeetle are never killed, and nothing is tested with more than 3 workers.
- Replays of a property seed are close, not exact, because the order of concurrent HTTP calls is not seeded.

`scripts/tb-old-cpu.sh` picks the wrong default directory inside a worktree. I ran it with `TB_OLDCPU_DIR=<local-tigerbeetle-build>`.

The ai-log rows are at the end of `docs/ai-log.md`, and the test descriptions are in `docs/verification.md` and `docs/failure-table.md`.
````
