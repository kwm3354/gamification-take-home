# Architecture

A casino platform tells us that a player made a deposit. The player gets a spin of a Wheel of
Fortune. The prize is coins in a ledger. The player spends coins in a bonus store, and we ask the
casino platform to issue the reward. Two simulated platforms with different APIs stand in for real
casinos.

What the system promises is a list of things that must never happen (`docs/contracts.md`, checked
by `test/judge.ts` against the fake casino and the ledger, not against our own tables). One deposit
never gives more spins than the grant policy of its time allows. One spin never gives more than one
prize, and the client never chooses the prize. A coin balance never goes below zero. One redemption
never reserves or takes coins twice, and the casino never issues its reward twice for it. Once
everything has settled, coins are never taken without a reward, and a reward is never issued without
taking the coins. One tenant never sees or changes anything of another tenant. An event without a
valid signature never changes anything.

In this document "I" is the author. The source of every decision is `docs/ai-log.md`; where the
agent proposed something and I accepted it, the text says so.

## The service

![The service and what is outside it](img/service.svg)

- Amber is outside: the player, operator staff, and the casino platforms. In the prototype the two
  platforms are one fake casino process with faults on demand.
- Blue is our application: one NestJS process, one module per folder in `src/`.
- Green is the two stores: PostgreSQL holds state, events, jobs and the audit log; TigerBeetle holds
  only coins.
- Nothing outside `src/integrations` knows a platform's field names.
- No transaction spans the two stores; the outbox repairs a crash between them.
- The web app (`web/`, React) is served by the same process at `/app/`. It has a player page and a
  back office page, and it calls the same public API as any client. It is not drawn.
- The daily digest agent is designed, not built.

## The nine parts of the assignment

### Multi-tenant SaaS with tenant isolation

Today: every table carries `tenant_id` and every query filters by it (`src/schema.sql`). The tenant
of a request comes from a place the caller cannot forge: the path plus the tenant's own webhook
signature, the player token's signature, or the tenant's admin key. Each tenant has its own
TigerBeetle ledger (`tenants.ledger_no`), and TigerBeetle never moves coins between two ledgers.

Decision: a ledger per tenant comes from the build contract, which the agent wrote from my decisions
(log, 11:46). Not built: isolation enforced by the database itself (row-level security or a schema per
tenant). I put it first on the list of work from prototype to production (log, 13:08). See
"Security" for the tests and the limit.

### Casino integration layer supporting different external APIs

Today: ports and adapters. The domain declares the port `CasinoPlatform`
(`src/domain/casino-platform.ts`): `parseEvents`, `parseRewardNotice`, `issueReward`, `findReward`.
`src/integrations/platform-a.ts` and `platform-b.ts` translate each platform into it, and
`PlatformRegistry` picks the adapter by `tenants.platform`. One call function,
`src/integrations/http.ts`, puts a time limit on every outgoing call and cancels it with
`AbortController`. Any answer the contract does not list becomes `PlatformUnreachable`, never
"refused".

The two platforms differ in behaviour, not only in field names. Platform A answers a reward request
at once and honours an idempotency key. Platform B accepts, reports the result later by webhook, and
has no idempotency key.

Decisions: ports and adapters, with the domain in the middle, is my choice; I used the same shape in
an earlier payments project (log, 11:39). The agent asked to keep one file per entity so a live change
stays easy. The domain speaks of three outcomes of a reward request: `issued`, `refused`, and
`pending` (not final, or we do not know yet) (`RewardOutcome`, my decision, 11:39). The status the
player sees is built from the same words. Whether a platform can be asked for the status of a reward
is a property of its adapter (my decision, 12:11). The log records no rejected alternative. Not
built: a real platform.

### Player identity mapping

Today: `players` maps the platform's player id (`external_id`) to our id, unique per tenant
(`src/tenants/players.ts`, `findOrCreatePlayer`, safe when two first requests race). The player calls
us with a short-lived HS256 token that the operator signs with the tenant's `token_secret`
(`src/tenants/player-token.ts`): `iss` is the tenant, `sub` is the platform's player id, `exp` is
required and at most 15 minutes ahead. `PlayerAuthGuard` takes tenant and player from the token only,
never from the path or the body. Every failure is the same 401.

