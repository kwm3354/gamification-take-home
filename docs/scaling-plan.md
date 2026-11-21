# From prototype to product

Answers to six questions about taking the prototype to production. Every position here is a
decision recorded in `docs/ai-log.md` or stated by me since. "Built today" means it is in this
repository and covered by tests. "Designed, not built" means it exists only as a decision or a
document. Question 4 has its own file, `docs/90-day-plan.md`.

## 1. "How would you evolve this prototype into a production-ready multi-tenant SaaS?"

First three steps: backups with a restore that is tested and includes the ledger; load tests in an
environment like production; and the route isolation test kept mandatory in CI. A secrets store
and schema migrations are not on this list because they are basic hygiene: production is not
possible without them at all.

Why these three. A restore that was never run is not a backup, and the ledger is a second store
that must be restored to the same point as PostgreSQL. The load numbers we have come from one busy
development machine (`docs/performance.md`); production needs its own. Tenant isolation is enforced
in code, so the test that walks every route and forces a decision for each one is what keeps a new
route from leaking another tenant's data. I prefer that to row-level rules in the database.
Database rules, or a separate database per casino, come only when a client's contract requires them.

What supports it today:

- Every table carries `tenant_id`, and every query filters by it (`src/schema.sql`). Isolation is
  tested on the player API, on every back office list and detail, on tenant keys and inside every
  alert test (`docs/failure-table.md`). The route-walking test is being added; see
  `docs/verification.md`.
- In the ledger, each tenant has its own TigerBeetle `ledger` number, so accounts of two tenants
  can never be in one transfer (`docs/contracts.md`, "Ledger").
- Coins move with ids derived from the spin or redemption id, so repeating a step after a crash
  is safe.
- No transaction is open while we call the casino or the ledger. Outbox jobs are claimed by a lease,
  so workers scale by count: `ROLE=worker` processes, two in compose, more with
  `docker compose up --scale worker=N`. With one, two and four workers the time to finish 500
  queued redemptions after the last request was 7.1 s, 3.4 s and 1.8 s, on a busy development
  machine, one run each (`docs/performance.md`, "Workers").
- The audit trail is written in the same transaction as each change, and a trigger forbids UPDATE
  and DELETE on `audit_log`.
- Settings are versioned rows, not edits in place (`wheel_configs`, `grant_policies`,
  `ops_policies`).
- Back office sign-in with roles, tenant key replacement, structured logs with a request id,
  deterministic alerts as SQL, and traces in Jaeger.
- CI runs every test against the official TigerBeetle image and starts the whole stack with
  Docker Compose (`.github/workflows/ci.yml`).

What is missing:

- There are no backups and no restore procedure, for PostgreSQL or for TigerBeetle.
- Tenant secrets are plain text in `tenants`. The schema is applied from `src/schema.sql` with
  `IF NOT EXISTS`, which is not a migration tool.
- A production environment in the cloud, with backups and monitoring, is part of the MVP
  (question 5).
- A connection pooler in front of PostgreSQL. It belongs to the step with many processes, when the
  sum of their pools approaches what PostgreSQL allows.
- Kafka (or another broker) in front of the intake. Today's measured numbers do not justify it for
  throughput (`docs/performance.md`, section 6). It stays in the production plan as an availability
  measure: accept casino events while the core is down.

## 2. "How would you support 10 casino operators without maintaining 10 separate codebases?"

One codebase. Differences between operators are versioned settings (policies), not code, and
adapters are per platform, not per operator: two casinos on the same platform use the same adapter
with different settings.

A change of settings is an intent, like a redemption. The casino's representative creates it. A
policy decides whether it is applied automatically or waits for us. For a wheel change the rule
looks at the expected prize of one spin: within the limit we set for that casino, the change is
applied at once; above it, it waits for a platform admin. Which policies apply to which casino is
decided only by us.

Built today:

- The wheel change as an intent: `POST /admin/:tenantId/settings/wheel` by the casino's
  `tenant_admin`, applied at once or left as `proposed` by the ops policy's
  `maxExpectedPrizeCoins`; approve or reject by a `platform_admin`; a back office screen for both.
- Grant policy: how many spins a deposit gives (minimum amount, currencies, spins per deposit) is
  a versioned parameter set in `grant_policies`, decided by the pure function `spinsForDeposit` in
  `src/policies/grant-policy.ts`, with hard limits in a validator. Each spin stores the policy
  version it was granted under. A new condition is one more field, one more check and one more
  test row.
- Ops policy: alert thresholds and log verbosity per tenant, versioned, in `ops_policies` and
  `src/alerts/ops-policy.ts`. Tests show that a new version changes the result for one tenant and
  not for the other.
- Versioned wheel configs (`wheel_configs`). A spin uses the config it was granted with.
- Tenant keys: the casino's admin replaces its own event signing secret and player token secret,
  with the old one valid for a time it chooses.
- Two platforms with different behaviour behind one domain model: platform A answers a reward
  request at once, platform B accepts it and reports later by webhook (`src/integrations/`). Both
  are translated into the same three outcomes: issued, refused, not known yet.

Designed, not built:

- The same intent for grant and ops policy versions. Today those are inserted only by tests and the
  seed.
- A console a casino's manager can be given alone, beyond the back office screens above.

## 3. "How would you introduce PvP, Missions, and Kingdom Builder without coupling every feature to the casino integration layer?"

Games do not see the casino. Adapters turn platform events into domain events, and games subscribe
to those; a game never calls a platform. It does one of two things: it moves coins in our ledger, or
it creates a reward intent, and one shared mechanism delivers that intent to the platform.

