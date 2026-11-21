# Brief 10: review fixes

Wave 5. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
You fix six precise findings from a review of a working NestJS + PostgreSQL + TigerBeetle prototype (a gamification service for casino operators). It has 226 passing backend tests. You work in your own git worktree on your own branch. Other agents may edit web/** and add list endpoints in src/admin/ in parallel: do not touch web/**, and in src/admin touch only src/admin/resolve.ts for finding 2.

## Read first
CLAUDE.md, docs/contracts.md, docs/architecture.md (section 8, the list of differences), docs/failure-table.md, src/domain/coin-ledger.ts, src/ledger/coin-ledger.tigerbeetle.ts, test/ledger.test.ts, src/wheel/spin.ts and wheel.controller.ts, src/store/redemption.ts and store.service.ts, src/admin/resolve.ts, src/tenants/player-auth.guard.ts and players.ts, src/events/deposit.ts, src/logging/request-id.ts, src/outbox/outbox.ts, src/audit/audited.ts, test/judge.ts, src/alerts/alerts.ts.

## Machine setup (first, exactly)
```
npm ci
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle     # in every shell that runs tests
npm run verify      # must be green (226 tests) before you change anything
```
The CPU has no AVX2; the script swaps in a local TigerBeetle build. The disk is nearly full: do not run docker compose, do not leave temporary files, and delete your own /tmp/tb-* directories if a test run is killed. Do not stop containers you did not start.

## The findings (each is one commit: a test that shows it first, then the fix)

1. **"Coins outstanding" must be the balance of ONE account.** The design statement, which the author will defend, is: the operator's total debt to players is the balance of one account, the issuer: what left it minus what came back. The code has two tenant accounts: prizes go issuer -> player, and spent coins go player -> `redeemed`; `outstanding` subtracts one account from the other. Change the model so that spent coins come BACK to the issuer: the reserve is a pending transfer player -> issuer, capture posts it, release voids it. Then `outstanding` = issuer `debits_posted` - issuer `credits_posted`, read from one account, and the `redeemed` account disappears. Keep every id derivation and every other behaviour. The issuer account must be allowed to have debits exceed credits (it issues coins). Total coins ever redeemed is still visible as the issuer's `credits_posted`; expose nothing new unless a test needs it. Update the port's comments (src/domain/coin-ledger.ts), the "Ledger" section of docs/contracts.md, and the matching lines of docs/architecture.md (search for "redeemed" and "outstanding" and make the text true). Tests: the existing ledger tests must pass with the smallest edits the model change forces; add one test that reads the issuer account directly from TigerBeetle and shows `outstanding` equals that single account's net balance after prizes, a capture, a release and a pending reserve (say in the test what a pending reserve does to the number and assert it: pending is not yet "come back").

2. **Request id missing from some audit rows.** These audit rows are written without a request id although they happen inside a request or a job: redemption status changes, `platform_call` and `outcome_contradicted` (through `ctxFor` in src/store/redemption.ts), `manual_resolution` (src/admin/resolve.ts), and the spin's `credited_at` update (src/wheel/spin.ts). Take the request id from the AsyncLocalStorage that src/logging/request-id.ts already fills (HTTP requests) and that outbox jobs fill with `job:<kind>:<refId>`; if nothing is set, leave it null. Do it in ONE place if you can (for example a default inside the audit functions: when `ctx.requestId` is undefined, read the store), rather than threading a parameter through many callers. Test: after a full flow on platform B, every audit row of the redemption and of the spin has a non-null request id; rows written by the HTTP request carry that request's id (equal to the `x-request-id` response header) and rows written by an outbox job carry the `job:` form.

3. **One player, two actor names.** The spin's audit rows use `player/<our player uuid>`; the token guard and the store use `player/<the platform's id>`. Pick ONE: `player/<our player uuid>` everywhere (it is unique across tenants and never changes; the platform's id is on the player row). Test: for one player, the set of distinct `player/...` actors across all audit rows of a flow (player create, spin, redemption) has exactly one element. Update docs/contracts.md where it describes actors.

4. **A dead job comes back to life silently.** `outbox.enqueue` on an existing row resets `attempts` to 0 and clears `dead_at`. That is intended for re-arming a finished job, but it also means a job that died after 10 failures is revived when a player repeats a request. Decide nothing new: keep the behaviour (a new request is a legitimate reason to try again) but make it visible and stated: when enqueue revives a row whose `dead_at` was set, write a log event `outbox.revived` (warn) { kind, refId, previousError } and add one sentence to the "Outbox" section of docs/contracts.md and a row to docs/failure-table.md. Test: drive a job dead, enqueue it again, see it run and see the log line. (If the outbox has no log dependency, add it as an optional constructor argument; do not break existing constructions in tests.)

5. **`insufficient` redemptions show `settled: false` forever.** A redemption that ended "insufficient" reserved nothing, so nothing is left to settle. The API view shows `settled: false`, and anything filtering on "not settled" would catch it. Make the view report `settled: true` for "insufficient" (nothing to settle is settled) WITHOUT writing `settled_at` for it in a migration-like sweep; simplest: set `settled_at` when the status becomes "insufficient" (same update), and make the stuck list and the alert `redemption_pending_too_long` unaffected. Check test/judge.ts and the stuck query still mean what they say. Test: the redemption view of an insufficient redemption has `settled: true`; it does not appear in the stuck list after the age limit.

6. **Database clock in two columns.** `spins.created_at` and `players.created_at` come from the database's `now()` default, not from the injected clock, so tests and alerts that move the clock cannot rely on them. Pass `created_at: clock.now()` at the places that create these rows (src/events/deposit.ts for spins, src/tenants/players.ts for players, and the seed if it creates such rows), leave the column defaults in the schema as a fallback. Test: with the fake clock moved a day ahead, a new player and a new spin carry the clock's time. If src/alerts/alerts.ts used `inbound_events.received_at` as a workaround for this, leave it (it is correct) and say so.

## Rules
- For each finding: write the test first and see it fail for the right reason; then fix; then `npm run verify` green; then commit. Six commits, in the order above. Never make a test pass with a sleep, a retry or a skip. `npx biome check --write src test` fixes formatting.
- Commit message: the finding in one sentence ("Found in review: ..."), what the test shows, what the fix is, how it was checked. No tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md: append one row per commit at the end: `| HH:MM | what | who decided | how it was checked |`, time from `date +%H:%M`; "who decided": for finding 1 "Author (the one-account model is his); agent (the fix)", for the others "Agent (found in review of the code against the contract)".
- No `new Date()` / `Date.now()` in src. Imports end in `.ts`; injected classes are plain imports, never `import type`. Plain English comments, short sentences. Do not refactor anything that is not needed for these six.
- If a finding turns out to be wrong (the code already does it), do not invent a change: say so with the evidence.

## Report back (read by a person who does not read the code; under 30 lines)
Branch and the six commit hashes; per finding one line: what the failing test showed, what changed; total tests now; anything else you noticed that is wrong (do not fix it, list it); what is not tested.
````

## The agent's report

````text
All six findings are fixed on branch `worktree-agent-a9225d7a9f7432daf`, one commit each, in the order you gave. `npm run verify` was green after every commit and ends at 231 tests, up from 226. I did not push or merge.

| # | Commit | Finding |
|---|---|---|
| 1 | `82f765a` | "Coins outstanding" is one account |
| 2 | `53c71f6` | Request id missing from audit rows |
| 3 | `0f3b519` | One player, two actor names |
| 4 | `182ce76` | Dead job revived silently |
| 5 | `f33bff7` | `insufficient` shown as `settled: false` |
| 6 | `8bda635` | `created_at` from the database clock |

1. **Outstanding.** The new test reads the issuer account straight from TigerBeetle. It failed because the issuer's `credits_posted` was 0, since spent coins went to a separate `redeemed` account. A reserve is now a pending transfer from the player to the issuer. `outstanding` is the issuer's `debits_posted` minus its `credits_posted`, and the `redeemed` account is gone. The test asserts that a pending reserve does not lower the number until capture. I updated the port comments, `docs/contracts.md` and `docs/architecture.md`.
2. **Request id.** A platform B flow (with a lost grant answer, so an outbox job finishes it) left 9 audit rows with no request id. The audit write now falls back to the id of the running HTTP request or outbox job (`job:<kind>:<refId>`). That is a single place, in `src/audit/audited.ts`. With the fallback removed the test fails again.
3. **Actor name.** A flow showed two `player/...` actors, our uuid and the platform's id. Everything now uses `player/<our player uuid>`. The guard makes the new player's id before the insert, so the row that creates the player can use it as its actor. The store uses the same name.
4. **Dead job.** The test drives a job dead, enqueues it again and sees it run. It also expects an `outbox.revived` warning with `previousError`, which did not exist before. Enqueue now reads the row in the same SQL statement as the upsert and logs the warning if it was dead. I added a sentence to the Outbox section of the contract, a row to the failure table, a line in the playbook, and changed "18 named events" to 19.
5. **Insufficient.** The view showed `settled: false`. The status change to `insufficient` now sets `settled_at` in the same update. The stuck query, the alert and the judge are unchanged: they never counted `insufficient` as unsettled, so the stuck-list assertion in the extended test passes without the fix.
6. **Clock.** With the fake clock a day ahead, both columns showed database time. `created_at` is now set from the injected clock for players and spins. The seed creates neither row. `alerts.ts` uses `inbound_events.received_at`, which was already correct, so I left it.

I appended one row per commit to `docs/ai-log.md` and updated the "differences" list in `docs/architecture.md` (items 3, 4, 6 and 8 now say "Fixed in review"). All six findings were real, none were already correct.

**Other things I noticed, not fixed:**
- `outbox.revived` is logged inside the caller's transaction, so a rollback would leave a line for a revival that never happened.
- `alerts.ts` uses `player/<platform id>` as the alert subject (lines 165 and 189). That is an alert subject, not an audit actor, but it is the same naming split.
- The architecture doc's other differences (items 1, 2, 5 and 7) are untouched.
- The test in `test/logging.test.ts` moves the shared fake clock a day ahead. It is the last test in that file, so nothing else is affected.

**Not tested:**
- A concurrent revival where two requests enqueue the same dead job at once.
- Players or spins created by the seed, since the seed makes none.
- Whether `previousError` is set when a job died with no `last_error`. It falls back to null.

There are three `/tmp/tb-*` directories with running TigerBeetle processes. Two date from 13:05, before I started. `/tmp/tb-6i3q1L` was created at 13:32, while my last test run was going, but my runs had finished before the final check, so I think it belongs to another agent. I left all three alone.
````