Decision: mine, after a discussion (log, 11:33). I doubted that players should call us directly and
treated it as a business question. The agent argued that a widget we own is what lets new mechanics
ship without work on each operator's side. The assumption: the wheel is our widget on the casino's
page, and the same API works if the operator calls it from its own server. Not built: asymmetric
tokens (the operator holds a private key, we hold only the public one), revocation.

### Event ingestion, validation, deduplication and processing

Today: `POST /webhooks/:tenantId/events` (`src/events/events.controller.ts`). The tenant's adapter
checks the signature over the raw bytes (platform A also rejects a timestamp more than 5 minutes
away) and translates the event into `DepositSucceeded` or `IgnoredEvent`. A bad signature is 401 and
one audit record `webhook_rejected`; a signed but bad body is 400 and `webhook_invalid`. Each event
then runs in its own transaction (`src/events/deposit.ts`, `ingestEvent`). The event is stored first,
with its normalised and raw form; the unique key `(tenant_id, external_event_id)` is the
deduplication, so a repeat inserts nothing and grants nothing. For a deposit, the newest grant
policy decides how many spins to create, in the same transaction; `UNIQUE (source_event_id, ordinal)`
is a second guard.

Decisions: a duplicate event is a log line (`event.duplicate`), not an audit row. In my words: a
repeated event changes nothing, so it is not an audit entry; the audit trail records changes (log,
12:52). The digest agent reads the share of duplicates from the logs. Ingestion is synchronous in the
prototype: the webhook answers after the commit. Not built: a queue in front of the intake (see
"Modules and services"), reversal events (a deposit taken back), events other than deposits.

### Gamification rules engine

Today there are two decision points, both pure functions with versioned parameters.

- `spinsForDeposit(deposit, params)` in `src/policies/grant-policy.ts`: minimum amount, allowed
  currencies, spins per deposit (0 to 10, enforced by `validateGrantParams`). Zero spins writes the
  audit record `spin_not_granted` with the reason. Each spin stores the `grant_policy_id` it was
  granted under.
- `pickSegment(wheelSecret, spinId, segments)` in `src/wheel/pick-segment.ts`: the first 8 bytes of
  HMAC-SHA256 of our own spin id under the tenant's secret, modulo the sum of the weights. Each spin
  stores the `wheel_config_id` that was current when it was granted.

Decisions: the outcome is computed, not drawn (mine, from two options the agent gave, log 11:30). A
repeated request gives the same outcome, and an auditor can compute it again. Differences between
operators are policies: named decision points whose parameters are versioned settings of the tenant
(mine, 11:53). A new condition must be cheap to add: one field, one check, one test row (mine, 12:00;
the agent chose the shape, 12:13). Not built: conditions that need history (spins per player per
day), missions, other mechanics.

### Virtual currency ledger

Today: the port `CoinLedger` (`src/domain/coin-ledger.ts`), implemented on TigerBeetle 0.17.9 in
`src/ledger/coin-ledger.tigerbeetle.ts`. Double entry, one TigerBeetle ledger per tenant. Per tenant:
one `issuer` account. Per player: one account with the flag
`debits_must_not_exceed_credits`, so the ledger itself refuses a negative balance, also under
concurrent requests. Every account and transfer id is the first 16 bytes of SHA-256 of a string built
from our own ids (`xfer:prize:<spinId>`, `xfer:reserve:<redemptionId>`, and so on), so a repeated
call moves nothing. A prize is a posted transfer from issuer to player. A redemption reserves coins as
a pending transfer from player back to `issuer`; capture posts it, release voids it. The coins all
players of a tenant still hold are the balance of one account, not a sum over players: what left
`issuer` minus what came back to it (`outstanding`). Every call has a time limit (`LEDGER_TIMEOUT_MS`)
and throws `LedgerUnavailable` after it; the client call is not cancelled, which is safe because
the retry uses the same id.

