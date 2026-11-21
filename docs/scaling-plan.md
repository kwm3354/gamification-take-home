# From prototype to product

Answers to Part E of the assignment. Every position here is a decision recorded in
`docs/ai-log.md`. "Built today" means it is in this repository and covered by tests. "Designed, not
built" means it exists only as a decision or a document. Question 4 has its own file,
`docs/90-day-plan.md`.

## 1. "How would you evolve this prototype into a production-ready multi-tenant SaaS?"

I would do three things first: make the database enforce tenant isolation, set up backups with a
restore that is tested and includes the ledger, and run load tests that give real numbers. I chose
these three because they are the hardest to add once real casinos and real coins are in the
system. A secrets store for tenant secrets and database migrations are not on this list. They are
basic hygiene: production is not possible without them at all.

What supports it today:

- Every table carries `tenant_id`, and every query filters by it (`src/schema.sql`). Tenant
  isolation is tested on the player API and inside every alert test
  (`docs/failure-table.md`).
- In the ledger, each tenant has its own TigerBeetle `ledger` number, so accounts of two tenants
  can never be in one transfer (`docs/contracts.md`, "Ledger").
- Coins move with ids derived from the spin or redemption id, so repeating a step after a crash
  is safe.
- The audit trail is written in the same transaction as each change, and a trigger forbids UPDATE
  and DELETE on `audit_log`.
- Settings are versioned rows, not edits in place (`wheel_configs`, `grant_policies`,
  `ops_policies`).
- CI runs every test against the official TigerBeetle image and starts the whole stack with
  Docker Compose (`.github/workflows/ci.yml`).

What is missing:

- Isolation is only a filter in each query. One forgotten `WHERE tenant_id = ...` would leak data.
  The database itself does not refuse it yet.
- There are no backups and no restore procedure, for PostgreSQL or for TigerBeetle.
- Nothing was load-tested. The prototype has no throughput figure, and I do not quote one.
- Tenant secrets are fixed strings in `src/tenants/demo-tenants.ts`. The schema is applied from
  `src/schema.sql` with `IF NOT EXISTS`, which is not a migration tool.
- Casino events are taken in by the same application that moves coins. In production the intake
  moves behind a queue with consumers, because it is the first part with a different load profile
  (see question 3, "Modules versus services").
- A production environment in the cloud, with backups and monitoring, is part of the MVP
  (question 5).

## 2. "How would you support 10 casino operators without maintaining 10 separate codebases?"

There is one codebase. Differences between operators are policies: named decision points in the
domain, whose parameters are versioned settings of the tenant. Adapters are per platform, not per
operator: two casinos on the same platform use the same adapter with different settings.

A change of settings is an intent, like a redemption. The casino's representative creates it. A
policy decides whether it is confirmed automatically or waits for us. For a wheel change the rule
looks at the expected prize of one spin: within the limit we set for that casino, the change is
confirmed automatically; above it, the change waits for us. Which policies apply to which casino
is decided only by us.

Built today:

- Grant policy: how many spins a deposit gives (minimum amount, currencies, spins per deposit) is
  a versioned parameter set in `grant_policies`, decided by the pure function `spinsForDeposit` in
  `src/policies/grant-policy.ts`, with hard limits in a validator. Each spin stores the policy
  version it was granted under. A new condition is one more field, one more check and one more
  test row.
- Ops policy: alert thresholds per tenant, versioned, in `ops_policies` and
  `src/alerts/ops-policy.ts`. Tests show that a new version changes the result for one tenant and
  not for the other.
- Versioned wheel configs (`wheel_configs`). A spin uses the config it was granted with.
- The alert `wheel_expected_prize_high` already computes the expected prize of the newest wheel
  against the tenant's limit. The same calculation is what the change rule needs.
- Two platforms with different behaviour behind one domain model: platform A answers a reward
  request at once, platform B accepts it and reports later by webhook (`src/integrations/`). Both
  are translated into the same three outcomes: issued, refused, not known yet.

Designed, not built:

- The settings-change intent and its confirmation policy. Today new versions are inserted only by
  tests and the seed.
- The console where the casino's manager creates the intent.
- Log verbosity per tenant set by policy (`docs/ai-log.md`, 12:52).

## 3. "How would you introduce PvP, Missions, and Kingdom Builder without coupling every feature to the casino integration layer?"

Games do not see the casino. Adapters turn platform events into domain events, and games subscribe
to those. A game never calls a platform. It does one of two things: it moves coins in our ledger, or
it creates a reward intent, and one shared mechanism delivers that intent to the platform.

What supports it today:

- Ports and adapters: the domain declares the ports (`src/domain/casino-platform.ts`,
  `src/domain/coin-ledger.ts`); nothing outside `src/integrations/` knows a platform's field names.
- The redemption is that shared delivery mechanism: one intent, one `confirm`, and the same
  outbox job for both platforms. It already handles a lost answer, a lost callback, a timeout, 429
  and 500, and a crash between steps (`docs/failure-table.md`).
- The wheel is the first game built this way. It reads deposit events and moves coins; it never
  talks to the casino.

