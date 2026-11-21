# Brief 01: ledger and outbox

Wave 1. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
You implement two pieces of a NestJS + PostgreSQL + TigerBeetle prototype: the coin ledger and the outbox. You work in your own git worktree on your own branch. Two other agents work in parallel on other files.

## Read first (in this order)
CLAUDE.md, docs/contracts.md (the binding contract; sections "Shape", "Ledger", "Outbox"), docs/verification.md, src/domain/coin-ledger.ts (the port you implement), src/schema.sql (table `outbox`), src/ledger/ledger.module.ts, src/clock.ts, src/clock.module.ts, src/config.ts, src/db.ts, test/app.ts, test/tigerbeetle.ts, test/tigerbeetle-smoke.test.ts, test/health.test.ts.

## Machine setup (do this first, exactly)
```
npm ci
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle     # in every shell that runs tests
npm run verify      # must be green before you change anything
```
This CPU has no AVX2; the official TigerBeetle binaries crash here (exit 132). The script swaps in a local build. Run it again after any npm install. Docker is running; tests start their own PostgreSQL. Do not stop any container you did not start.

## Files you own (create or edit only these)
- src/ledger/coin-ledger.tigerbeetle.ts (new): class `TigerBeetleCoinLedger implements CoinLedger`, a plain class without Nest decorators; constructor `(client: Client, timeoutMs: number)`.
- src/ledger/ledger.module.ts (edit): keep the LEDGER provider as is; add a provider for the token `COIN_LEDGER` (from src/domain/coin-ledger.ts) built from LEDGER and CONFIG.ledgerTimeoutMs; export it.
- src/outbox/outbox.ts (new): class `Outbox`, plain class; constructor `(db: Db, clock: Clock)`. Export the token `OUTBOX = Symbol("OUTBOX")` from it.
- src/outbox/outbox.module.ts (edit): make it `@Global()`, provide and export OUTBOX; when CONFIG.outboxTimer is true start a `setInterval` (500 ms) that calls `runDue()` and never lets a rejection escape (log it); clear the timer on shutdown. A run must not overlap the previous one.
- test/ledger.test.ts, test/outbox.test.ts (new).
- docs/ai-log.md: append ONE row at the end (see Rules).
Do not edit docs/contracts.md, src/schema.sql, src/domain/**, src/app.module.ts, test/app.ts, package.json, or anything else. No new npm dependencies. If the contract is wrong or impossible, stop and say so in your report; if you must deviate to continue, make the smallest deviation and list it under "DEVIATIONS".

## Ledger: details beyond the contract
- TigerBeetle version is 0.17.9. Its Node client differs from older documentation. Do NOT trust memory of the API: read `node_modules/tigerbeetle-node/dist/*.d.ts` and the working examples `test/tigerbeetle-smoke.test.ts` and `<path outside the repository>` (read-only reference outside the repo). Facts verified on this version: createTransfers/createAccounts return one result per item with a status; a repeated transfer id with the same content reports "exists"; a transfer that failed with "exceeds_credits" burns its id (the same id later reports "id_already_failed" even if the balance now allows it).
- Ids: first 16 bytes of SHA-256 (node:crypto) of the strings in the contract, read as an unsigned 128-bit BigInt. If the result is 0 or 2^128-1, that is impossible in practice; throw.
- `creditPrize`: make sure the issuer and the player account exist (createAccounts; "exists" is success), then one posted transfer issuer -> player, code 1, `user_data_128` unused. "exists" = success. Anything else throws an Error that names the status.
- `reserve`: make sure player and `redeemed` accounts exist, then a pending transfer player -> redeemed, timeout 0. Return "reserved" for created or exists; "insufficient" for exceeds_credits or id_already_failed; throw for anything else.
- `capture`: post_pending_transfer with id `xfer:capture:<redemptionId>`, pending_id = the reserve id, amount = full amount (check in the typings how 0.17.9 expresses "the whole pending amount"; verify by test that the full amount is posted). Created, exists, or "pending transfer already posted" = success. If the pending transfer was already voided, throw `LedgerConflict` (export this class from your file).
- `release`: void_pending_transfer with id `xfer:release:<redemptionId>`. Created, exists or "already voided" = success; already posted -> `LedgerConflict`.
- `balance` and `outstanding` as in the contract; an account that does not exist yet has balance 0.
- Time limit: every public method races the client call against `timeoutMs` and throws `LedgerUnavailable` (from src/domain/coin-ledger.ts). Say in a comment that the client call itself is not cancelled and that this is safe because every id is deterministic.
- Amounts are bigint, must be > 0; throw on 0 or negative.

## Ledger tests (test/ledger.test.ts) - against a real TigerBeetle, no mocks
Use `startTigerBeetle()` from test/tigerbeetle.ts and `createClient` directly (skip the file when it returns undefined, like the smoke test). In CI all test files share ONE TigerBeetle server, so every test must use a fresh random `ledgerNo` (e.g. a random integer between 1000 and 2^31-1) and `randomUUID()` for player, spin and redemption ids. Cover at least:
1. creditPrize twice with the same spinId credits once.
2. reserve more than the balance -> "insufficient", balance unchanged; the same redemptionId again after a top-up is still "insufficient".
3. 20 concurrent reserves of 100 coins (different redemption ids) against a balance of 500: exactly 5 "reserved", 15 "insufficient", available 0, reserved 500.
4. The same reserve called 5 times concurrently reserves once.
5. capture: available unchanged after reserve, reserved goes to 0, total spent grows; capture twice is fine.
6. release: coins are available again; release twice is fine; capture after release throws LedgerConflict; release after capture throws LedgerConflict.
7. outstanding = issued minus captured, for a tenant with two players.
8. Two tenants (two ledgerNo) with the SAME playerId string have separate balances.
9. A client pointed at a dead address (e.g. 127.0.0.1:1) with timeoutMs 300 throws LedgerUnavailable within about a second. Destroy that client afterwards.

## Outbox: details beyond the contract
- `enqueue(tx, job)` takes a `pg.PoolClient` in a transaction. `INSERT ... ON CONFLICT (kind, ref_id) DO UPDATE SET run_at = <now or runAt>, done_at = NULL, dead_at = NULL, attempts = 0` — re-arming a finished job is allowed and intended.
- `runDue()`: loop: in a transaction claim ONE due job (`SELECT ... FROM outbox WHERE done_at IS NULL AND dead_at IS NULL AND run_at <= $now ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`), run its handler while holding the row lock, then write the result (done_at; or run_at = now + delay, attempts+1, last_error; or dead_at after the 10th failed attempt) and commit. Stop when no job is due. Return how many ran. `now` comes from the Clock, never from PostgreSQL `now()`. A kind without a handler counts as a failure with last_error "no handler for <kind>". Check with EXPLAIN in a test or by hand that the claim query can use the index `outbox_due`; say in your report what you saw (do not claim a speed you did not measure).
- A handler result `{ retryInMs }` reschedules without counting towards the 10 attempts limit? No: it increments `attempts` too, but never marks the job dead (a platform may stay "pending" for a long time). Only thrown errors lead to `dead_at`.
- `drain(maxRounds)`: call runDue until it returns 0.

## Outbox tests (test/outbox.test.ts)
Use `freshDb()` from test/harness.ts and a `FakeClock`; build `new Outbox(db, clock)` directly. Insert one row into `tenants` by plain SQL for the foreign key. Cover: enqueue twice = one row; a job not yet due does not run until the clock is advanced; a throwing handler is retried after 1 s, 2 s, 4 s (advance the clock, assert it does not run earlier); dead after 10 throws and no longer runs; `{ retryInMs }` reschedules and never goes dead; two `runDue()` calls started at the same moment run a slow handler exactly once (the handler awaits a promise the test resolves); re-enqueue of a done job makes it run again; no handler -> failure recorded.

## Rules
- `npm run verify` (typecheck, biome, all tests) must pass before you commit. Never make a test pass with a sleep, a retry or a skip. `npx biome check --write src test` fixes formatting.
- Mutation check before you finish: (a) remove the flag `debits_must_not_exceed_credits`, confirm a ledger test fails, restore; (b) remove `SKIP LOCKED` or the row lock from the claim, confirm an outbox test fails, restore. Report which test caught each. If a mutation is NOT caught, add or fix a test until it is.
- Imports use `.ts` extensions. Injected classes must be plain imports, never `import type`. Plain English comments, short sentences. No `new Date()` / `Date.now()` in src outside clock.ts.
- Commit on your branch when green (one or two commits). Message: what changed and how it was checked; no tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md row, appended at the end, same commit: `| HH:MM | what | Agent | how it was checked |` with the time from `date +%H:%M`, naming the test files and the two mutation checks.

## Report back (this is read by a person who does not read the code)
Keep it under 40 lines: branch name and commit hash; for the ledger and for the outbox three lines each: what it does, what can break, which test catches it; results of the two mutation checks; what you saw about the claim query and the index; DEVIATIONS from the contract (or "none"); anything that surprised you about TigerBeetle 0.17.9; what is not tested.
````

## The agent's report

````text
Both pieces are done and committed. `npm run verify` passes (26 tests) and both mutation checks were caught.

Branch `worktree-agent-a6cba7318fcbdd4f4`, commit `95001e1`. I did not push or merge.

**Ledger** (`src/ledger/coin-ledger.tigerbeetle.ts`, wired as `COIN_LEDGER` in `ledger.module.ts`)
- **What it does:** it implements the contract, with ids from SHA-256, `reserve` as a pending transfer, `capture` posting the full amount (`amount_max`), `release` voiding it, and a time limit on every call.
- **What can break:** a capture after a release (or the reverse) throws `LedgerConflict`. An unreachable ledger throws `LedgerUnavailable`. Zero or negative amounts are rejected.
- **Tests:** `test/ledger.test.ts` has 13 tests against a real TigerBeetle. They cover double credit, 20 concurrent reserves against a balance of 500 (exactly 5 reserved), the "insufficient" result sticking to its redemption id after a top-up, the conflicts, two tenants with the same player id, and a dead address.

**Outbox** (`src/outbox/outbox.ts`, `outbox.module.ts` is now `@Global()` and exports `OUTBOX`)
- **What it does:** it implements the contract, with the handler running under the row lock. Failures back off 1 s, 2 s, 4 s up to 60 s. A job goes dead after the 10th thrown error. A handler's `{ retryInMs }` reschedules without ever marking the job dead. The 500 ms timer skips a tick if the previous run is still going and logs rejections.
- **What can break:** a crash mid-handler releases the lock, so the job runs again. Handlers must be safe to repeat. A kind with no handler records "no handler for <kind>".
- **Tests:** `test/outbox.test.ts` has 10 tests with a fake clock and a fresh database per test. They cover the retry delays, dead after 10, `retryInMs`, re-arming a finished job, `drain`, the missing handler, and two concurrent `runDue` calls running a slow handler once.

**Mutation checks**
- **(a) Flag removed:** `debits_must_not_exceed_credits` removed from the player account. Three ledger tests failed: the insufficient/top-up test, the 20-concurrent-reserves test, and the two-tenants test.
- **(b1) `SKIP LOCKED` removed:** the "two runDue calls" test failed. The second call waits on the lock, so I added a 2 s watchdog flag to make that fail instead of hang.
- **(b2) Row lock removed:** the same test failed, with the second call running the job (`expected 1 to be +0`).

**Claim query and index:** `EXPLAIN` showed `Index Scan using outbox_due`, plus an Incremental Sort on `run_at, id`. I had to run it with `enable_seqscan=off`, because the planner picks by table size and the test table is tiny. I measured no speed.

**DEVIATIONS from the contract:** none.

**TigerBeetle 0.17.9:**
- **Typings:** the typings match the notes you gave me, and the full-amount post worked on the first try.
- **Late failures:** the client call is not cancelled when the time limit wins. I attach a no-op catch to it so a late failure doesn't become an unhandled rejection.
- **Mutation (a) result:** without the flag, the 20-concurrent test went over the balance, so the ledger's own check does the protecting.

**Not tested:**
- **Ledger:** real recovery after a crash between PostgreSQL and TigerBeetle (that needs the flow tests), and the `exists_with_different_*` statuses (they throw, but no test forces them).
- **Outbox:** the app timer (`outboxTimer` is false in `test/app.ts`), a process kill mid-handler, and `kind` with no tenant row (the foreign key just fails the insert).
- **Permissions:** for a hang that vitest could not break out of, I killed a background test run. No containers were stopped.

The `ai-log.md` row is appended at 12:02.
````