Decisions: double entry in TigerBeetle is mine (log, 11:00), on two conditions: prove the official
image on other hardware in the first hour, and fall back to a transfers table in PostgreSQL if the
integration was not done by 14:00. The log gives no reason for choosing TigerBeetle over that
fallback. Pending, post and void for a redemption is mine, from two options (11:30). The id scheme and
the account layout came with the build contract the agent wrote. Not built: expiry of coins, a
reward revoked after it was issued.

### Reward redemption and delivery

Today: `src/store/redemption.ts`. A redemption is an intent that is created and then confirmed (my
model, 11:39; the agent pointed out that the two platforms behave differently). `POST
/store/redemptions` with an `Idempotency-Key` creates the row (`created`) and its outbox job in one
transaction; a repeated key returns the first row and changes nothing. `advance` does one step per
call and is safe to repeat: `created -> reserved` (ledger reserve) or `insufficient`;
`reserved -> submitting`, committed before any call to the platform; in `submitting`, look first
with `findReward` and call `issueReward` only when the platform has never heard of the request;
`issued` or `refused`, then capture or release, then `settled_at`.

Two opposite rules, stated at the top of the file. A call that issues a reward may be repeated only
after looking, because platform B has no idempotency key and a blind repeat would grant twice. The
look-first rule is part of my decision of 11:30. A ledger step may be repeated freely, because its
transfer id is fixed by the redemption id (from the build contract).

`confirm(redemptionId, outcome)` is the only function that makes a redemption final. It acts only
when the status is `submitting`, under the row lock; every later call changes nothing. It is called
from four places: platform A's answer and the status look-up (both inside the job step), platform B's
webhook (`applyNotice`), and an admin (`src/admin/resolve.ts`). An unknown outcome (timeout, 5xx, 429)
is never "refused"; the redemption stays `submitting`, which the player and the operator can see.

Two stores without a shared transaction: the order is always PostgreSQL first (the decision and the
job, one transaction), then TigerBeetle with the fixed id, then mark the step done. A crash in between
leaves the job due, and the job runs the same step again. The outbox (`src/outbox/outbox.ts`) claims
jobs with `FOR UPDATE SKIP LOCKED` and holds the row lock while the handler runs. The request that
created a redemption runs its job at once under the same lock (`runInline`); a timer every 500 ms is
the safety net. That PostgreSQL holds the queue of outgoing calls is my decision (11:00); the order of
writes is in the contract the agent wrote. No log row gives a reason for the order.

### Admin configuration

Today: settings are rows, never edited. `wheel_configs`, `grant_policies` and `ops_policies` are
versioned per tenant; a change is a new row with the next version, and a trigger forbids UPDATE and
DELETE. The newest version applies to new work. A spin keeps the wheel and the policy it was granted
under. The admin API (`src/admin/`) has the audit trail of one entity, the list of stuck
redemptions, manual resolution and the alerts. It is guarded by the tenant's `admin_key`
(`X-Admin-Key`, compared without timing leaks); `X-Admin-Name` names the actor.

Decisions, mine (log, 12:00 and 12:01): a change of settings is an intent, like a redemption. The
casino's representative creates it; a policy decides whether it is confirmed at once or waits for us;
which policies apply to which casino only we decide. For a wheel change the policy looks at the
expected prize of one spin: within the limit we set for that casino it is confirmed automatically,
above it the change waits for us. Designed, not built: the settings-change intent and any API or
screen to create a version. Today tests and the seed insert versions through the audited `create`.
Not built: roles; one key per tenant opens every admin call.

### Observability, auditability and security

