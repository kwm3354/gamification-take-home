# Gamification service for casino operators: a working slice

A casino tells this service that a player made a deposit. The player gets a spin of a Wheel of Fortune
and wins coins. The coins are kept in a ledger. The player spends coins in a bonus store, the service
asks the casino to issue the bonus, and the final status is visible through the API. Two simulated
casinos with different APIs go through the same internal logic.

This is a prototype built in one working day. The part about money-like coins and the reward request
is built to be correct under failure and is tested that way. The rest is as wide as the day allowed,
and this page says plainly what is real, what is simulated and what is not built.

Where to look:

| What | Where |
|---|---|
| Architecture, with diagrams | `docs/architecture.md`, `docs/img/service.svg`, `docs/img/redemption.svg` |
| What happens on each failure, and the test that proves it | `docs/failure-table.md` |
| The contract the code was built from | `docs/contracts.md` |
| Sample requests and responses | `docs/samples.md` |
| How it is verified | `docs/verification.md` |
| Measured performance | `docs/performance.md` |
| Scaling questions | `docs/scaling-plan.md` |
| First 90 days | `docs/90-day-plan.md` |
| AI-development evidence: every decision, who made it, how it was checked | `docs/ai-log.md` |
| The briefs given to AI agents and their reports | `docs/agent-briefs/` |
| Rules the agents work under | `CLAUDE.md`, `.claude/skills/verify/SKILL.md` |
| A short presentation video | `docs/video/presentation.mp4` |

## The task in my own words

Build the money-like core of a gamification product and show it survives the ways an integration
fails. Concretely:

1. Two casino operators (tenants) on two different platforms. Platform A answers a reward request
   at once and accepts an idempotency key. Platform B accepts the request and reports the result
   later by a webhook, and has no idempotency key.
2. A deposit event from the casino gives the player a spin. The server picks the prize.
3. Coins are a ledger: every coin has a source and an owner, and no balance goes below zero.
4. A redemption takes coins and asks the casino for a bonus. The casino may answer late, twice or
   never. The player must not pay twice, must not get two bonuses, and must not lose coins for a
   bonus that was not issued.
5. Explain how this grows into a product: more operators, more mechanics, a team, 90 days.

## What must never happen

These seven rules are what the tests check. For rules 3 to 6 there is a judge (`test/judge.ts`): it
trusts only the casino's own record and the ledger. It reads our redemption rows only to learn what
we claim, and checks each claim against those two. Rules 1, 2 and 7 are checked by ordinary tests
of the intake and the wheel.

1. One deposit gives more spins than the grant policy of its time allows.
2. One spin gives more than one prize, or a prize the client chose.
3. A coin balance goes below zero.
4. One redemption reserves or debits coins twice, or the casino issues its reward twice.
5. Coins are debited and no reward was issued, or the reverse, once everything has settled.
6. One tenant sees or changes anything of another tenant.
7. An event without a valid signature changes anything.

## The coins are not in PostgreSQL

The coin ledger is **TigerBeetle**, a database built only for double-entry accounting. PostgreSQL
keeps everything else. This is the most unusual decision in the project, so here it is in full.

**Why.** Coins behave like money: they are won, reserved, spent, given back. A ledger written by
hand in SQL is where such products get their worst bugs (a balance column updated twice, a debit
without its credit, a race that goes below zero). TigerBeetle guarantees a correct ledger by
construction, has headroom far above this load, and took most of the ledger work off the table, so
the day went into the product.

**How the model maps onto it** (`src/ledger/coin-ledger.tigerbeetle.ts`, port in
`src/domain/coin-ledger.ts`):

