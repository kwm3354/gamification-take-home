# Build contract

What every part of the prototype agrees on. Code that disagrees with this page is wrong, or this
page must change first. The shared files are `src/schema.sql`, `src/domain/coin-ledger.ts` and
`src/domain/casino-platform.ts`.

## What must never happen

This list is the judge (`test/judge.ts`). The judge reads the fake casino and the ledger, not our tables.

1. One deposit gives more spins than the grant policy of its time allows (one, by default).
2. One spin gives more than one prize, or a prize the client chose.
3. A coin balance goes below zero.
4. One redemption reserves or debits coins twice, or the casino issues its reward twice.
5. Coins are debited and no reward was issued; or a reward was issued and the coins were not debited
   (once everything has settled).
6. One tenant sees or changes anything of another tenant.
7. An event without a valid signature changes anything.

## Shape

- NestJS, one module per folder in `src/`. Domain rules are plain classes and functions without
  Nest decorators; Nest only wires them. One file per entity. Nothing outside `src/integrations`
  knows a platform's field names.
- PostgreSQL holds state, the inbound events, the outbox and the audit trail. TigerBeetle holds
  coins. There is no transaction across the two. The order is always: decide and write the job in
  PostgreSQL (one transaction), then call TigerBeetle with an id derived from the spin or
  redemption id, then mark the step done in PostgreSQL. A crash in between is repaired by the
  outbox job running the same step again.
- Time comes from `Clock` (`src/clock.ts`), injected with the token `CLOCK`. No `new Date()` or
  `Date.now()` in `src/` outside `clock.ts`. No test sleeps.

## Tenants and demo data

Two tenants, seeded by `seedDemo(db)` (idempotent; the app runs it at start when `SEED_DEMO=1`,
tests call it directly):

| id | platform | ledger_no | wheel | store |
|---|---|---|---|---|
| `alpha-casino` | A | 1 | version 1 | `bonus-5-eur` for 500 coins, `bonus-1-eur` for 100 coins |
| `beta-casino` | B | 2 | version 1 | the same two items |

Wheel version 1: `10 coins` weight 50, `50 coins` weight 30, `100 coins` weight 15, `500 coins`
weight 5. Demo secrets are fixed strings in `src/tenants/demo-tenants.ts`; `platform_url` comes from
env `FAKE_CASINO_URL` (default `http://fake-casino:4000`).

## Tenant isolation is checked per route

Isolation is enforced in code: every query filters by tenant. The risk is a new route whose query
forgets the filter. `test/tenant-isolation.test.ts` reads every HTTP route from the running app
(the Express router stack) and wants a decision for each: a check in `CHECKED`, or a reason in
`SKIPPED`. A route in neither list fails the test ("New route ...: decide"). An entry that matches
no live route fails too ("stale entry"), and so does a route in both lists. The checks call each
route as beta's actor with alpha's identifiers (collected from every table with a `tenant_id`
column) and expect a 404 or a clean answer; for writes, all of alpha's rows must be the same
afterwards. A request that is rejected for a bad signature is audited under the tenant of the path,
so alpha's trail may show a rejected beta-signed request; that is the only change allowed.

## Actors and audit

Every create, update and delete of a row in `players`, `inbound_events`, `spins`, `redemptions`,
`store_items`, `wheel_configs`, `grant_policies`, `ops_policies`, `tenants` goes through `src/audit/audited.ts`, inside the caller's
transaction. There is no other write path to these tables.

```ts
type AuditContext = { tenantId: string | null; actor: string; requestId?: string };
// requestId missing: the audit functions take the id of the running HTTP request or outbox job
// ("job:<kind>:<refId>"); null only outside both.
// actor: "platform/<tenantId>", "player/<playerId>" (OUR player uuid, never the platform's id), "system/<name>", "admin/<name>", "unknown"

create(tx, ctx, table, row): Promise<Row>                    // audit action "create", one change per column
update(tx, ctx, table, id, change: (current: Row) => Partial<Row> | null): Promise<{ before: Row; after: Row } | null>
  // locks the row (SELECT ... FOR UPDATE), calls `change`, writes only the fields that differ;
  // returns null and writes nothing when `change` returns null or the row does not exist
remove(tx, ctx, table, id): Promise<void>                    // audit action "delete"
record(tx, ctx, fact: { action: string; entityType: string; entityId: string; changes?: unknown }): Promise<void>
  // for facts that are not a row change: a rejected webhook, an outgoing call and its answer
```

`update` is also the concurrency guard: the state check happens inside `change`, under the row lock.

## Ledger (TigerBeetle 0.17.9)

Port: `src/domain/coin-ledger.ts`. Model:

- TigerBeetle `ledger` = the tenant's `ledger_no`. Accounts of two tenants can never be in one transfer.
- Per tenant: one `issuer` account (code 10; no balance flag, it issues coins). Per player: one
  account (code 1) with the flag `debits_must_not_exceed_credits`, so the ledger itself refuses a
  negative balance.
- Account and transfer ids are the first 16 bytes of SHA-256 of a string, as a u128:
  `acct:<ledgerNo>:issuer`, `acct:<ledgerNo>:player:<playerId>`,
  `xfer:prize:<spinId>`, `xfer:reserve:<redemptionId>`, `xfer:capture:<redemptionId>`,
  `xfer:release:<redemptionId>`.