Audit: `src/audit/audited.ts` is the only write path for `players`, `inbound_events`, `spins`,
`redemptions`, `store_items`, the three policy tables and `tenants`. `create`, `update` and `remove`
write the audit row in the caller's transaction, one entry per changed field; `record` writes a fact
that is not a row change (`platform_call`, `webhook_rejected`, `manual_resolution`,
`outcome_contradicted`). `update` locks the row and runs the state check under the lock, so it is also
the guard against two callers racing. Tenant secrets are written as `***`. A trigger makes
`audit_log` append-only. I required the full trail (create, update, delete) from the start and chose
the model from my earlier payments project; the agent added the tenant column and the trigger (log,
11:27 and 11:29).

Logs: `src/logging/`, one JSON line per event, 18 named events, a request id that also goes into
some of the audit rows of the request (not all: see difference 4 at the end), and fields whose key
looks secret written as `***`. How much a tenant logs is `logLevel` in its ops policy. "Log little
and correctly" and verbosity by policy are mine (12:52); the agent chose the list of events.

Operations: an alert fires on the age of the oldest redemption without a final answer, not on an
error count (mine, 12:08). A redemption that is stuck resolves itself when the platform supports a
status query (mine, 12:11). When nothing can tell the outcome, what happens is an agreement between
our business and the casino (mine, 12:15); whatever it is, an admin can resolve the redemption by hand
through the same `confirm`, as the actor in the audit trail (mine, 12:16). A platform answer that
arrives after the redemption is final and disagrees with it writes `outcome_contradicted` and raises a
critical alert. `GET /admin/:tenantId/alerts` runs seven deterministic checks as SQL
(`src/alerts/alerts.ts`) with thresholds from the tenant's versioned ops policy. The four known ways
to lose money while the ledger is consistent are deterministic alerts, not work for a language model
(mine, 12:23). A daily digest agent is described in `docs/monitoring-playbook.md`: read-only, it reads
whole objects and the logs, and its first question is "are we losing money right now, for any reason"
(mine, 12:22 to 12:27). Nothing runs it. Not built: delivery of alerts, the alert for a deposit
reversed after its spin, metrics and traces. `GET /health` checks both stores. Security has its own
section below.

## Modules and services

My position (log, 12:38 and 12:40): one application with modules, and a separate service only for a
clear reason. Subscribing a new game to events needs module boundaries, not microservices.

Separate, each for a reason:

- The ledger is already separate: TigerBeetle is its own server process, reached through the
  `CoinLedger` port.
- The intake of casino events, behind a queue with consumers (designed, not built). It has a
  different load from the rest, and it must always answer the casino, whatever the rest is doing. The
  domain stays one application; only the intake is split.
- A connection gateway for real time (designed, not built): long-lived player connections, for
  example live leaderboards, are held by a separate service fed over publish and subscribe, not by
  the application that moves coins. I have run this split in an earlier project.

Modules, in one process: tenants and identity, integrations, events, wheel, store, outbox, audit,
admin and alerts, logging. The log gives no separate reason per module beyond the rule above. What
the code relies on: a change, its audit row and its job commit in one PostgreSQL transaction, which
only works while these modules share a database connection. The outbox runs inside the application;
its jobs are claimed with `SKIP LOCKED` and its handlers are safe to repeat, so several runners are
allowed by design, but a separate worker process was not tried. No throughput or latency was
measured.

## Security

Part C asks how players are kept from manipulating reward probabilities or triggering unauthorized
spins. Each mechanism below exists in the code; the tests are named.

Probabilities:

- The client sends nothing that reaches the outcome. `POST /wheel/spins/:spinId/spin` reads no body.
  Test: `test/wheel.test.ts`, "5. the client cannot choose the outcome".
- The outcome is HMAC of the tenant's `wheel_secret` and our own spin id, which the database
  generates. The secret never leaves the server, and `GET /wheel` shows labels and coins, not weights.
  Tests: "4. the HTTP result equals pickSegment from the seeded secret, spin id and table", "GET
  /wheel shows labels and coins, no weights", "another secret gives other outcomes".
- The weights are respected. Test: "over 20,000 random spin ids each share is within 2 points of its
  weight".
