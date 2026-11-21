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

## Actors and audit

Every create, update and delete of a row in `players`, `inbound_events`, `spins`, `redemptions`,
`store_items`, `wheel_configs`, `grant_policies`, `ops_policies`, `tenants` goes through `src/audit/audited.ts`, inside the caller's
transaction. There is no other write path to these tables.

```ts
type AuditContext = { tenantId: string | null; actor: string; requestId?: string };
// actor: "platform/<tenantId>", "player/<playerId>", "system/<name>", "admin/<name>", "unknown"

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
- Per tenant: an `issuer` account (code 10) and a `redeemed` account (code 20). Per player: one
  account (code 1) with the flag `debits_must_not_exceed_credits`, so the ledger itself refuses a
  negative balance.
- Account and transfer ids are the first 16 bytes of SHA-256 of a string, as a u128:
  `acct:<ledgerNo>:issuer`, `acct:<ledgerNo>:redeemed`, `acct:<ledgerNo>:player:<playerId>`,
  `xfer:prize:<spinId>`, `xfer:reserve:<redemptionId>`, `xfer:capture:<redemptionId>`,
  `xfer:release:<redemptionId>`.
- Prize: issuer -> player, posted. Reserve: player -> redeemed, pending, no timeout. Capture posts
  the pending transfer; release voids it.
- Accounts are created on first use; "exists" is success.
- A repeated id with the same content is success. A reserve that failed for lack of coins stays
  failed for that redemption id (the ledger remembers the id), which is what we want.
- `available = credits_posted - debits_posted - debits_pending`; `reserved = debits_pending`.
- `outstanding` = issuer `debits_posted` minus redeemed `credits_posted`.
- Every call has a time limit (env `LEDGER_TIMEOUT_MS`, default 2000) and throws `LedgerUnavailable` after it.

## Outbox

`src/outbox/outbox.ts`, token `OUTBOX`.

```ts
enqueue(tx, job: { tenantId: string; kind: string; refId: string; runAt?: Date }): Promise<void>
  // one row per (kind, refId); enqueueing again makes an existing row due now and not done
handle(kind: string, fn: (job: { tenantId: string; kind: string; refId: string; attempts: number }) => Promise<"done" | { retryInMs: number }>): void
runDue(): Promise<number>   // claims due jobs (FOR UPDATE SKIP LOCKED, ordered by run_at), runs them, returns how many ran
drain(maxRounds = 20): Promise<void>  // runDue until nothing is due now; for tests
```

A handler that throws is retried with a delay of 1 s, 2 s, 4 s, ... up to 60 s; after 10 attempts
the job gets `dead_at` and stays visible. In the running app a timer calls `runDue` every 500 ms
(off when `OUTBOX_TIMER=off`, which tests use; they call `runDue` and move the clock).

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
| `POST /store/redemptions` with header `Idempotency-Key`, body `{ "itemId" }` | 201 (first time) or 200 (repeat) `{ "id", "status", "costCoins", "reward", "reason" }`; 400 without the key; 404 unknown item |
| `GET /store/redemptions/:id` | the same object; 404 if not this player's |

Admin, `X-Admin-Key` = the tenant's `admin_key`: `GET /admin/:tenantId/audit?entityId=` returns the
audit rows of that tenant for one entity.

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
  event dedup keep a repeated deposit from adding spins. With 0 spins the event still counts as
  accepted and one audit `record` is written: action `spin_not_granted`, entity type `inbound_event`,
  entity id the event row id, changes `{ reason, grantPolicyId }`.
- Not built: conditions that need history (spins per player per day), an API or admin screen to
  create a version (tests and the seed insert rows through `create`).

## Redemption: one intent, two steps

Statuses: `created -> reserved -> submitting -> issued | refused`, or `created -> insufficient`.
`issued` and `refused` are final for the player; `settled_at` says the ledger has caught up.

`POST /store/redemptions` creates the row (`created`) and the job `redemption_advance` in one
transaction, then runs the job at once and returns the current state. A repeated key returns the
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
- `POST /control/reset`.

Secrets and keys of the demo tenants are fixed strings in one small file,
`src/tenants/demo-tenants.ts` (plain data, no imports). The seed and the fake casino both read it.

## Admin and operations

Code: `src/admin/` (guard, controller, plain logic in `stuck.ts`, `resolve.ts`, `audit-trail.ts`) and
`src/alerts/ops-policy.ts`.

Auth for every admin call: header `X-Admin-Key` equals the `admin_key` of the tenant in the path
(timing-safe compare). An unknown tenant and a wrong key both give 401 with the same body. Header
`X-Admin-Name` (optional, `[a-z0-9._-]{1,40}`, default `admin`) makes the actor `admin/<name>`.
Every query filters by the tenant in the path.

| Call | Answers |
|---|---|
| `GET /admin/:tenantId/audit?entityId=<id>` | `[{ id, at, actor, action, entityType, entityId, changes, requestId }]`, oldest first, this tenant's rows only; 400 without `entityId` |
| `GET /admin/:tenantId/redemptions/stuck` | `{ limitSec, items: [{ id, status, settled, playerExternalId, costCoins, ageSec, platformRef, lastPlatformCall }] }`: redemptions that are `created`, `reserved`, `submitting`, or final and not settled, created more than `pendingAgeLimitSec` ago (age from `created_at`), oldest first |
| `POST /admin/:tenantId/redemptions/:id/resolve` body `{ outcome: "issued" \| "refused", note }` | 200 with the redemption view; 404 if not this tenant's; 409 `{ message, view }` unless the status is `submitting`; 400 for a note outside 5..500 characters or another outcome |

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