| In the product | In the ledger |
|---|---|
| A casino (tenant) | Its own `ledger` number. Accounts of two casinos can never be in one transfer. |
| A player's coins | One account with the flag "debits must not exceed credits". The ledger itself refuses a negative balance; our code cannot get it wrong. |
| A prize from the wheel | A transfer from the casino's issuer account to the player. |
| A redemption starts | A **pending** transfer from the player back to the issuer: the coins are reserved, not spent. |
| The casino issued the bonus | The pending transfer is **posted**. |
| The casino refused | The pending transfer is **voided**: the coins are back. |
| Coins owed to all players of a casino | The balance of ONE account, the issuer. Not a sum over players. |

Every coin has a source and an owner, and the two-step transfer is exactly the life of a
redemption.

**Two stores, no shared transaction.** The decision and a job are written to PostgreSQL in one
transaction. Then the job makes the ledger transfer. The transfer's id is derived from the id of
the decision (a hash of `xfer:prize:<spin id>`, `xfer:reserve:<redemption id>` and so on), so running the
job twice moves nothing the second time. If the process dies between the two stores, the job is
still in PostgreSQL and a worker repeats it.

**What it costs, honestly.** A second store to run and back up. No SQL: lists and reports read
PostgreSQL, the ledger is asked only for balances. The server needs a CPU with AVX2 and io_uring
(hence one extra line in `docker-compose.yml`). I set myself two conditions before using it:
prove the official image on other hardware in the first hour (done on a CI runner at 11:13), and a
deadline for the integration with a fallback to a ledger table in PostgreSQL (not needed).

## How it is built, in one screen

- **One domain, one adapter per casino platform.** There are many casinos and one domain logic.
  An adapter turns a platform's events and answers into three domain outcomes of a reward request:
  issued, refused, or not known yet. Code: `src/domain/`, `src/integrations/`.
- **A redemption is an intent.** created → reserved → submitting → issued or refused. The platform
  that answers at once is the same model with two steps taken at once. One function confirms the
  outcome, whoever brings it: the platform's answer, its webhook, our own look-up, or an admin.
  Code: `src/store/redemption.ts`.
- **Coins are reserved, not spent, until the casino answers.** Coins must not disappear while the
  casino has not answered. A refusal releases the reserve; an issue captures it.
- **Look first, then repeat.** After an unknown outcome we ask the casino whether the reward exists
  before sending the request again. On a platform without idempotency this is the only thing that
  prevents a second bonus.
- **The ledger is TigerBeetle**, see the section above. Code: `src/ledger/`, `src/outbox/`.
- **Workers scale by count.** A job is claimed with a lease in one short statement, the casino and
  ledger calls run with no database transaction open, and only the holder of the lease writes the
  outcome.
  The queue is a table in PostgreSQL on purpose: a job is written in the same transaction as the
  decision that needs it. Handlers do not know who calls them, so a broker can be put after the
  table later (`docs/scaling-plan.md`, answer 1).
- **The server picks the prize.** The outcome is computed from a secret of the tenant and our spin
  id; the wheel's configuration is versioned and pinned when the spin is granted. The page only
  shows the result.
- **Differences between operators are versioned settings, not code.** Grant rules, limits and the
  wheel are rows with versions. A casino's admin proposes a new wheel; a policy applies it at once
  if the expected prize is within the limit, otherwise it waits for us.
- **Everything that changes is audited** in the same transaction, with who did it and the request
  id. The audit table accepts no update or delete.
- **Operations:** a back office with sign-in and three roles, alerts as plain SQL, a list of stuck
  redemptions with a manual resolution that goes through the same confirm function, replaceable
  signing keys, structured logs, traces.

## Run it

Needs Docker with Compose. This starts PostgreSQL, TigerBeetle, the API, two workers, the fake casino
and a trace viewer, then asks the API if it is healthy:

```
docker compose up -d --build --wait
curl http://127.0.0.1:30080/health
```

The answer is `{"ok":true,"postgres":"ok","ledger":"ok"}`.

Then open three pages in a browser:

- http://localhost:30080/app/ is the player page: a Wheel of Fortune you can spin, your coins and the
  reward store, as it would sit on a casino's site. "Deposit" at the top right stands for the casino
  telling us about a deposit. The link "See what happened behind the scenes" under the widget opens
  this player in the back office.