- A spin keeps the wheel version it was granted under, so a later change does not reach it. Wheel
  versions cannot be edited. Tests: "9. wheel config versions: an old spin keeps version 1, a new
  deposit gets version 2"; `test/audit.test.ts`, "the audit log and wheel configs cannot be changed".
- Repeating a spin request cannot draw again. The first request moves the spin from `available` to
  `used` under the row lock; every repeat returns the stored result. Tests: "2. twenty identical
  requests at once ...", "2b. requests blocked on the row lock while another use commits ...", "3. a
  repeat later and the outbox job after the inline credit change nothing".
- An operator's wheel that pays too much is a warning: `wheel_expected_prize_high`, and
  `wheel_paying_above_expectation` on what was paid (`test/alerts.test.ts`).

Unauthorized spins:

- Spins exist only as the result of a signed deposit event, created in the event's transaction. No
  API creates a spin. Tests: `test/intake.test.ts`, "5. bad signature on A and B ...", "6. A: stale
  timestamp and an altered body are rejected", "7. signed but invalid payloads are 400 and store
  nothing".
- A repeated or concurrent deposit adds no spin. Tests: "2. the same deposit twice in a row ...", "3.
  ten identical deposits at once: exactly one spin"; `test/grant-policy.test.ts`, "two spins per
  deposit: ordinals 1 and 2, different ids, a repeat adds none".
- Only the owner can use a spin. Tenant and player come from the token, and the spin is looked up by
  id, tenant and player. Tests: `test/wheel.test.ts`, "8. someone else's spin is a 404 and stays
  available", "10. no token or a bad token is 401 ..."; `test/intake.test.ts`, "10. bad tokens are 401,
  and a token stops working when the clock passes exp".
- Many spins for one player in a day is a warning: `many_spins_one_player`.

Limits I know of: the token is HS256, so the operator and we share the secret, and a token is valid
until it expires (up to 15 minutes). Platform B's signature has no timestamp, so a captured body can
be sent again; the event dedup and the `submitting` check make a replay change nothing. Secrets sit in
plain columns of `tenants`; the demo tenants' secrets, the wheel secret included, are fixed strings
in `src/tenants/demo-tenants.ts`. CORS allows any origin for the demo (`src/main.ts`). There is no rate
limiting.

Tenant isolation today is a filter in every query, a ledger per tenant, and the tenant taken from a
credential. Tests: `test/intake.test.ts`, "9. tenants are isolated"; `test/store.test.ts`, "18.
tenant isolation on the player API"; `test/admin.test.ts`, "1. auth: ..." and "2. audit: ... another
tenant's key sees nothing"; `test/ledger.test.ts`, "two tenants with the same player id have separate
balances"; `test/grant-policy.test.ts`, "the other tenant is unaffected by that policy"; and a tenant
check inside each alert test. The honest limit: the database does not enforce it. One query that
forgets the filter would cross tenants, and no test can prove that no such query will be written.

## The life of a redemption

![The life of a redemption](img/redemption.svg)

The player moves it into `created`; the outbox job moves it through `reserved` and `submitting`; only
`confirm()` moves it to `issued` or `refused`; the job settles the ledger. Every failure point in the
diagram has a row and a test in `docs/failure-table.md`.

## What is real, what is simulated, what is not built

Real:

- The application (NestJS, TypeScript), PostgreSQL 16, TigerBeetle 0.17.9 with the official client,
  Docker Compose, CI on GitHub Actions.
- Signatures, player tokens, deduplication, the redemption state machine, the outbox, the audit
  trail, alerts, structured logs, the web app.
- Flow tests over real HTTP, PostgreSQL and TigerBeetle, with faults injected by the fake casino.

Simulated: both casino platforms, in one process (`src/fake-casino/`, state in memory). It makes
assumptions a real platform might not honour:

- Platform B's look-up shows a request as soon as the grant call was accepted. If a real platform
  lags, "look first" sees nothing and we would grant twice. Our side cannot handle this (written in
  `docs/contracts.md` and the failure table).
