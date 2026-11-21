# First 90 days

The engineering plan for the first three months, with the team from question 5 of
`docs/scaling-plan.md`: a product owner, one engineer and a QA, all working with agents. The aim is
the MVP for a first real casino. The positions come from `docs/ai-log.md`.

How I run it:

- The test plan comes first. Before new code, we write down what must never happen and how each
  rule is checked, as was done for the prototype (`docs/contracts.md`, `docs/verification.md`).
- Bringing a casino onto the product is a project, and I run it with ordinary project management:
  dates, people, tasks, regular calls with the casino's team.
- A pilot with the casino starts as early as possible. Feedback from production is worth more than
  a later, larger launch.
- I do not promise a go-live date, because it depends on the casino's side too. My own estimate is
  that three months are enough for the integration with a first real platform.

## Month 1: the plan and the ground

Goal: the test plan is written and agreed, the integration project is running, and the production
ground is in place.

What we do:

- Write the test plan for the MVP and agree it inside the team.
- Start the integration project with the casino: people on both sides, dates, tasks, a regular
  call.
- Do the first three production steps: tenant isolation enforced by the database, backups with a
  tested restore including the ledger, load tests with real numbers.
- Basic hygiene: tenant secrets in a secrets store, database migrations.
- Set up the production environment in the cloud, with backups and monitoring.

What depends on the casino: access to their platform documentation and a test environment; people
for the regular call.

How we know it is done: the test plan exists; a restore was run and checked; the load test gave
numbers that we wrote down; the project has dates and owners on both sides.

## Month 2: the real platform

Goal: the wheel and the bonus store work against the casino's real platform in its test
environment.

What we do:

- Write the adapter for the casino's platform: events in, reward requests out, status query if the
  platform has one.
- Run the same flow tests against the fake casino and then against their test environment.
- Bring the back office to the level the MVP needs: alerts, stuck redemptions, audit trail.
- Make the player widget, with agents, as source code that we can change.
- Start missions.

What depends on the casino: a test environment that behaves like production; answers about their
API; what happens to a redemption whose outcome cannot be learned at all (this is an agreement
between our business and the casino, not an engineering decision).

How we know it is done: the flow tests pass against their test environment; the QA has accepted
the test plan items for this month.

## Month 3: the pilot

Goal: real players of the casino use the product in a pilot that grows step by step.

What we do:

- Start the pilot as soon as the casino agrees, and widen it step by step.
- Watch alerts, stuck redemptions and the daily digest.
- Run A/B tests of widget versions once there is traffic.
- Finish missions.

What depends on the casino: the decision to start the pilot and how wide it is; showing the widget
on their site.

How we know it is done: the pilot runs with real players; alerts reach someone; incidents during the
pilot were handled through the back office.

## Risks and what we do about them

- The date depends on the casino. I do not promise a go-live date; the project has dates for each
  side, and the regular call shows early when one side slips.
- One engineer. The system fails safe (a stuck redemption is reserved coins, not lost coins);
  alerts and manual resolution need no engineer; every action is audited. When the engineer is
  unreachable, the product owner handles the incident with agents.
- A platform without a status query or reliable webhooks leaves outcomes unknown. An admin can
  resolve them by hand; the rule for such cases is agreed with the casino.
- The real platform's lookup may lag behind an accepted grant. The prototype assumes it does not
  (`docs/contracts.md`, platform B); we check this against the real platform.

## What is not in these 90 days

- Contests (PvP and tournaments) and Kingdom Builder.
- A self-service console for the casino's manager, and the settings-change intent behind it.
- A second casino on another platform.
- The gateway for real-time player connections.