- http://localhost:30080/app/#/admin is the back office. It needs a sign-in. The sign-in page lists the
  demo users as buttons that fill the form. It reads everything from the server: overview, alerts,
  redemptions (with the manual resolution of a stuck one), players, events, spins, settings (a proposal
  for a new wheel, and replacing a casino's signing keys), waiting changes for the platform admin, outbox and audit. The player page
  and the back office are one app with two routes and share no state.
- http://localhost:30081/ is the casino control panel. It makes the casino misbehave (ten scenarios in plain
  words), shows what the casino really issued and checks that no bonus was issued twice and no coins were lost.

Demo users of the back office (the demo seed creates them; the sign-in page also lists them):

| Email | Password | Role | Tenant |
|---|---|---|---|
| `ops@demo.local` | `demo-ops-password-1` | platform admin | all, can approve waiting changes |
| `manager@alpha.demo` | `demo-alpha-manager-1` | tenant admin | alpha-casino |
| `viewer@alpha.demo` | `demo-alpha-viewer-1` | tenant viewer, read only | alpha-casino |
| `manager@beta.demo` | `demo-beta-manager-1` | tenant admin | beta-casino |

Five wrong passwords lock a user for 15 minutes. Sign in from the command line and use the token:

```
curl -s -X POST http://localhost:30080/admin/auth/login -H 'content-type: application/json' \
  -d '{"email":"ops@demo.local","password":"demo-ops-password-1"}'
curl -s http://localhost:30080/admin/alpha-casino/overview -H "authorization: Bearer $TOKEN"
```

The first call answers `{ token, expiresAt, user }`; the token lasts 30 minutes.

Sample requests are in `docs/samples.md`.

Traces: open http://localhost:30086 (Jaeger), pick the service `gamification` and press "Find Traces".
Each request is one trace; the response header `x-trace-id` is its id. A redemption on platform A shows
`ledger reserve`, `platform find A`, `platform issue A` and `ledger capture` under one
`http POST /store/redemptions` span, with every database call and its time. Platform B's later steps are
traces of their own named `outbox redemption_advance`. Jaeger keeps at most 10000 traces in memory.
Set `OTEL_TRACES_SAMPLE_RATIO` (0 to 1) to trace only a share of requests, for a load run. Details are in
the "Tracing" section of `docs/contracts.md`.

To look at the screens without the stack: `npm run web:build`, then `node web/dev/mock-server.mjs` and open
http://localhost:4800/app/. The mock is a development aid built from `docs/contracts.md`, not the service.

More workers: `docker compose up -d --scale worker=4`. Workers are the same image started with
`ROLE=worker`; they take jobs from the outbox and can be added or removed at any time.

Stop and delete the data:

```
docker compose down -v
```

Run the checks (typecheck, lint, tests). Needs Node.js 22. The tests start their own PostgreSQL
in Docker and use the TigerBeetle from Compose:

```
npm ci
docker compose up -d --wait tigerbeetle
TB_ADDRESS=127.0.0.1:30009 npm run verify
```

The web app (`web/`) is built in the app image. To check it on its own: `npm run verify:web`
(installs, type-checks, runs its unit tests and builds).

These commands are the ones CI runs on every push (`.github/workflows/ci.yml`), on a GitHub
runner with the official images.

The TigerBeetle server and its Node.js client need a CPU with AVX2 and Docker that allows
io_uring (hence `seccomp=unconfined` in `docker-compose.yml`). On a CPU without AVX2 see
`scripts/tb-old-cpu.sh`.

## Design

See `docs/architecture.md`.

## What is real, what is simulated, what is not built