- Platform A keeps the first answer for an idempotency key for as long as its process runs. A
  refusal is not stored under the key; it is remembered by reference and returned by the look-up.
- Both platforms find a reward by our reference (the redemption id).
- Platform B's amounts are decimal strings with two decimals; our conversion assumes every currency
  has two minor digits.
- The player id in events and in the player token is the same stable id.
- Callback faults: lost, twice, delayed. A late callback that contradicts an earlier one is possible
  only through the fault rules. Not modelled: a look-up that lags, a platform that changes a final
  answer, a deposit reversal.

TigerBeetle: proven on a GitHub-hosted runner (AMD EPYC with AVX2, Docker 29.4.2, log 11:13): the
official image formatted, started, passed the smoke test with the official client, and started again
on the same data file. Without `seccomp=unconfined` it failed with "io_uring is not available", so
both the server and the app container carry that line in `docker-compose.yml`. CI runs the tests
against the official image and then starts the whole compose stack. Not proven: Docker Desktop on
macOS or Windows, and hosts with io_uring disabled. The development machine has no AVX2 and uses a
local build (`scripts/tb-old-cpu.sh`).

Not built: a real casino platform, the settings-change intent and an API to create settings versions,
roles for admins, database-enforced tenant isolation, a queue in front of the intake, the real-time
gateway, missions and other mechanics, coin expiry, revoking a reward, deposit reversals, alert
delivery, the digest agent run, rate limiting, a secrets store, migrations, load tests.

## Differences between the contract and the code

Found while writing this page, for the author to decide.

1. `AuditContext` in the contract has no `now`; the code requires `now: Date`
   (`src/audit/audited.ts:14`). `create` also takes a fifth argument `{ onConflict: "nothing" }`
   (`src/audit/audited.ts:96`) that the contract does not list.
2. The contract says `seedDemo(db)`; the code is `seedDemo(db, clock, fakeCasinoUrl)`
   (`src/tenants/seed.ts:16`).
3. The contract names the actor `player/<playerId>`. The spin writes our internal id
   (`src/wheel/spin.ts:78`); the token guard and the store write the platform's id
   (`src/tenants/player-auth.guard.ts:46`, `src/store/store.service.ts:85`). One player has two actor
   names in the audit trail.
4. `docs/monitoring-playbook.md:268` says the request id is in the `request_id` column of the audit
   rows of that request. Rows written through `ctxFor` in `src/store/redemption.ts:110` (status
   changes, `platform_call`, `outcome_contradicted`), the `manual_resolution` record
   (`src/admin/resolve.ts:50`) and the spin's `credited_at` update (`src/wheel/spin.ts:133`) carry no
   request id.
5. The contract says the spin request runs the job at once. The controller calls `creditSpin`
   directly (`src/wheel/wheel.controller.ts:49`); the job row stays due and runs once more later as a
   no-op.
6. The contract says enqueueing again makes a job due and not done. The code also sets `attempts` to
   0 and clears `dead_at` (`src/outbox/outbox.ts:56`), so a dead job comes back, for example when the
   player repeats a spin request (`src/wheel/spin.ts:112`).
7. Not in the contract: `GET /admin/:tenantId/redemptions/stuck` answers `{ limitSec: null, items: []
   }` for a tenant without an ops policy (`src/admin/admin.controller.ts:55`), and an `Idempotency-Key`
   longer than 200 characters is 400 (`src/store/store.controller.ts:37`).
8. Fixed in review: `outstanding` used to read two accounts (issuer and `redeemed`). Spent coins now
   come back to `issuer`, so it is the net balance of that one account.

Two observations that are not contract differences. The `spin_credit` job goes dead after 10 failed
attempts when the ledger is away (`src/outbox/outbox.ts:26`), while a redemption turns
`LedgerUnavailable` into "wait" and never dies (`src/store/redemption.ts:497`); the failure table
covers only the redemption. For platform B, every event row of a batch stores the whole batch as
`raw` (`src/events/events.controller.ts:112`).
