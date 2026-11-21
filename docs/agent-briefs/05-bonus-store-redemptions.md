# Brief 05: bonus store redemptions

Wave 2. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
You implement the Bonus Store of a NestJS + PostgreSQL + TigerBeetle prototype: a player redeems coins for a reward, we ask the casino platform to issue it, and the final status is tracked. This is the financially sensitive part: a reward must never be issued twice, coins must never be taken without a reward, a balance must never go below zero. You work in your own git worktree on your own branch. Another agent works in parallel on the wheel (src/wheel, src/policies, src/events/deposit.ts, src/tenants, src/schema.sql, test/wheel.test.ts); do not touch those.

## Read first
CLAUDE.md, docs/contracts.md (binding; all of it, especially "What must never happen", "Shape", "Actors and audit", "Outbox", "Our HTTP API", "Redemption: one intent, two steps", "Platform A", "Platform B", "Fake casino"), docs/verification.md (the judge, the fake world, "lost answer"), src/schema.sql (store_items, redemptions, outbox), src/domain/casino-platform.ts and src/domain/coin-ledger.ts (the ports), src/audit/audited.ts, src/outbox/outbox.ts and outbox.module.ts, src/ledger/coin-ledger.tigerbeetle.ts (to know what throws what), src/integrations/* (platform-a.ts, platform-b.ts, platforms.ts, hmac.ts), src/events/* (how the events webhook is done), src/tenants/* (guard, `@CurrentPlayer()`, tenants.ts, seed.ts), src/config.ts, src/clock.module.ts, test/app.ts, test/fake.ts, test/signing.ts, test/intake.test.ts (the style to follow), src/fake-casino/* (the control API and the faults; read server.ts and the fault code carefully, you will drive it from tests).

## Machine setup (first, exactly)
```
npm ci
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle     # in every shell that runs tests
npm run verify      # must be green (75 tests) before you change anything
```
The CPU has no AVX2; the script swaps in a local TigerBeetle build. Run it again after any npm install. Docker is running. Do not stop containers you did not start.

## Recipes from the agents before you
- Player endpoint: `@UseGuards(PlayerAuthGuard)` and `@CurrentPlayer() auth: PlayerAuth`; `auth.tenant.id`, `auth.player.id` come from the token. The controller's module imports `TenantsModule`.
- Row change with audit: inside `transaction(db, tx => ...)` call `update(tx, { tenantId, actor, requestId, now: clock.now() }, "redemptions", id, cur => cur.status === "created" ? { ... } : null)`. A null result means the state had already moved on. `create(tx, ctx, table, row, { onConflict: "nothing" })` returns null when the unique key already existed. Columns are snake_case; bigint columns come back as strings.
- Tokens: `@Inject(DB)`, `@Inject(CLOCK)`, `@Inject(COIN_LEDGER)`, `@Inject(OUTBOX)`, `@Inject(PLATFORMS)`, `@Inject(CONFIG)`. Injected classes are plain imports, never `import type`. Imports end in `.ts`.
- In CI all test files share ONE TigerBeetle server and the demo tenants use fixed ledger numbers 1 and 2. Tests must never assert an absolute tenant-wide ledger total, and must use a fresh external player id per test (e.g. `p-` + randomUUID()); per-player balances are then exact.

## Files you own (create or edit only these)
- src/store/**: `redemption.ts` (plain domain: the state machine `advance`, `confirm`, and the types), `store.service.ts` if you need a thin Nest wrapper, `store.controller.ts`, `store.module.ts`.
- src/integrations/platform-a.ts and platform-b.ts: fill in `issueReward` and `findReward` (they throw "not implemented yet" now). src/integrations/http.ts (new): one small function for outgoing calls with a time limit that really cancels (`AbortController`), used by both adapters. Do not change the inbound parsing.
- src/events/rewards.controller.ts (new: `POST /webhooks/:tenantId/rewards`) and src/events/events.module.ts (only to register it).
- test/store.test.ts, test/judge.ts (new).
- docs/failure-table.md (new, see below), docs/ai-log.md (append rows, see Rules).
Do not edit docs/contracts.md, src/schema.sql, src/domain/**, src/audit/**, src/outbox/**, src/ledger/**, src/tenants/**, src/wheel/**, src/events/deposit.ts, src/events/events.controller.ts, src/fake-casino/**, test/app.ts, package.json. No new npm dependencies (use the global `fetch`). If the contract is wrong or incomplete, do not edit it: take the smallest sensible reading and list it under DEVIATIONS. If the fake casino has a bug that blocks you, do not fix it: work around it in the test if you can and report it precisely.

## Behaviour (the contract's state machine is binding; details it leaves open)
- `GET /store/items` (guarded): active items of the token's tenant.
- `POST /store/redemptions` (guarded): header `Idempotency-Key` required (non-empty, at most 200 chars), body `{ itemId }`. Item must be active and belong to the token's tenant, else 404. In one transaction: `create` the redemption with `onConflict: "nothing"` (status "created", cost_coins and reward copied from the item, created_at/updated_at from the clock) and, only if created, `outbox.enqueue(tx, { tenantId, kind: "redemption_advance", refId })`. If it already existed (same tenant, player, key): load it and return it with 200, change nothing, even if the body names another item. If created: after commit, when `config.inlineJobs` is true, call `advance` in a loop while it reports progress and the redemption is not waiting on the platform (at most 5 steps), swallowing `LedgerUnavailable`/`PlatformUnreachable`; then return 201 with the current state. The request must not hang longer than the platform time limit plus a little.
- `GET /store/redemptions/:id` (guarded): only this player's, else 404. Shape for both: `{ id, status, costCoins, reward, reason, platformRef, settled }` (`costCoins` as a string, `settled` boolean).
- `advance(redemptionId)` returns "done" (nothing more to do, ever), "again" (made progress; call again now) or `{ retryInMs }`. The outbox handler `redemption_advance` maps "again" to `{ retryInMs: 0 }`. One step per call, as in the contract's table:
  - created: `coins.reserve` -> `update` to "reserved", or to "insufficient" (final; return "done"). The ledger call happens BEFORE the status update; a crash in between repeats the reserve with the same id, which is harmless.
  - reserved: `update` to "submitting" and commit; return "again". Nothing else in this step.
  - submitting: `findReward` FIRST, always. issued/refused -> `confirm`. pending -> store platform_ref if new, return `{ retryInMs }` (2 s). "not_found" -> `issueReward`; a final answer -> `confirm`; pending -> store platform_ref, `{ retryInMs: 2000 }`. `PlatformUnreachable` from either call -> `{ retryInMs: e.retryAfterMs ?? backoff }` where backoff grows with `job.attempts` (1 s, 2 s, 4 s ... cap 60 s). Never mark the redemption failed because the platform is unreachable: its outcome is unknown, and that is a visible state ("submitting").
  - issued and settled_at null: `coins.capture`, then `update` settled_at. refused and settled_at null: `coins.release`, then `update` settled_at. Then "done".
  - insufficient, or settled: "done".
- `confirm(redemptionId, outcome, actor)`: one transaction: `update` with a `change` that acts only when status is "submitting": issued -> status "issued", platform_ref; refused -> status "refused", reason. Then `outbox.enqueue` (re-arms the job, so the ledger settles soon). When the status is already final it changes nothing and returns the current row (a second webhook, or webhook plus lookup). A notice for a redemption that is still "created" or "reserved" cannot be real (we have not called the platform yet): ignore it and `record` it (action "reward_notice_ignored").
- `POST /webhooks/:tenantId/rewards`: like the events webhook: unknown tenant 404; `req.rawBody`; adapter `parseRewardNotice`; InvalidSignature -> 401 + audit record "webhook_rejected"; InvalidPayload -> 400; NotSupported (platform A) -> 400. The redemption must belong to the tenant in the path, else 404 and nothing changes (tenant isolation). Then `confirm` with actor `platform/<tenantId>`, and when `config.inlineJobs` run `advance` once to settle. Answer 200 `{ redemptionId, status }`.
- Adapters, outbound: exactly the wire formats in the contract. Map every answer the contract lists; anything else (unexpected status, unparseable body) is `PlatformUnreachable` with a message that names the status, never "refused" (an unknown answer must not release coins... it must not capture them either). 429 with `Retry-After: n` -> `retryAfterMs: n * 1000`. Platform A sends `Idempotency-Key: <redemptionId>`. Platform B `findReward` with several requests for one ref: GRANTED wins over ACCEPTED wins over DECLINED (and say in a comment why: a duplicate must not hide a real grant). Amounts for B: minor units to a decimal string without floating point.
- Every outgoing call is audited with `record` (action "platform_call", entityType "redemption", entityId, changes `{ call: "issue" | "find", outcome | error }`, actor `system/outbox` or the caller's), in its own small transaction after the call returns or fails.
- Player ids: the ledger uses our player uuid; the platform gets `players.external_id`.

## The judge (test/judge.ts)
`judge(input: { fakeState, redemptions: [{ id, tenantId, externalPlayerId, status, settled, costCoins }], balances: [{ tenantId, externalPlayerId, creditedCoins: bigint, available: bigint, reserved: bigint }] }): string[]` returns a list of violations in plain words, empty when all is well. It trusts the fake casino's `/control/state` and the ledger balances, and uses our redemption rows only to know what we CLAIM. Rules: more than one grant in the fake for one reference; a grant in the fake for a redemption we show as refused/insufficient; a redemption we show as issued with no grant in the fake; a grant whose tenant or player differs from the redemption's; any balance below zero; for each player with all redemptions settled: `available == credited - sum(cost of issued)` and `reserved == 0`; a settled refused redemption must have cost nothing. Add a helper `collect(running, fake, players)` that gathers the input (redemptions by SQL, balances from `COIN_LEDGER`, fake state by HTTP). Every flow test below ends with `expect(judge(await collect(...))).toEqual([])`. Also write two or three direct tests of the judge itself with hand-made input that MUST produce a violation (a double grant; an issued redemption without a grant; a negative balance), so the judge is known to be able to say no.

## Flow tests (test/store.test.ts) - whole app, real HTTP, real PostgreSQL, real TigerBeetle, the fake casino as the platform
Start the fake with test/fake.ts (`appUrl` = the app's url, manual delivery of B callbacks) and `seedDemo(running.db, running.clock, fake.url)`. Give players coins directly through the ledger port in the test setup (`running.app.get(COIN_LEDGER).creditPrize(...)` with the player's uuid, after creating the player by calling `GET /me` with a token); the wheel is another agent's work. App config for tests has `platformTimeoutMs: 300`. Drive retries with `running.clock.advance(ms)` and `outbox.runDue()` (`running.app.get(OUTBOX)`); no sleeps except where a real socket timeout must pass (the 300 ms platform time limit), and then await the request itself rather than sleeping. Cover at least, each ending with the judge:
1. Platform A happy path: 201, status "issued", settled true, balance down by the price, one grant in the fake with our redemption id as reference.
2. Platform B happy path: 201 with "submitting"; `GET` shows "submitting" and coins reserved (available down, reserved up); `/control/b/deliver`; status "issued", settled, one grant.
3. Duplicate redemption request, sequential: same Idempotency-Key twice -> 201 then 200, same id, one grant, charged once. A different key -> a second redemption.
4. Duplicate redemption request, concurrent: 10 identical POSTs at once -> one redemption id in all answers, one grant, charged once.
5. Not enough coins: status "insufficient", nothing reserved, no call to the platform (fake `requests` shows none for that reference).
6. Concurrent redemptions that together exceed the balance: balance 500, six different-key requests for a 100-coin item at once... make it 8 requests: exactly 5 end "issued", 3 "insufficient", balance 0, never negative.
7. Refused: fake fault `refuse` at a.grant -> status "refused", reason shown, coins back in full, settled. Same on B (b.grant refuse, then deliver).
8. Timeout with recovery, platform A, lost answer: fault `lost_answer` at a.grant -> the POST returns "submitting"; one grant already exists in the fake; advance the clock and `runDue()` -> `findReward` finds it -> "issued", settled; still exactly ONE grant.
9. Timeout with recovery, platform A, lost request: fault `lost_request` -> "submitting", no grant; clock + runDue -> not_found -> issue -> "issued"; one grant.
10. Slow answer beyond the time limit (`slow_answer` with delayMs 1000 at a.grant, limit 300): the POST returns within about half a second with "submitting"; later recovery gives one grant. This proves the time limit cancels.
11. Platform B, the dangerous one: `lost_answer` at b.grant (B accepted, we never heard; B has NO idempotency). Recovery must look first: after clock + runDue there is still exactly ONE request for that externalRef in the fake; then deliver -> "issued", one grant. Then the mutation in Rules (b) must turn this test red.
12. Platform B callback lost (`b.callback` fault `lost`): the redemption stays "submitting" until clock + runDue, then `findReward` sees GRANTED -> "issued".
13. Platform B callback twice: second notice changes nothing; one capture; judge clean.
14. Errors then recovery: `error_500` times 3 and `rate_limit` once at a.grant; the redemption stays "submitting" through the failures (never "refused"), the delay honours Retry-After, and it ends "issued" with one grant. Also `a.find` failing does not lead to a blind re-issue.
15. Crash points (config `inlineJobs: false`, driving `runDue()` by hand one step at a time, and calling `advance` twice at each state to stand for "the process died after the step and the job ran again"): the result is the same as the clean run: one grant, charged once.
16. Ledger away during settle: wrap `capture` on the injected ledger to throw `LedgerUnavailable` once: the redemption shows "issued", settled false; after clock + runDue settled true; charged once.
17. Reward webhook security: bad signature 401; a valid beta notice for a redemption of alpha-casino posted to beta's path -> 404 and nothing changes; platform A path -> 400; a notice for a redemption still "reserved" is ignored.
18. Tenant isolation on the player API: a beta token cannot GET an alpha redemption (404), cannot redeem an alpha item (404), and `GET /store/items` shows only its own tenant's items.
19. No Idempotency-Key -> 400. No token -> 401.
20. Differential check: the final visible state (status, settled, balance, number of grants) of the faulty runs in 8, 9, 11, 12 and 14 equals that of the clean run of the same input.

## docs/failure-table.md
One table, plain English: `| What goes wrong | What the system does | Proved by |`. One row per failure you tested (name the test exactly as in the file), plus rows for failures you know are NOT tested, with "not tested" in the last column. This page is read by the owner before an interview; keep each cell to one sentence.

## Rules
- `npm run verify` must pass before you commit. Never make a test pass with a sleep, a retry or a skip. A test that fails because the design is wrong is a finding: report it, do not bend the test. `npx biome check --write src test` fixes formatting.
- Mutation checks before you finish; restore each; report which test caught it; if one is not caught, fix the tests: (a) remove the Idempotency-Key dedup (always create a new redemption); (b) in the "submitting" step call `issueReward` without `findReward` first; (c) make `confirm` act regardless of the current status; (d) treat `PlatformUnreachable` as refused; (e) skip `release` on refused (coins stay reserved); (f) drop the tenant check in the rewards webhook.
- Domain logic in plain files without Nest decorators; controllers and modules are thin. No `new Date()` / `Date.now()` in src. Plain English comments, short sentences. At the top of redemption.ts put a short comment with the two opposite rules: a reward call may be repeated only after looking; a ledger step may be repeated freely because its id is fixed.
- Commit on your branch when green, in two or three commits (outbound adapters; redemption flow with tests and judge; failure table). Message: what changed and how it was checked; no tool names, no attribution or co-author lines. If a test found a real defect in your own code along the way, say so in the commit message (what the test showed, what the fix was). Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md: append one row per commit at the end: `| HH:MM | what | Agent | how it was checked |`, time from `date +%H:%M`; real defects found by tests get their own row.

## Report back (read by a person who does not read the code; under 50 lines)
Branch and commit hashes; what it does in five lines; the list of flow tests with pass/fail; mutation check results (which test caught each); real defects the tests found while you worked (what, how found, how fixed); DEVIATIONS from or additions to the contract; bugs or gaps you found in the fake casino or in other modules; what is not tested.
````

## The agent's report

````text
The Bonus Store is built and committed on branch `worktree-agent-a72b08b4660d7538d`. `npm run verify` is green with 105 tests, and `test/store.test.ts` passed on three more runs in a row. Nothing was pushed or merged.

**Commits**
- `044d889` Platform adapters: issue and find rewards over HTTP.
- `fbe6d2f` Redemption flow, reward webhook, judge and flow tests.
- `5b77c04` `docs/failure-table.md` and the `docs/ai-log.md` rows.

**What it does**
- `GET /store/items`, `POST /store/redemptions` (needs an `Idempotency-Key`), `GET /store/redemptions/:id` and `POST /webhooks/:tenantId/rewards` all work end to end.
- A redemption moves one step per call: `created`, `reserved`, `submitting`, then `issued` or `refused`, or `insufficient`.
- Every `submitting` step looks at the platform first and only issues if the platform has never heard of the reference. Platform B has no idempotency key, so this is what stops a double grant.
- A timeout, 5xx or 429 never refuses a redemption. It stays `submitting` and is asked again with a growing delay (1 s, 2 s, 4 s, up to 60 s). Retry-After from the platform wins over our own delay.
- The ledger reserve, capture and release run before the status write, with fixed ids, so repeating them is harmless.
- `test/judge.ts` reads the fake casino and the ledger, not our tables.

**Tests** (`test/store.test.ts`): 30 flow tests, all passing. They cover all 20 cases you listed (15 runs for both platform A and B). I split 7 into 7a (A) and 7b (B), and 14 into 14a (errors) and 14b (lookup fails). I added test 21 for the timer-against-request race. The judge has 6 direct tests that must report a violation: double grant, issued with no grant, negative balance, coins held after settling, a grant for a refused redemption, and a grant to the wrong player.

**Mutation checks** (each restored afterwards):
- (a) No key dedup: caught by tests 3 and 4.
- (b) Issue without looking first: caught by 8, 11, 12, 14b, 15 and 20.
- (c) `confirm` acts in any status: caught only by test 13, and only after I added a late contradicting DECLINED notice to it. Before that, no test caught it.
- (d) Unreachable treated as refused: caught by 8, 9, 10, 11, 14a, 14b and 20.
- (e) No release on refused: caught by 7a and 7b.
- (f) No tenant check in the rewards webhook: caught by 17.
- (g) My own extra mutation, removing the job lock in the inline run: caught by 21.

**Defects:** the tests found no bug in the code itself. They found one test gap, in (c) above, which is fixed.

**DEVIATIONS and additions to the contract**
- **Inline run takes the job lock.** The request that creates a redemption runs its own job. It takes the outbox row lock (`FOR UPDATE SKIP LOCKED`) and writes the job row itself afterwards (done, retry time, attempts). Without this, the 500 ms timer and the request would both run `submitting` at once and could double-grant on platform B. At most two inline runs hold a connection, because the pool is 5 and more would block each other.
- **A confirm inside the job does not touch the job row.** That row is locked by the very run, so touching it would wait for itself. The webhook's confirm touches the job row first, then the redemption row, the same order the job uses. I found both of these by reading the lock order, not through a test.
- **Time limit on the connection object.** `TenantConnection` has no timeout field and the adapter registry was not in my files, so the limit travels as an optional `timeoutMs` property (`TimedConnection` in `src/integrations/http.ts`). Better added to the domain type.
- **Repeat key checked before the item.** A repeated key returns the stored redemption even if the body names a different or since-deactivated item. An unknown or malformed `itemId` with a new key is 404.
- **Errors in the outbox handler.** `LedgerUnavailable` in the job becomes a retry with backoff, never a dead job. Other errors go through the outbox's normal retry up to its 10-attempt dead state.
- **Inline failures.** Inline failures are logged and swallowed, and the outbox timer retries them.

**Gaps in other modules:** none blocked me. Two things to know:
- The fake casino creates platform B grants only at `/control/b/deliver`, not at accept time. This matches the contract's assumption that the lookup sees a request as soon as it is accepted.
- `slow_answer` does its work immediately and delays only the reply. I used that in test 21 to make a look and an issue overlap.

**Not tested** (listed in `docs/failure-table.md`):
- TigerBeetle down when a redemption is created.
- A real SIGKILL between PostgreSQL and the ledger. Crash points are simulated by repeating the side effects.
- A long wait on platform B.
- Platform B's lookup lagging behind an accepted request. This is a contract assumption and cannot be handled from our side.
- Revoking an issued reward (not built).
````
