# Brief 09: structured logging

Wave 4. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
You add structured logging to a working NestJS + PostgreSQL + TigerBeetle prototype (a gamification service for casino operators: deposit event from a casino platform -> wheel spin -> coins -> redemption in a bonus store -> the platform issues the reward; admin endpoints and alerts exist). It has 200 passing tests. You work in your own git worktree on your own branch. Another agent is building a React frontend in parallel and edits web/**, src/web.ts, src/main.ts, src/config.ts, test/app.ts (a few lines), Dockerfile, package.json, docker-compose.yml, CI: avoid those files, except the minimal lines in test/app.ts described below.

## Decisions the product owner made (build exactly this)
- Services log correctly and LITTLE. A daily digest agent reads the logs (see docs/monitoring-playbook.md), so each line must be worth reading and machine-readable.
- A duplicate event is not an audit entry (the audit trail records changes, and a duplicate changes nothing; idempotency already makes it harmless). That a duplicate arrived is a log line.
- How verbose the logs are for a tenant is set by policy: a field of the tenant's versioned ops policy.

## Read first
CLAUDE.md, docs/contracts.md, docs/monitoring-playbook.md (find where it calls duplicates a blind spot), src/alerts/ops-policy.ts (params, validator, loader), src/tenants/demo-tenants.ts and seed.ts, src/events/* , src/wheel/*, src/store/* (store.service.ts, redemption.ts), src/integrations/http.ts and the two adapters, src/outbox/*, src/admin/*, src/ledger/coin-ledger.tigerbeetle.ts, src/clock.module.ts, src/app.module.ts, test/app.ts, test/store.test.ts and test/intake.test.ts (style and helpers).

## Machine setup (first, exactly)
```
npm ci
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle     # in every shell that runs tests
npm run verify      # must be green (200 tests) before you change anything
```
The CPU has no AVX2; the script swaps in a local TigerBeetle build. Docker is running. Do not stop containers you did not start; do not run docker compose (the owner's stack is running on the default ports).

## What to build
1. `src/logging/log.ts` (plain, no Nest): 
   - `type Level = "error" | "warn" | "info" | "debug"`.
   - `interface LogSink { write(line: string): void }` with a stdout sink and, for tests, a memory sink.
   - `class Log { constructor(sink, clock, levelFor: (tenantId: string | null) => Level) ; event(level, name, fields: { tenantId?: string | null; requestId?: string; [k: string]: unknown }): void }`. One JSON object per line: `{ "at": ISO from the clock, "level", "event": name, "tenantId", "requestId", ...fields }`. A line is written only when `level` is at or above the level for that tenant. bigint values are written as strings. A value that cannot be serialised must never throw out of `event` (catch, write a minimal line that says so).
   - A redaction step applied to every line: any field whose key matches `/secret|token|signature|authorization|key|password/i` is written as "***" (exception: the key `idempotencyKey` is allowed? No: keep it simple, redact it too and log a short hash of it under `idempotencyKeyHash` where it is useful). Request and response BODIES are never logged at info; at debug a body may be logged only after the same redaction is applied recursively.
2. `src/logging/log.module.ts`: `@Global()`, token `LOG`. The level for a tenant comes from the tenant's newest ops policy: add `logLevel: "info" | "debug"` to the ops policy params (validator: optional, default "info"; demo version 1 keeps "info" - if adding a field to the seeded version breaks the "seed twice writes nothing" test, handle the default in the loader instead of the seed). Cache the level per tenant in memory for 30 s by the injected clock so logging does not query the database per line; lines without a tenant use "info". The cache refresh must not make `event` async: `event` reads the cache synchronously and triggers a background refresh when the entry is stale (errors in the refresh are swallowed and keep the old value).
3. Request id: one small Nest middleware (`src/logging/request-id.ts`) that takes `x-request-id` (validated: `[A-Za-z0-9._-]{1,64}`) or makes a uuid, puts it in an `AsyncLocalStorage`, and sets the `x-request-id` response header. `Log.event` fills `requestId` from the store when the caller did not pass one. Outbox jobs have no request: they run with `requestId` = `job:<kind>:<refId>` (set it around the handler call in the place where handlers are invoked, if that can be done in one spot in src/outbox/outbox.ts without changing behaviour; otherwise pass it explicitly from the handlers).
4. The events, and ONLY these (few lines, each useful to someone reading at 3 a.m. or to the digest agent). Use exactly these names:
   - info `event.accepted` { externalEventId, kind, spinsGranted }, info `event.duplicate` { externalEventId }, debug `event.ignored` { externalEventId, why }, warn `webhook.rejected` { reason, bytes }, warn `webhook.invalid` { reason }.
   - info `spin.used` { spinId, playerId, coins }, debug `spin.credited` { spinId }, warn `spin.credit_deferred` { spinId, error } (ledger unavailable at spin time).
   - info `redemption.created` { redemptionId, playerId, costCoins }, info `redemption.status` { redemptionId, from, to, reason? } on every status change and on settle (`to: "settled"`), warn `redemption.contradicted` { redemptionId, final, late }.
   - info `platform.call` { redemptionId, call: "issue" | "find", outcome, ms } for a call that answered, warn `platform.unreachable` { redemptionId, call, error, retryInMs, ms } for one that did not. `ms` from the injected clock (it will be 0 under the fake clock; that is fine).
   - debug `outbox.retry` { kind, refId, attempts, retryInMs, error? }, error `outbox.dead` { kind, refId, attempts, lastError }.
   - warn `admin.manual_resolution` { redemptionId, outcome, admin }.
   - warn `ledger.unavailable` { op } where a ledger call timed out.
   - error `unhandled` { error } from one global exception filter for non-HTTP exceptions (keep Nest's normal HTTP error responses as they are).
   Replace the existing ad-hoc `new Logger(...)` lines in src/outbox, src/store and src/admin with these events where they overlap; do not leave two logs for one fact. Plain domain files stay free of Nest: pass `log` in through the deps objects they already take (e.g. `StoreDeps`), as an optional field where adding a required one would force edits in files you do not own.
5. test/app.ts (minimal): override `LOG`'s sink with a memory sink and expose it as `running.logs` (an array of parsed lines, plus `running.logs.length = 0` to clear). Keep every existing field and option untouched; add at most ~10 lines.
6. docs/monitoring-playbook.md: replace the "blind spot" note about duplicates with a check that reads `event.duplicate` lines per tenant per hour as a share of `event.accepted` + `event.duplicate`, and add a short section "Logs" listing the event names above with one line each and saying that `logLevel` is per tenant in the ops policy. docs/contracts.md: add a short section "Logs" (the line shape, the event names, the redaction rule, the policy field). docs/failure-table.md: nothing unless you test a new failure.

## Tests (test/logging.test.ts; whole app over real HTTP with `startApp`, `seedDemo`, the fake casino via test/fake.ts, as the other test files do)
1. A deposit then the same deposit again: exactly one `event.accepted` and one `event.duplicate`, both with the tenant id and the same request id as the HTTP response header of their request.
2. A full flow on platform A and on platform B (deposit, spin, redeem, deliver B's answer): the expected info events appear in order for the redemption (`redemption.created`, the status changes, `platform.call`, settled), each line parses as JSON and has at, level, event, tenantId, requestId.
3. Policy-defined verbosity: with the seeded policy (info) no debug line is written for either tenant during a flow; after inserting ops policy version 2 with `logLevel: "debug"` for alpha only and advancing the clock past the cache time, alpha's flow writes debug lines (`spin.credited`, `event.ignored` for an ignored event) and beta's still writes none.
4. Nothing secret, ever: run flows on both tenants including a bad-signature webhook, a refused reward, a lost answer with recovery, and an admin resolution, with alpha at debug; then scan EVERY captured line (the raw string) for each demo secret from src/tenants/demo-tenants.ts (webhook secrets, token secrets, wheel secrets, admin keys, platform keys), for any `Bearer ` token, and for the signatures sent; none may appear.
5. A lost answer with recovery writes `platform.unreachable` then `platform.call` with outcome issued, and `outbox.dead` is written when a job dies (drive a job to 10 failures with a throwing handler).
6. Unit tests of `Log`: level filtering, redaction (nested), bigint, an unserialisable value does not throw, a line is exactly one line (a newline inside a string field is escaped).
7. A supplied `x-request-id` is echoed and used; an invalid one is replaced.
The existing 200 tests must stay green; if an existing test asserts on console output or on the removed Logger lines, say so.

## Rules
- `npm run verify` must pass before you commit. Never make a test pass with a sleep, a retry or a skip. `npx biome check --write src test` fixes formatting.
- Mutation checks before you finish; restore each; report which test caught it; fix the tests if one is not caught: (a) remove the redaction; (b) make every tenant "debug"; (c) drop the `event.duplicate` line; (d) drop the tenant id from lines.
- No `new Date()` / `Date.now()` in src. Imports end in `.ts`; injected classes are plain imports, never `import type`. Plain English comments, short sentences. Logging must never change behaviour or throw into business code.
- Commit on your branch when green, in two commits (the logger with request id and policy-defined level; the events wired in, with tests and docs). Message: what changed and how it was checked; no tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md: append one row per commit at the end: `| HH:MM | what | who decided | how it was checked |`, time from `date +%H:%M`; "who decided": "Author (log little and correctly, duplicates are log lines, verbosity by policy); agent (the event list and the shape)".

## Report back (read by a person who does not read the code; under 35 lines)
Branch and commit hashes; what a log line looks like (two real examples copied from a test run); the full list of events as built; mutation check results; how many lines one happy-path redemption writes at info and at debug (counted, not estimated); anything you found in existing code while wiring; DEVIATIONS; what is not tested.
````

## The agent's report

````text
Both commits are on `worktree-agent-ad169fd9492b3be56` and nothing is pushed or merged. The final run is 220 tests green, 200 old and 20 new (typecheck and lint pass). I ran the tests with 3 workers instead of plain `npm run verify`, because the disk was nearly full.

**Commits**
- `4aaa89c`: the logger, request id middleware, and per-tenant level from the ops policy.
- `0e1daae`: the 18 events wired in, `test/logging.test.ts`, docs, and the `docs/ai-log.md` rows.

**Line shape** (copied from a test run)
```
{"at":"2026-11-21T08:05:59.144Z","level":"info","event":"event.accepted","tenantId":"alpha-casino","requestId":"b888f800-92ba-4cc2-ba8d-b315086a7bbc","externalEventId":"evt-count-a","kind":"deposit_succeeded","spinsGranted":1}
{"at":"2026-11-21T08:05:59.144Z","level":"info","event":"platform.call","tenantId":"alpha-casino","requestId":"6d759cb9-97bb-4006-8a6b-fb231a7aff84","redemptionId":"a000dc61-1bb0-48fa-a64f-e6467773eab8","call":"issue","outcome":"issued","ms":0}
```

**Events built:** `event.accepted`, `event.duplicate`, `event.ignored` (debug), `webhook.rejected`, `webhook.invalid`, `spin.used`, `spin.credited` (debug), `spin.credit_deferred`, `redemption.created`, `redemption.status`, `redemption.contradicted`, `platform.call`, `platform.unreachable`, `outbox.retry` (debug), `outbox.dead`, `admin.manual_resolution`, `ledger.unavailable`, `unhandled`.

**Line counts** (counted in test 8):
- A happy deposit, spin and redeem writes 9 lines at info, 7 of them about the redemption.
- The same flow at debug writes 10; the only extra line is `spin.credited`.
- Beta, with the callback delivered, writes 9.

**Mutation checks** (each reverted, and each caught):
- (a) No redaction: two unit tests fail (nested redaction, bearer cut). The HTTP secret scan does not catch it, because no real event carries a secret-looking field. The unit tests are what cover it.
- (b) Every tenant at debug: tests 3 and 8.
- (c) No `event.duplicate` line: test 1.
- (d) No tenant id in lines: 8 tests.

**Tests:** test 4 scans every raw line against all demo secrets, the signatures and tokens the tests sent, and `Bearer`, and finds none.

**Found in existing code**
- The webhook controllers, the player guard and the wheel controller each made their own request id, so audit rows and logs would not have matched. They now read it from the middleware.
- An invalid `x-request-id` header is now replaced in audit rows too, where before it was stored as sent.
- `npm run verify` runs 14 test files in parallel, and each starts a TigerBeetle with a 1.1 GB data file, so it needs about 15 GB free disk. Failed runs left `/tmp/tb-*` directories behind. I deleted only the ones no process was using. The `--poolOptions.forks.maxForks=3` flag worked for the test run.

**DEVIATIONS**
- `test/app.ts` grew by about 20 lines, not 10. It adds `logs`, `rawLogs` and `levels` (the per-tenant level cache; tests call `levels.settled()`). The sink is overridden through a `LOG_SINK` token, not through `LOG`.
- `logLevel` appears in the validated params only when given. Adding a default to the output broke an existing `toEqual` in the alerts test, and the seed did not need to change.
- `ledger.unavailable` has no tenant id, because the ledger only knows the ledger number.
- Three swallowed errors (outbox timer tick, inline run, admin settle) now log as `unhandled` with an extra `where` field, so no fact has two logs.
- `unhandled` carries no tenant id.
- The first line for a tenant, and the first after the 30 s cache expires, still use the old level.
- The new exception filter answers HTTP errors the way Nest does, and Nest's own stderr log for non-HTTP errors is gone.
- Request ids on `outbox.retry` and `outbox.dead` are passed explicitly, because those lines are written after the handler returns.

**Not tested:** `webhook.invalid`, `redemption.contradicted`, `spin.credit_deferred`, `ledger.unavailable`, `unhandled` and the exception filter, and logging for a failing level-cache refresh.
````