PvP. I would design a contest for n players (n > 1) from the start, not a duel of two. Tournaments
grow from the same model. The stakes of a running contest sit on the contest's own account in the
ledger. That account is not allowed to go below zero, so a contest cannot pay out more than it took
in. A contest ends with its own domain event, "contest finished". A contest that does not fill is
cancelled and the stakes go back to the players. That last rule is an assumption; the business may
decide otherwise.

Missions are in the MVP, but the record has no decision on their rules yet. They fit the same two
rules: a mission subscribes to domain events, and its reward is coins or a reward intent.

Kingdom Builder is left for after the MVP, and the record says nothing about how it works. I do not
describe its mechanics here. Whatever they are, it would follow the same two rules.

Modules versus services. Adding a new game that subscribes to events needs module boundaries, not
microservices. It is one application with modules. A part becomes a separate service only when
there is a clear reason. There are three such parts:

| Part | Separate because | State today |
|---|---|---|
| Ledger (TigerBeetle) | It holds coins, with its own guarantees | Built, separate store |
| Intake of casino events | It is the first part with a different load profile | Built inside the app; queue and consumers designed, not built |
| Gateway for real-time player connections | Long-lived connections (live leaderboards) should not be held by the application that moves coins; it is fed over publish/subscribe | Designed, not built |

I do not want microservices without such a reason. I have run the gateway split in an earlier
project.

Missing: domain events as a published stream (today the intake calls the deposit logic directly),
the contest model, the gateway.

## 4. "What would your first 90 days look like?"

See `docs/90-day-plan.md`. In short: the test plan comes first; bringing the first casino onto the
product is run as a project with dates, people, tasks and regular calls; a pilot starts as early as
possible; A/B tests of widget versions follow. I do not promise a go-live date, because it depends
on the casino too. My own estimate is that three months are enough for the integration with a
first real platform.

## 5. "What is the smallest realistic engineering team required to deliver an MVP within six months?"

Three people: a product owner, one engineer (me), and a competent QA. All three work with agents.
The team needs strong observability of what the agents do, and subscriptions to the tools they need
on demand. When the widget needs design work, a designer with experience in this field joins, also
with agents.

The MVP is what a first real casino needs to connect:

- the wheel and the bonus store;
- an integration with that casino's real platform;
- missions;
- our back office: alerts, stuck redemptions, audit trail;
- a player widget fit to show on a casino's site;
- a production environment in the cloud, with backups and monitoring.

Left for later: contests, Kingdom Builder, a self-service console for the casino's manager, a
second casino on another platform.

The widget has no frontend engineer behind it. It is made by the product owner with agents and a
design tool, or by a designer with experience in this field. The condition is that the result
stays source code that we can change, not a finished artefact we cannot edit. With agents the team
can make several interface variants and pick one.

The weak point is plain: there is one engineer. My answer is that the system is built so that most
incidents do not need that engineer:

- It fails safe. A stuck redemption is reserved coins, not lost coins: they stay reserved and
  visible until the casino answers (`docs/failure-table.md`).
- Alerts and manual resolution need no engineer. The stuck list, the resolve call and the
  deterministic alerts are built today (`src/admin/`, `src/alerts/`). A manual resolution goes
  through the same `confirm` as a platform's answer.
- Every action is audited, with the admin as the actor.
- An agent can help with an incident. It may read and may perform admin actions, through the same
  entry points as the admin frontend, exposed as MCP tools instead of HTTP calls. The same checks
  and the same audit trail apply. This is designed, not built.
- When the engineer is unreachable, the product owner handles the incident with agents. Who
  reacts and when is a team agreement. I do not want to impose an on-call rota from day one.

## 6. "Which parts of the development process would you automate using AI?"

What was done with AI in the prototype is logged in `docs/ai-log.md`. In short: agents wrote code
from a written contract (`docs/contracts.md`), each on its own branch with its own files; the main
session kept the decisions, the briefs and the review of what came back. Agents broke the code on
purpose to check that the tests notice; three times the first tests did not, and a test was added
each time. Interface variants for the player page were made with agents.

What I would automate:

- Digests. A daily digest written by an agent from a playbook of checks
  (`docs/monitoring-playbook.md`; written, not run). Its first question is "are we losing money
  right now, for any reason". The known ways to lose money are deterministic alerts, not work for
  a language model. The agent looks for what nobody foresaw. It is read-only.
- Code review during development.
- MCP tools for product analytics and for resolving incidents (see question 5).
- Interface variants for the widget, with A/B tests to choose between them.

What stays with people: product decisions, acceptance of the work, and agreements with the casino.

## The playground as part of the product

The test stand built for the prototype (the fake casino, the playground page, the
behind-the-scenes view) should be part of the product, not thrown away. I put this forward as an
idea to discuss. A clear playground makes estimates more accurate and shows quickly what is
exchanged with a platform and how an integration goes.

It is built first for sales: a demonstration that works without an engineer in the room.
Integrators come next, then our own adapter tests.

Built today: the fake casino plays both platforms with scripted and seeded faults
(`src/fake-casino/`), and the playground page runs scenarios through the public API and shows a
verdict (`src/fake-casino/public/index.html`). A player page and an admin page as one React
application are being built and are not on the main branch yet.
