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
- I do not promise a date for opening to all players, because it depends on the casino's side too.
  My own estimate is that three months are enough for the integration with a first real platform.

## Month 1: the plan, the ground, and a first narrow pilot

Goal: the test plan is agreed, the integration project is running, the production environment
exists, and a first small group of real players can spin the wheel.

What we do:

- Write the test plan for the MVP and agree it inside the team.
- Start the integration project with the casino: people on both sides, dates, tasks, a regular
  call.
- Set up the production environment in the cloud, with backups and monitoring, and the basic
  hygiene: tenant secrets in a secrets store, database migrations.
- Write the adapter for the casino's platform: events in, reward requests out, a status query if
  the platform has one. Run the same flow tests against the fake casino and against their test
  environment.
- Start the pilot on a narrow group (for example the casino's own staff or a small share of
  players) with the wheel only. The wheel can be switched off for a casino by one setting.

What depends on the casino: access to their platform documentation and a test environment; people
for the regular call; the decision to start a narrow pilot and who is in it.

How we know it is done: the test plan exists; the flow tests pass against their test environment;
the first real players have spun the wheel; the project has dates and owners on both sides.

## Month 2: widen the pilot, add the store and missions

Goal: the pilot grows as it proves itself, and the bonus store runs in production.

What we do:

- Widen the pilot step by step.
- Before each widening, close the first three production steps: tenant isolation enforced by the
  database, backups with a tested restore including the ledger, load tests with real numbers.
- Turn on the bonus store in production: redemptions against the real platform.
- Run operations on live data: alerts delivered to people, stuck redemptions, the audit trail, the
  daily digest. The back office for this exists in the prototype; here it meets real traffic.
- Make the player widget for real, with agents, as source code that we can change; the team
  chooses among several variants.
- Start missions.

What depends on the casino: how fast the pilot may widen; answers about their API; what happens to
a redemption whose outcome cannot be learned at all (an agreement between our business and the
casino, not an engineering decision).

How we know it is done: a restore was run and checked; the load test gave numbers that we wrote
down; redemptions are issued by the real platform; the QA has accepted the test plan items for
this month.

## Month 3: all players, experiments, missions done

Goal: the product is on for all of the casino's players, and we learn from the traffic.

What we do:

- Open the product to all players of the casino, when the casino agrees.
- Run A/B tests of widget versions, now that there is traffic. One open question they should
  answer: how much of the widget is built into a per-casino bundle and how much is read from the
  server at run time.
- Finish missions.
- Deliver the widget the way a client's site needs it: bundles built ahead, served from a CDN,
  caches warmed after a deploy.

What depends on the casino: the decision to open to all players; showing the widget on their site.

How we know it is done: all players can use the wheel and the store; an experiment has run and
produced a decision; incidents so far were handled through the back office.

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
- A self-service console for the casino's manager as a finished product. The prototype already has
  the mechanism behind it (a change of the wheel is an intent that a policy applies or leaves for
  us); a console a casino can be given alone needs more than that.
- A second casino on another platform.
- The gateway for real-time player connections.

## What I do not know

I am new to the casino industry. The order above rests on general engineering practice and on what
the prototype taught me, not on knowledge of how a casino's own teams work, how long their
approvals take or what their platforms really offer. The first weeks of the integration project are
where I expect this plan to change.