- Prize: issuer -> player, posted. Reserve: player -> issuer, pending, no timeout (spent coins
  come back to where they came from). Capture posts the pending transfer; release voids it.
- Accounts are created on first use; "exists" is success.
- A repeated id with the same content is success. A reserve that failed for lack of coins stays
  failed for that redemption id (the ledger remembers the id), which is what we want.
- `available = credits_posted - debits_posted - debits_pending`; `reserved = debits_pending`.
- `outstanding` = issuer `debits_posted` minus issuer `credits_posted`: the balance of ONE account.
  A pending reserve is not yet "come back", so it lowers the number only when captured. Total coins
  ever redeemed is the issuer's `credits_posted`.
- Every call has a time limit (env `LEDGER_TIMEOUT_MS`, default 2000) and throws `LedgerUnavailable` after it.

## Outbox

`src/outbox/outbox.ts`, token `OUTBOX`.

**No network call inside a database transaction.** A job's handler calls the casino and the ledger.
It never runs while a transaction is open or while a pooled connection is held for it.

```ts
enqueue(tx, job: { tenantId: string; kind: string; refId: string; runAt?: Date }): Promise<void>
  // one row per (kind, refId); enqueueing again makes an existing row due now and not done
handle(kind: string, fn: (job: { tenantId: string; kind: string; refId: string; attempts: number }) => Promise<"done" | { retryInMs: number }>): void
runDue(): Promise<number>   // claims up to `batch` due jobs, runs their handlers at the same time, repeats until nothing is due; returns how many ran
drain(maxRounds = 20): Promise<void>  // runDue until nothing is due now; for tests
claimOne(kind, refId): Promise<Claim | null>   // the lease on one job, for a request that runs its own job; null when someone holds it
finish(claim, "done" | { retryInMs } | { error }): Promise<boolean>  // false: the lease was lost, nothing written
```

How a job runs:

1. Claim: one statement picks due jobs (`done_at` and `dead_at` null, `run_at` passed, no live claim;
   ordered by `run_at, id`; `LIMIT batch`; `FOR UPDATE SKIP LOCKED`) and sets
   `claimed_until = now + lease` and a fresh `claim_token`. It commits at once.
2. Run: the handlers run with no transaction and no connection held. Several run at the same time.
3. Finish: the outcome (done, retry with `run_at` and `attempts`, or dead) is written with
   `WHERE id = $1 AND claim_token = $2` and the claim is cleared. This is the fence. If no row
   matches, the lease went to another worker: nothing is written and the warning
   `outbox.lease_lost` { kind, refId } is logged.

A worker that dies while running a job leaves its claim. When `claimed_until` has passed the job is
due again and another worker runs it. Handlers are safe to repeat; that was always the contract.
The lease (option `leaseMs`, default 60 s) must be longer than the longest handler: the platform time
limit plus the ledger time limit, 2 s each by default. If a handler does outlive its lease, two
workers can overlap on that job. The money is then protected by what protects it on any repeat:
fixed ledger transfer ids, `findReward` before every grant, and `confirm` acting only on `submitting`.

`enqueue` on a job that a worker holds does not touch the claim (that would fence the running
worker out and run the job twice at once). It sets `rerun`. When the worker finishes, the outcome is
not written and the job stays due as the enqueue left it: exactly one more run, after the first.

A handler that throws is retried with a delay of 1 s, 2 s, 4 s, ... up to 60 s; after 10 attempts
the job gets `dead_at` and stays visible. Enqueueing a dead job again (a player repeats a request)
revives it with `attempts` 0; this is allowed on purpose and never silent: the warning `outbox.revived`
{ kind, refId, previousError } is logged. In the running app a timer calls `runDue` every 500 ms
(off when `OUTBOX_TIMER=off`, which tests use; they call `runDue` and move the clock).

### Workers scale by count

Because a job is claimed by lease, any number of processes can run jobs on one database, each
taking different jobs. The process role is the env `ROLE`:

| `ROLE` | HTTP API | Outbox timer |
|---|---|---|
| `all` (default) | yes | yes |
| `api` | yes; a request still runs its own job inline under the lease | no |
| `worker` | listens, but is not published: only `GET /health` is meant to be called | yes |

`OUTBOX_TIMER=off` still turns the timer off in any role (tests use it). `OUTBOX_BATCH` (default 16)
is how many jobs one claim takes; `OUTBOX_POLL_MS` (default 500) is how often the timer looks;
`OUTBOX_LEASE_MS` (default 60000) is how long a claim lasts.
There is no route filtering in a worker: it runs the same app, and nothing routes traffic to it.

The schema (and the demo seed, when `SEED_DEMO=1`) is applied at start. Applying the schema runs under
a PostgreSQL advisory lock, so several processes starting together do not collide. The script runs only
when its text changed since the last run (its hash is in `schema_state`): even a script that changes
nothing takes exclusive table locks, and a worker started while others were busy deadlocked with their
transactions. A deploy that changes the schema still takes those locks once, so run it when traffic is low.
The demo seed is on for the `app` service only.

In `docker-compose.yml` the `app` service is `ROLE: api` and the `worker` service has `replicas: 2`
(no published port, no container name), so `docker compose up --scale worker=4` is possible.