What supports it today:

- Ports and adapters: the domain declares the ports (`src/domain/casino-platform.ts`,
  `src/domain/coin-ledger.ts`); nothing outside `src/integrations/` knows a platform's field names.
- The redemption is that shared delivery mechanism: one intent, one `confirm`, and the same
  outbox job for both platforms. It handles a lost answer, a lost callback, a timeout, 429
  and 500, and a crash between steps (`docs/failure-table.md`).
- The wheel is the first game built this way. It reads deposit events and moves coins; it never
  talks to the casino.

PvP. I would design a contest for n players (n > 1) from the start, not a duel of two. The stakes of
a running contest sit on the contest's own account in the ledger. A contest ends with its own domain
event, "contest finished". A contest that does not fill is cancelled and the stakes go back to the
players, unless the business decides otherwise.

Missions are in the MVP (question 5), but there is no decision on their rules yet. They follow the
same two rules: a mission subscribes to domain events, and its reward is coins or a reward intent.

Kingdom Builder is left for after the MVP, and I have no decision on how it works. Whatever its
mechanics, it follows the same two rules.

Modules versus services. Adding a game that subscribes to events needs module boundaries, not
microservices. It is a modular monolith. A part becomes a separate service only when there is a
clear reason. There are three such parts:

| Part | Separate because | State today |
|---|---|---|
| Ledger (TigerBeetle) | It holds coins, with its own guarantees | Built, separate server |
| Intake of casino events, queued, with consumers | It must accept events while the core is down | Built inside the app; queue and consumers designed, not built |
| Gateway for real-time player connections | Long-lived connections (live leaderboards) should be held by a dedicated server (for example Centrifugo), fed over publish and subscribe, not by the application that moves coins | Designed, not built |

I do not want microservices for their own sake. The outbox workers already run as separate
processes, but they are the same application started with another `ROLE`, not a service of their
own.

Missing: domain events as a published stream (today the intake calls the deposit logic directly),
the contest model, the gateway.

## 4. "What would your first 90 days look like?"

The test plan first, the integration with the first casino run as a managed project, and a pilot as
early as possible: narrow by the end of month 1, wider in month 2, all players and A/B tests in month
3. The details are in `docs/90-day-plan.md`.

I do not promise a go-live date, because it depends on the casino too. My own estimate is that three
months are enough for the integration with a first real platform. I am new to this industry, and the
plan says so.

## 5. "What is the smallest realistic engineering team required to deliver an MVP within six months?"

Three people: a product owner, one engineer (me), and a competent QA, all working with AI agents. A
designer with experience in this field joins when the widget needs design work.

The MVP is what a first real casino needs to go live:

- the wheel and the bonus store;
- an integration with that casino's real platform;
- missions;
- our back office;
- a player widget fit to show on a casino's site;
- a production environment in the cloud, with backups and monitoring.

Left for later: contests, Kingdom Builder, a console a casino's manager uses alone, a second casino
on another platform.

The widget has no frontend engineer behind it. It is made by the product owner with agents, or by a
designer with experience in this field. The condition is that its source stays code we can change,
not a finished artefact we cannot edit.

The weak point is plain: there is one engineer. My answer is that the system is built so that most
incidents do not need that engineer:

- It fails safe. A stuck redemption is reserved coins, not lost coins: they stay reserved and
  visible until the casino answers (`docs/failure-table.md`).
- Alerts and manual resolution need no engineer. The stuck list, the resolve call and the
  deterministic alerts are built today (`src/admin/`, `src/alerts/`). A manual resolution goes
  through the same `confirm` as a platform's answer.
- Every action is audited, with the signed-in admin as the actor.
- The product owner handles incidents with agents, through MCP tools on the same entry points the
  back office uses, both to read and to act. The same role checks and the same audit trail apply.
  This is designed, not built.
- Who reacts and when is a team agreement. I do not want to impose an on-call rota from day one.

## 6. "Which parts of the development process would you automate using AI?"

Daily digests, code review during development, and MCP tools for product analytics and for
resolving incidents. People keep product decisions, acceptance of the work, and agreements with the
casino.

- Digests. A daily digest written by an agent from a playbook of checks
  (`docs/monitoring-playbook.md`; written, not run). Its first question is "are we losing money
  right now, for any reason". The agent reads whole objects with read-only access. The alerts
  themselves are deterministic SQL, not a language model; the agent looks for what nobody foresaw.
- Code review during development.
- MCP tools for product analytics and for incidents (see question 5).

What was done with AI in the prototype is logged in `docs/ai-log.md`. In short: agents wrote code
from a written contract (`docs/contracts.md`), each on its own branch with its own files; the main
session kept the decisions, the briefs and the review of what came back. Agents broke the code on
purpose to check that the tests notice; when a break was not caught, a test was added. Interface
variants for the player page were made with agents.

## The playground as part of the product

The test stand built for the prototype should be part of the product, not thrown away. It is built
first for sales: a demonstration that works without an engineer in the room. Integrators come next,
then our own adapter tests. A clear playground also makes estimates more accurate and shows quickly
what is exchanged with a platform and how an integration goes.

Built today: the fake casino plays both platforms with scripted and seeded faults
(`src/fake-casino/`). Its control page (port 30081) sets faults in plain words, shows the casino's
own record of grants and requests, and checks that record against what our system shows for every
player. The web app at `/app/` has a player page and the back office; the player page's "behind the
scenes" link opens that player's page in the back office.