**Real:** the application (NestJS, TypeScript), PostgreSQL 16, TigerBeetle 0.17.9 with its official
client, Docker Compose, CI on GitHub Actions; signatures, player tokens, deduplication, the redemption
state machine, the outbox with leases, the audit trail, alerts, logs, traces, the back office and the
player page. The tests run over real HTTP, a real PostgreSQL and a real TigerBeetle.

**Simulated:** both casino platforms (`src/fake-casino/`, one process, state in memory). The
simulation is kinder than a real platform in these ways:

- Platform B's look-up shows a request as soon as the request was accepted. If a real platform lags,
  "look first" sees nothing and we would issue a second bonus. Our side cannot close this alone; it
  has to be agreed with the platform. This is the weakest assumption in the project.
- Platform A keeps the first answer for an idempotency key for as long as its process runs.
- Both platforms can find a reward by our reference.
- Amounts have two minor digits in every currency.
- The player id in events and in the player token is the same stable id.
- A platform never changes a final answer. If it does, we record the contradiction and raise an
  alert; we do not move coins on our own.
- A deposit is never reversed.

**Not built:** a real casino platform; missions and other mechanics; a queue in front of the event
intake; the real-time gateway; coin expiry; revoking a reward; deposit reversals; delivery of alerts
to people; the run of the daily digest agent (its playbook is written: `docs/monitoring-playbook.md`);
rate limiting; a secrets store (secrets are plain text in the database); schema migrations (the
schema is applied as one idempotent file); password reset and token refresh for admins; replacing the
wheel secret and the platform API key; a second lock for tenant isolation inside the database.

**Where it runs:** CI runs the tests and starts the whole compose stack on a GitHub-hosted Linux
runner with the official images on every push. (Several runs today were red because of one test
with a wall-clock limit; the log has the story.)
Not proven: Docker Desktop on macOS or Windows, and hosts where io_uring is disabled. TigerBeetle
needs io_uring, which Docker's default security profile blocks, hence `seccomp=unconfined` in
`docker-compose.yml`.

## Priorities: what I chose to do in the time, and why

1. **The first hour had no code.** I restated the task, wrote the list of what must never happen
   and made the product decisions one at a time. That list became the judge.
2. **The reward request first, and correctly.** Duplicates, lost answers, timeouts, refusals,
   crashes between the two stores. This is where a product like this loses money, so it got the
   most tests.
3. **Then operations:** audit from the start, a back office that can see and resolve a stuck
   redemption, alerts, logs, traces. A system that issues value has to be explainable afterwards.
4. **Then measurement.** The first load run found a design mistake of mine: the outbox ran casino
   and ledger calls inside a database transaction. It was replaced with leases and measured again
   (`docs/performance.md`).
5. **What I left out on purpose:** more mechanics, a real integration, database-level isolation.
   They are in the plan, not half-built.

The prototype is wider than the task asked. The core (points 1 and 2) is the part I would defend
line by line; the rest shows the direction.

## Assumptions I made where the task did not say

- The wheel is our widget on the casino's site. The player's browser talks to us with a short-lived
  token signed by the casino; we never see a password.
- One successful deposit gives one spin by default. The rule is a versioned setting per casino
  (minimum amount, currencies, spins per deposit).
- A deposit event is trusted only by its signature. Each platform signs in its own way.
- A spin's prize is fixed by the server at the moment of the spin; the wheel's configuration is the
  one in force when the spin was granted.
- A redemption that the casino has neither issued nor refused stays open and visible. We do not
  time it out into a refusal on our own: whether to refund or keep waiting is an agreement between
  our business and the casino. After a limit from the settings it raises an alert, and an admin
  can resolve it by hand, with an audit record.
- Automatic recovery uses the platform's status look-up, so it works only where the platform has one.
- Personal data: we keep the casino's player id and nothing else about the person.
- The simulated platforms' assumptions are listed in the section above.

## How it is verified

The approach is in `docs/verification.md`; the short version:

- **A fake outside world with faults.** The fake casino can answer with an error, rate-limit, refuse,
  lose the request, lose its answer, answer slowly, and for platform B lose, repeat or delay the
  result message.