What was run: the outbox test with three `Outbox` objects on one database (30 jobs, each ran once,
the three workers ran jobs at the same time) and the test that starts the schema from two
connections at once. The compose file was not run by this change.

## Our HTTP API

Webhooks from a platform (signature checked by the tenant's adapter; tenant from the path):

| Call | Answers |
|---|---|
| `POST /webhooks/:tenantId/events` | 200 `{ "accepted": 1, "duplicates": 0, "ignored": 0 }`; 401 bad signature; 404 unknown tenant; 400 bad payload |
| `POST /webhooks/:tenantId/rewards` | 200 `{ "redemptionId": "...", "status": "issued" }`; same errors; platform A: 400 |

Player calls. `Authorization: Bearer <JWT>`, HS256, signed by the operator with the tenant's
`token_secret`; claims `iss` = tenant id, `sub` = the platform's player id, `exp` required, at most
15 minutes ahead. Tenant and player come from the token only. 401 for a missing, expired or badly
signed token.

| Call | Answers |
|---|---|
| `GET /me` | `{ "playerId", "tenantId", "balance": { "available": "150", "reserved": "0" } or null when the ledger does not answer, "spins": [{ "id", "status", "coins" }] }` (coins as strings) |
| `GET /wheel` | `{ "version": 1, "segments": [{ "label", "coins" }] }` |
| `POST /wheel/spins/:spinId/spin` | 200 `{ "spinId", "segmentIndex", "label", "coins" }`; the same answer for every repeat; 404 if the spin is not this player's |
| `GET /store/items` | `[{ "id", "code", "name", "costCoins", "reward" }]` |
| `POST /store/redemptions` with header `Idempotency-Key`, body `{ "itemId" }` | 201 (first time) or 200 (repeat) `{ "id", "status", "costCoins", "reward", "reason" }`; the key is bound to the item: the same key with another `itemId` is 409 `idempotency_key_reused`; 400 without the key; 404 unknown item |
| `GET /store/redemptions/:id` | the same object; 404 if not this player's |

Admin calls: see "Admin and operations", "Back office API" and "Admin sign-in and roles" below.

## Wheel outcome

`segmentIndex` is a pure function `pickSegment(wheelSecret, spinId, segments)`:
`n = first 8 bytes of HMAC-SHA256(wheelSecret, spinId) as an unsigned integer, mod (sum of weights)`,
then walk the segments in order. The spin uses the wheel config it was granted with. Several spins from one deposit (`ordinal` 1..n) have different ids and so independent outcomes.

Spin: in one transaction `update` the spin from `available` to `used` with `segment_index`, `coins`,
`used_at`, and enqueue `spin_credit`. After commit run the job at once (the timer is the safety
net). The job calls `creditPrize` and then sets `credited_at`. A spin that is already `used` returns
the stored result and makes sure the job exists.

## Grant policy

How many spins a deposit gives is decided by parameters, not by code. `grant_policies` is versioned
like `wheel_configs`: a change is a new row (append-only), the newest version applies to new
deposits, and each spin stores the `grant_policy_id` it was granted under. Both demo tenants get
version 1: `{ "minAmountMinor": 1, "currencies": null, "spinsPerDeposit": 1 }`.

- `params`: `minAmountMinor` integer >= 0; `currencies` null (any) or a non-empty list of 3-letter
  upper-case codes; `spinsPerDeposit` integer 0..10. `validateGrantParams` enforces these limits.
- Decision point: the pure function `spinsForDeposit(deposit, params)` in
  `src/policies/grant-policy.ts`. It returns `{ spins }` or `{ spins: 0, reason }` with the reason
  `below_minimum`, `currency_not_allowed` or `zero_spins`. A new condition is one more field, one more
  check and one more test row.
- Intake: the event is stored first. Then `deposit.ts` reads the newest policy and creates the spins
  with `ordinal` 1..n, all in the event's transaction. `UNIQUE (source_event_id, ordinal)` and the
  event dedup keep a repeated deposit from adding spins. The dedup key is (tenant, external event id).
  An ignored event (a pending or failed deposit) is stored under `<id>:<type or kind:state>`, so it never
  takes the key that the successful deposit with the same id will use. With 0 spins the event still counts as
  accepted and one audit `record` is written: action `spin_not_granted`, entity type `inbound_event`,
  entity id the event row id, changes `{ reason, grantPolicyId }`.
- Not built: conditions that need history (spins per player per day), an API or admin screen to
  create a version (tests and the seed insert rows through `create`).

## Redemption: one intent, two steps

Statuses: `created -> reserved -> submitting -> issued | refused`, or `created -> insufficient`.
`issued` and `refused` are final for the player; `settled_at` says the ledger has caught up.
`insufficient` reserved nothing, so `settled_at` is set in the same update that sets the status.

`POST /store/redemptions` creates the row (`created`) and the job `redemption_advance` in one
transaction, then runs the job at once under the job's lease (`claimOne`, no transaction open during the calls; if a worker holds the lease it returns the current state without waiting; over `INLINE_MAX` inline runs it skips and leaves the job to the outbox) and returns the current state. A repeated key returns the
existing row and changes nothing.

`advance(redemptionId)`, one step per call, safe to repeat:

| Status | Step |
|---|---|
| `created` | `reserve` in the ledger -> `reserved`, or `insufficient` (final) |
| `reserved` | set `submitting` and commit; only then call the platform |
| `submitting` | `findReward` first. `issued` / `refused` -> `confirm`. `pending` -> ask again later. `not_found` -> `issueReward`, then `confirm` if the answer is final. `PlatformUnreachable` -> ask again later (honour `retryAfterMs`) |
| `issued`, not settled | `capture`, then `settled_at` |
| `refused`, not settled | `release`, then `settled_at` |

`confirm(redemptionId, outcome)` is the one function that makes a redemption final. It is called
from the synchronous answer (platform A), from the reward webhook (platform B) and from
`findReward`. It only acts when the status is `submitting`; a second call changes nothing. It sets
the status and enqueues the job, which settles the ledger.

Every outgoing call and its outcome is written with `record` (action `platform_call`).

## Platform A ("Alpha"): answers at once

Deposit event to us:

```
POST /webhooks/alpha-casino/events
X-Alpha-Timestamp: 1795000000
X-Alpha-Signature: <hex HMAC-SHA256(webhook_secret, timestamp + "." + raw body)>

{ "event_id": "evt_1", "type": "deposit.succeeded", "player_id": "p-100",
  "amount_minor": 2000, "currency": "EUR", "occurred_at": "2026-11-21T08:00:00Z" }
```

A timestamp more than 5 minutes from now is a bad signature. Any other `type` is `ignored`.

Reward API:

```
POST {platform_url}/a/bonuses
Authorization: Bearer {platform_key}
Idempotency-Key: <redemptionId>
{ "player_id": "p-100", "amount_minor": 500, "currency": "EUR", "reference": "<redemptionId>" }

201 { "bonus_id": "b_1", "status": "granted" }        -> issued
422 { "error": "player_blocked" }                     -> refused
429 (Retry-After: seconds), 5xx, timeout, broken connection -> PlatformUnreachable

GET {platform_url}/a/bonuses?reference=<redemptionId>
200 { "bonus_id": "b_1", "status": "granted" }        -> issued
200 { "status": "rejected", "error": "..." }          -> refused
404                                                   -> not_found
```

A repeated `Idempotency-Key` returns the first answer and grants nothing new.

## Platform B ("Beta"): accepts, then reports by webhook

Deposit events to us, in batches:

```
POST /webhooks/beta-casino/events
X-Beta-Auth: <base64 HMAC-SHA256(webhook_secret, raw body)>

{ "batchId": "batch-9", "transactions": [
  { "txnId": "T-1", "kind": "DEPOSIT", "state": "COMPLETED", "customer": { "id": "77" },
    "amount": "20.00", "currencyCode": "EUR", "completedAt": 1795000000 } ] }
```

`kind` other than `DEPOSIT` or `state` other than `COMPLETED` is `ignored`. `amount` is a decimal
string in major units. `externalEventId` is `txnId`.

Reward API:

```
POST {platform_url}/b/v2/rewards/grant
X-Api-Key: {platform_key}
{ "customerId": "77", "reward": { "type": "BONUS", "value": "5.00", "currency": "EUR" }, "externalRef": "<redemptionId>" }

202 { "requestId": "r_1", "state": "ACCEPTED" }       -> pending (platformRef r_1)
429, 5xx, timeout, broken connection                  -> PlatformUnreachable

GET {platform_url}/b/v2/rewards/requests?externalRef=<redemptionId>
200 { "items": [{ "requestId": "r_1", "state": "ACCEPTED" | "GRANTED" | "DECLINED", "reason": "..." }] }
    empty list -> not_found; ACCEPTED -> pending; GRANTED -> issued; DECLINED -> refused
```

The result, to us, signed like its deposit events:

```
POST /webhooks/beta-casino/rewards
{ "requestId": "r_1", "externalRef": "<redemptionId>", "state": "GRANTED" | "DECLINED", "reason": "..." }
```

Platform B has no idempotency key: two grant calls with one `externalRef` make two grants. Only
"look first, then repeat" protects us. Assumption (goes into the README): the lookup shows a request
as soon as the grant call was accepted.

Outgoing calls have a time limit (env `PLATFORM_TIMEOUT_MS`, default 2000) that really cancels the
request (`AbortController`).

## Fake casino

`src/fake-casino/`, a separate process (entry `src/fake-casino/main.ts`, plain `node:http`, no
framework, port from env `PORT`, default 4000), its own state in memory, no access to our database.
It is built into the same image and started with a different command. It imports nothing from the
rest of `src/` except `src/tenants/demo-tenants.ts`. It plays both platforms for any tenant.

- The platform APIs above, under `/a/...` and `/b/...`. It records every grant with the reference.
- `POST /control/deposit { tenantId, platform, playerId, amount, eventId?, ourUrl }` builds a
  correctly signed event in that platform's format, sends it to us and returns our answer.
  `tamper: "signature"` sends a wrong signature. `repeat: n` sends the same event n times.
- `POST /control/token { tenantId, playerId }` returns a player token (the casino signs it).
- `PUT /control/tenants/:tenantId/secrets { webhookSecret?, tokenSecret? }` -> 204. From then on the fake signs with these (demo only: it stands for the casino's engineer pasting a new key into the casino's configuration). Each is a string of at least 8 characters; at least one is required; an unknown tenant is 400.
- `POST /control/faults { point, fault, times }` scripts a fault for the next `times` calls at a point.
  Points: `a.grant`, `a.find`, `b.grant`, `b.find`, `b.callback`.
  Faults: `error_500`, `rate_limit` (429, Retry-After 1), `refuse`, `lost_request` (nothing done,
  connection dropped), `lost_answer` (the work IS done, connection dropped), `slow_answer` (the
  work is done, the answer comes after `delayMs`). For `b.callback`: `lost`, `twice`, `delay`.
- `POST /control/chaos { seed, rates: { "<point>": { "<fault>": 0.1 } } }` turns on seeded random faults.
- Platform B sends its callback when told: `POST /control/b/deliver` delivers all due callbacks
  (tests call it; in the demo a timer does, 1 s after the grant).
- `GET /control/state` returns everything the judge needs: every grant with tenant, player,
  reference and amount; every request received.
- `GET /control/players` returns the players the casino has met (token, deposit or grant request) with the references they asked for: `[{ tenantId, playerId, references }]`. The control page's check reads it.
- `POST /control/reset`.

Secrets and keys of the demo tenants are fixed strings in one small file,
`src/tenants/demo-tenants.ts` (plain data, no imports). The seed and the fake casino both read it.

## Logs

Code: `src/logging/`. One JSON object per line on stdout:
`{ "at", "level", "event", "tenantId", "requestId", ...fields }`. `at` comes from the injected clock.
`tenantId` is null when a line has no tenant. `requestId` is the `x-request-id` of the request (valid:
`[A-Za-z0-9._-]{1,64}`; otherwise a new uuid; always echoed in the response header) or
`job:<kind>:<refId>` inside an outbox job.

Levels: error, warn, info, debug. A line is written when its level is at or above the level of its
tenant. The level of a tenant is `logLevel` (`"info"` or `"debug"`, default `"info"`) in its newest ops
policy, read at most every 30 s (injected clock) and never awaited by the caller: the first line of a
tenant, and the first line after the cache expires, still use the old value. Lines without a tenant
use `info`.

Events (the only ones): `event.accepted`, `event.duplicate`, `event.ignored` (debug), `webhook.rejected`,
`webhook.invalid`, `spin.used`, `spin.credited` (debug), `spin.credit_deferred`, `redemption.created`,
`redemption.status`, `redemption.contradicted`, `platform.call`, `platform.unreachable`,
`outbox.retry` (debug), `outbox.dead`, `outbox.revived` (warn), `admin.manual_resolution`, `tenant.key_rotated` (info: `adminId`, `kind`, `previousValidForSec`, `hint`), `tenant.key_previous_revoked` (info), `admin.login` (info, `userId`, `role`), `admin.login_failed` (warn, `reason`: `bad_credentials` or `locked`), `ledger.unavailable`, `unhandled`.
Each is explained in `docs/monitoring-playbook.md`. A duplicate event is a log line and not an audit
entry: it changes nothing.

Redaction: a field whose key matches `/secret|token|signature|authorization|key|password/i` is written
as `"***"` at any depth (so `idempotencyKey` is redacted too). `Bearer <token>` inside a text value
becomes `Bearer ***`. Bigint values are written as strings. Request and response bodies are not logged.
Logging never throws into the caller: a value that cannot be serialised gives a minimal line with
`logError`.

## Tracing

OpenTelemetry, traces only. Spans are written by hand at our boundaries (`src/tracing/tracing.ts`);
nothing is patched and no auto instrumentation is used. Tracing is off unless
`OTEL_EXPORTER_OTLP_ENDPOINT` is set. When it is off every span call only runs the work it wraps, there
is no `x-trace-id` header and no `traceId` in log lines.

| Span | Where | Attributes |
|---|---|---|
| `http <METHOD> <route pattern>` | every request (`TracingMiddleware`) | `http.request.method`, `http.route`, `http.response.status_code`, `tenant.id`, `request.id` |
| `db acquire` | getting a connection from the pool | |
| `db <KEYWORD> [table]` (`db SELECT spins`, `db BEGIN`, `db COMMIT`) | every query, in `src/db.ts` | `db.statement` (SQL text without parameter values, at most 200 characters) |
| `ledger <method>` | each TigerBeetle ledger method | `ledger.result` (`reserved` or `insufficient` for reserve) |
| `platform issue A` / `find B` ... | calls to the casino platform | `tenant.id`, `http.response.status_code`, `platform.result`, `error.type` |
| `outbox <kind>` | each job run, a new trace of its own | `tenant.id`, `outbox.attempts`, `outbox.result` (`done`, `retry`, `dead`), `request.id` (`job:<kind>:<ref>`) |

- A span other than the http and outbox ones is made only when a span is already running. The outbox
  timer's own idle queries therefore leave no traces. Claiming a job row (BEGIN, SELECT) and writing its
  outcome are outside the `outbox` span.
- A failing call gets error status and the exception; the error goes on unchanged.
- Never recorded: secrets, tokens, `Authorization` or signature headers, request or response bodies, SQL
  parameter values. The tests scan every span of a full flow for the demo secrets and a player id.
- An incoming `traceparent` is continued. The response has `x-trace-id` (only when tracing is on).
  Calls to the casino carry `traceparent`.
- Join key: `request.id` on the http span is the `requestId` of the log lines and the `request_id` of the
  audit rows. Log lines written inside a span also have `traceId`. The audit table has no trace id.
- Turn on: `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP base address), `OTEL_SERVICE_NAME` (default
  `gamification`), `OTEL_TRACES_SAMPLE_RATIO` (0 to 1, default 1; decided once per trace at the root, so a
  sampled request keeps all its spans). `docker-compose.yml` sets them and starts Jaeger.
- If the collector is down the app works the same; the exporter drops the batch and writes one warning
  line a minute. Spans wait in a queue of 2048 and are sent every 5 seconds in batches of 512; when the
  queue is full new spans are dropped, counted, and the count is written once as a warning.
- Pending spans are flushed when the app shuts down.

## Tenant keys

Each tenant has two secrets that we use to check what comes in: the **event signing secret**
(`tenants.webhook_secret`: the casino signs deposit events with it, and platform B signs reward result
notices with it) and the **player token secret** (`tenants.token_secret`: the casino signs the player
token with it). The back office can replace each one. The casino's own manager does it for his own casino.

Rule: a signature is good if it is made with the current secret, or with the previous secret before its
time (`previous_until`) has passed. This is one function, `activeSecrets` in `src/tenants/active-secrets.ts`,
used by the platform A and B adapters and by the player token check. The time is the injected clock.
A bad signature gets the same 401 as before; the answer does not say which key was tried. Tenants are
read from the database on every request, so a replacement takes effect at once; there is no cache.

Columns on `tenants`, for each of the two: `<name>_prev`, `<name>_prev_until`, `<name>_rotated_at`
(`webhook_secret_*` and `token_secret_*`).

| Call | Answers |
|---|---|
| `GET /admin/:tenantId/keys` | `[{ kind: "event_signing" \| "player_token", hint, rotatedAt, previous: { hint, validUntil } \| null }]`. `hint` is the first 4 and the last 4 characters with `…` between. A previous key whose time has passed is `null`. Roles: all three (own tenant, platform admin any) |
| `POST /admin/:tenantId/keys/:kind/rotate` body `{ previousValidForSec }` (integer 0..86400, else 400) | 201 `{ kind, secret, hint, previous }`. Makes a new secret (`evs_` or `pts_` plus 32 random bytes in base64url). The old one becomes the previous one until now + `previousValidForSec`; with 0 it is dropped at once. The full `secret` is in this answer only. Roles: `tenant_admin` of the tenant, `platform_admin`; `tenant_viewer` gets 403 |
| `POST /admin/:tenantId/keys/:kind/revoke-previous` | 200 with one list item. Drops the previous secret now. Repeating it is 200 and changes nothing. Same roles as rotate |

`:kind` is `event_signing` or `player_token`; any other value is 404. A tenant that is not the caller's is
404, as everywhere in the back office. The path is `/admin/:tenantId/keys` like the other admin calls.

Two replacements at once: the tenant row is locked by the audit `update`, so they run one after the other
and both answer 201. The one that ran last is current; the one that ran first is its previous key (valid for
the time the second call asked for, dead at once if it asked for 0). The secret from before both is gone.

Audited: every replacement and every drop is one `update` of the `tenants` row, in one transaction with the
change, actor `admin/<user id>`, with the request id. The secret columns show as `***` (or null when empty),
never the value. The log has one line per replacement (`tenant.key_rotated`: tenant, admin, kind, seconds,
hint of the new secret) and one per drop (`tenant.key_previous_revoked`). No secret is in them.

Honest limits. The secrets are stored in the database as plain text, because HMAC needs the raw value. In
production they belong in a secrets store or encrypted at rest. Not built: replacing the wheel secret and the
platform API key. In the demo the fake casino learns a new secret by `PUT /control/tenants/:tenantId/secrets`
(see "Fake casino"); in real life the casino's engineer pastes it into the casino's configuration.

## Admin and operations

Code: `src/admin/` (guard, controller, plain logic in `stuck.ts`, `resolve.ts`, `audit-trail.ts`) and
`src/alerts/` (`alerts.ts`, `ops-policy.ts`). The playbook for the daily digest agent is
`docs/monitoring-playbook.md`.

Auth for every admin call: see "Admin sign-in and roles" below. There are no key headers. The
actor in the audit trail is `admin/<user id>`, taken from the signed token, never from a header or
the body. Every query filters by the tenant in the path, and the token must give access to it.

| Call | Answers |
|---|---|
| `GET /admin/:tenantId/audit?entityId=<id>` | `[{ id, at, actor, action, entityType, entityId, changes, requestId }]`, oldest first, this tenant's rows only; 400 without `entityId` |
| `GET /admin/:tenantId/redemptions/stuck` | `{ limitSec, items: [{ id, status, settled, playerExternalId, costCoins, ageSec, platformRef, lastPlatformCall }] }`: redemptions that are `created`, `reserved`, `submitting`, or final and not settled, created more than `pendingAgeLimitSec` ago (age from `created_at`), oldest first |
| `POST /admin/:tenantId/redemptions/:id/resolve` body `{ outcome: "issued" \| "refused", note }` | 200 with the redemption view; 404 if not this tenant's; 409 `{ message, view }` unless the status is `submitting`; 400 for a note outside 5..500 characters or another outcome |
| `GET /admin/:tenantId/alerts` | `{ at, policyVersion, alerts: [{ code, severity, subject, value, limit, detail }] }`; empty `alerts` when all is well; one critical `no_ops_policy` when the tenant has no ops policy |

Manual resolution goes through `confirm`, the same function as the platform's answers (lock order:
job row, then redemption row). Outcome `issued` sets platform ref `manual`; `refused` sets the
reason `manual: <note>`. The audit `record` `manual_resolution` (`{ outcome, note }`) is written in
the same transaction as the status change and only by the call that made the redemption final. The
ledger is settled by the normal path (inline when inline jobs are on, otherwise by the outbox job).

A platform answer that arrives after the redemption is final changes nothing. If its kind
(issued or refused) differs from the final status, an audit `record` `outcome_contradicted`
(`{ final, late, platformRef | reason }`) is written under the actor of the notice. An equal answer
writes nothing. A lost race of an admin's resolution is not a contradiction and writes no record.

`ops_policies` (versioned like `grant_policies`, append-only, one row per change, the newest version
applies): `{ pendingAgeLimitSec` 10..86400, `maxExpectedPrizeCoins` > 0, `maxSpinsPerPlayerPerDay`
1..1000, `maxPlayerRedeemShare` in (0, 1], `minRedeemedForShare` >= 0 `}`. Demo version 1 for both
tenants: 300, 100, 20, 0.5, 1000.

Alerts (all windows use the injected clock; all queries filter by tenant): `redemption_pending_too_long`
(critical), `outbox_dead_jobs` (critical), `wheel_expected_prize_high` (warning),
`wheel_paying_above_expectation` (warning; at least 200 used spins in 24 hours and a mean more than
25 percent above expectation), `many_spins_one_player` (warning), `player_redeem_share_high`
(warning), `outcome_contradicted` (critical).
Not built: the alert for a deposit reversed after its spin was used (the adapters have no reversal
event), and delivery of alerts to us and to the operator. The endpoint is what a scheduler or a
monitoring system would poll.

## Back office API

Read endpoints for the back office, plus the change of wheel settings. Auth: a signed admin token
(next section). Every query filters by the tenant in the path. Lists are newest first and take `limit` (1..100, default 50) and `before` (the `cursor` of the
last row of the previous page); they answer `{ items: [...], nextCursor: string | null }`. Coins are
strings. Times are ISO strings. Ids of rows that have a detail endpoint are our uuids.

| Call | Answers |
|---|---|
| `GET /admin/:tenantId/overview` | `{ at, players, events24h: { accepted, ignored }, spins: { available, used }, redemptions: { created, reserved, submitting, issued, refused, insufficient, unsettled }, coinsOutstanding: string \| null, outbox: { due, waiting, dead }, alerts: { critical, warning }, settings: { wheelVersion, grantPolicyVersion, opsPolicyVersion } }`. `coinsOutstanding` is null when the ledger does not answer |
| `GET /admin/:tenantId/redemptions?status=&playerId=` | items `{ id, createdAt, updatedAt, playerId, playerExternalId, itemCode, itemName, costCoins, status, settled, platformRef, reason, cursor }` |
| `GET /admin/:tenantId/redemptions/:id` | `{ redemption: <the item above>, reward, audit: [<audit rows, oldest first>], job: { runAt, attempts, lastError, doneAt, deadAt } \| null }`; 404 if not this tenant's |
| `GET /admin/:tenantId/players?q=` | items `{ id, externalId, createdAt, spinsAvailable, spinsUsed, redemptions, cursor }`; `q` matches the start of `externalId` |
| `GET /admin/:tenantId/players/:id` | `{ player: { id, externalId, createdAt }, balance: { available, reserved } \| null, spins: [{ id, status, coins, createdAt, usedAt, creditedAt, wheelVersion, grantPolicyVersion }], redemptions: [<items as in the list>], events: [<items as in the events list>] }` (the newest 50 of each); 404 if not this tenant's |
| `GET /admin/:tenantId/events?kind=` | items `{ id, externalEventId, kind, playerId, playerExternalId, receivedAt, normalized, cursor }` |
| `GET /admin/:tenantId/events/:id` | the item plus `raw` and `spins: [{ id, status }]`; 404 if not this tenant's |
| `GET /admin/:tenantId/spins?status=&playerId=` | items `{ id, playerId, playerExternalId, status, coins, segmentIndex, createdAt, usedAt, creditedAt, wheelVersion, cursor }` |
| `GET /admin/:tenantId/outbox?state=due\|waiting\|dead\|done` | items `{ id, kind, refId, runAt, attempts, lastError, doneAt, deadAt, cursor }` |
| `GET /admin/:tenantId/audit?entityId=` or `?recent=1&actor=&action=` | with `entityId`: as above. With `recent=1`: the list form, newest first, optional exact `action` and `actor` prefix |
| `GET /admin/:tenantId/settings` | `{ wheel: [{ id, version, createdAt, segments, expectedPrizeCoins }], grantPolicies: [{ id, version, createdAt, params }], opsPolicies: [{ id, version, createdAt, params }], storeItems: [{ id, code, name, costCoins, reward, active }], changes: [<settings changes, newest first, at most 50>] }` (versions newest first; `expectedPrizeCoins` is a number rounded to 2 places for display) |

### Changing the wheel: an intent that a policy confirms

A change of settings is an intent, like a redemption. The casino's representative proposes it; a
policy decides whether it is applied at once or waits for us; only we can approve what waits.

Table `settings_changes`: `id`, `tenant_id`, `kind` (`wheel_config`), `proposed` (jsonb), `status`
(`proposed`, `applied`, `rejected`), `expected_prize_coins` (numeric), `limit_coins` (numeric),
`proposed_by` (actor `admin/<user id>`), `decided_by` (actor `admin/<user id>` or `policy/ops-v<N>`), `decision_note`, `result_id`
(the new `wheel_configs` row), `created_at`, `decided_at`. Written through the audit functions.

| Call | Answers |
|---|---|
| `POST /admin/:tenantId/settings/wheel` body `{ segments: [{ label, coins, weight }] }` | Roles `tenant_admin` and `platform_admin`. Validates (2..24 segments; `label` 1..40 chars; `coins` integer 1..1000000; `weight` integer 1..1000000). Computes the expected prize. If it is at most `maxExpectedPrizeCoins` of the newest ops policy: creates the next `wheel_configs` version and answers 201 `{ change: { ..., status: "applied" }, wheelVersion }` with `decided_by` `policy/ops-v<N>`. Otherwise stores the change and answers 202 `{ change: { ..., status: "proposed" } }`. 400 for invalid segments; 409 when the tenant has no ops policy |
| `POST /platform/settings-changes/:id/approve` and `.../reject`, body `{ note }` (5..500 chars) | Role `platform_admin` only. Only for a change in status `proposed` (else 409). Approve creates the next wheel version and sets `applied`; reject sets `rejected`. A tenant's own admin cannot approve: 403 |
| `GET /platform/settings-changes?status=proposed` | Role `platform_admin` only: every tenant's waiting changes, oldest first |
| `GET /platform/tenants` | Role `platform_admin`: `[{ id, name, platform }]`. Other roles get only their own tenant |

Spins already granted keep the wheel version they were granted with. Two approvals of one change at
once apply it once.

## Admin sign-in and roles

The back office has real sign-in. A player is identified by a token the casino signs; an admin is
identified by a token WE sign after a password check.

Table `admin_users`: `id` uuid, `email` (unique, lower case), `name`, `password_hash`, `role`
(`platform_admin`, `tenant_admin`, `tenant_viewer`), `tenant_id` (null only for `platform_admin`),
`failed_logins`, `locked_until`, `disabled`, `created_at`. Written through the audit functions; the
hash is masked in the audit trail like the tenant secrets.

- Passwords: scrypt (`node:crypto`), a random salt per user, stored as `scrypt$N$r$p$salt$hash`,
  compared in constant time. A sign-in for an unknown email does the same amount of work.
- `POST /admin/auth/login` body `{ email, password }` -> 200 `{ token, expiresAt, user: { id, email,
  name, role, tenantId } }`; 401 with one fixed body for an unknown email, a wrong password, a
  disabled or a locked user. Five failures in a row lock the user for 15 minutes (by the injected
  clock); a success resets the count. Every attempt is an audit `record` (`admin_login`,
  `admin_login_failed`, with the email and no password).
- The token: JWT, HS256, signed with `ADMIN_TOKEN_SECRET` (env, required, at least 32 characters; the
  compose file sets a demo value). Claims: `sub` (user id), `role`, `tid` (tenant id or null),
  `name`, `iat`, `exp` (30 minutes), `aud` = `backoffice`. Sent as `Authorization: Bearer <token>`.
  A player token is not an admin token and the reverse: different secret, and `aud` is checked.
  On every request the user is loaded again: a disabled user's token stops working at once.
- `GET /admin/auth/me` -> the `user` object. There is no refresh; the page signs in again.

Roles (the check is one function, `can(admin, action, tenantId)`, in one file):

| Action | tenant_viewer | tenant_admin | platform_admin |
|---|---|---|---|
| Read anything of the own tenant | yes | yes | yes, any tenant |
| Resolve a stuck redemption | no | yes | yes |
| Propose a wheel change | no | yes | yes |
| Approve or reject a waiting change | no | no | yes |
| Replace a key, drop a previous key (see "Tenant keys") | no | yes | yes |
| See another tenant | no | no | yes |

A token for tenant A on a path of tenant B answers 404 (the same as an unknown tenant), not 403, so
the existence of a tenant does not leak. A missing or bad token answers 401. A known user without
the right answers 403.

Demo users (created by the demo seed; passwords are in `src/tenants/demo-tenants.ts` and the README):
`ops@demo.local` (platform_admin), `manager@alpha.demo` (tenant_admin, alpha-casino),
`viewer@alpha.demo` (tenant_viewer, alpha-casino), `manager@beta.demo` (tenant_admin, beta-casino).

The column `tenants.admin_key` and the headers `X-Admin-Key`, `X-Admin-Name`, `X-Platform-Key` are
removed.