- **A judge** that trusts only the casino's record and the ledger, for the rules about coins and
  rewards (3 to 6).
- **Flow tests** from the first request to the judge's verdict, one per failure that matters. Each
  row of `docs/failure-table.md` names its test, or says "not tested".
- **A clock the tests move.** Tests do not sleep, except the few that check that calls overlap in
  real time.
- **Breaking the code on purpose.** Every piece of work had to show a test failing when a guard was
  removed. Results are in `docs/ai-log.md` and the agents' reports.
- **A measurement, not a quoted number.** `docs/performance.md` has the runs, the conditions and
  what was not measured.

Known weak points of the verification: everything outside is simulated; one test of the back
office overview compares counts while jobs may still be running and has failed under heavy load on
the development machine; the screens were checked in a real browser by hand and by scripts, not by
an automated browser suite.

## Likely changes, and where they go

| Change | Where |
|---|---|
| A third casino platform | a new adapter in `src/integrations/` implementing `CasinoPlatform` (`src/domain/casino-platform.ts`), registered in `src/integrations/platforms.ts`; the platform name is also listed in `src/tenants/tenants.ts` and in a `CHECK` on `tenants.platform` in `src/schema.sql` (an existing database keeps the old `CHECK`: there are no migrations); a twin in `src/fake-casino/` |
| A different rule for granting spins | `src/policies/grant-policy.ts` (`spinsForDeposit`) and the fields of a grant policy version |
| Wheel segments, weights, store items of the demo | `src/tenants/demo-tenants.ts` |
| How the prize is picked | `src/wheel/pick-segment.ts` |
| A new step or outcome of a redemption | `src/store/redemption.ts` (`step`, `confirm`) |
| A new kind of event from a casino | the platform's adapter (`parseEvents`) and `src/events/` |
| A new alert | `src/alerts/alerts.ts` |
| Who may do what in the back office | `src/admin/permissions.ts` (`can`) |
| A new table or column | `src/schema.sql`; writes go through `src/audit/audited.ts` |
| A new back office page | `web/src/sections/` |

Any new HTTP route must also be placed in the tenant isolation test (`test/tenant-isolation.test.ts`),
which fails until a decision is made for it.

## How this was made

I worked with AI agents the whole day and did not read the code line by line. My part was the
decisions, the direction and the checks; this is how it went:

- **I made the product and architecture decisions**, one question at a time, before any code. They
  are marked "Author" in `docs/ai-log.md`: the ledger in TigerBeetle, ports and adapters, the
  redemption as an intent with one confirm function, reserve instead of debit, audit from the start,
  settings changes as an intent with a policy, alerts as deterministic SQL, manual resolution with
  audit, real sign-in for the back office, workers that scale, key replacement, the shape of the
  tenant isolation test.
- **A main session wrote the contract** (`docs/contracts.md`, the schema, the domain interfaces) from
  those decisions. **Coding agents built from written briefs**, each in its own branch with its own
  list of files, and had to report: what was built, what can break, which test catches it, and what
  happened when they broke the code on purpose. The briefs and reports are in `docs/agent-briefs/`.
- **After each piece I got a short summary** in place of a code review: what it does, what can
  break, which test shows it. When I asked "what happens if", the answer had to come from a run.
- **How the AI's output was checked:** `npm run verify` before every commit; the judge; mutation
  checks; CI on other hardware; a load measurement; my own look at the pages.
- **Where the AI was wrong and how it was found:** the log keeps these. Examples: an outbox that
  held a transaction across network calls (found by measurement); a back office first protected by
  shared key headers (I rejected it); two ledger accounts per tenant where one gives the total owed
  as a single balance (found in review); a first demo page nobody could understand (I rejected it);
  a test that demanded more than the system promises (found by CI); drifting away from the
  verification approach in the afternoon (I noticed, and two missing kinds of test were added).

