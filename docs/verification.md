# How this project is verified

The approach follows "How the Claude Code team thinks about verification"
(https://claude.dev/blog/how-the-claude-code-team-thinks-about-verification/). Read it before
writing the first test. This page is the short version of how it is applied here.

## The idea

An agent writes most of the code, so the question is not "does the diff look right" but "does
the service do the right thing when it runs". Checks must be cheap enough to run on every
change, and they must be hard for the code under test to fool.

## The pieces

| Piece | What it is | Why |
|---|---|---|
| Fake outside world | Every external system (a partner platform, a payment or reward API, a webhook sender) is a small fake with its own state, kept apart from our tables. It can be told to fail: error, lost request, lost answer, rate limit, reject, refuse the key. | Integrations are where the bugs are. A "lost answer" (the call worked, we never heard) is the fault that separates designs that are exactly-once from designs that only look it. |
| Judge | One function that reads the outside world and says what must never happen has not happened: a reward granted twice, an event counted twice, a player credited in the wrong tenant. | Our own tables can agree with themselves and still be wrong. The judge only trusts what a partner or a player would see. |
| Flow tests | Whole scenarios from the first input to the judge's verdict, with a fault or a kill at a named point. | One flow test covers what twenty unit tests cover, and it survives refactoring. |
| Property tests | fast-check generates faults and kills at random; the property is always "the judge finds no problems". Fixed seed by default, random seed in a deeper run. | Finds the orderings nobody thought of. A failure prints a seed that replays it. |
| Differential check | A run with faults must end in the same visible state as a clean run of the same input. | States the requirement without listing every case. |
| Clock the test moves | No test sleeps. Time is an interface; the fake advances when the test says so, and also during fake calls, because real calls take time. | Fast, and timing bugs become reproducible. A bug can hide until the clock advances during a call. |
| Real processes | One slower suite starts real worker or server processes and kills them (SIGKILL) while they work. | In-process tests cannot show what a crash between two statements does. |
| Mutation check | Before trusting a suite, break the code on purpose (remove a guard, skip a check) and confirm a test fails. | A suite that passes on broken code proves nothing. |
| `verify` skill | `.claude/skills/verify/SKILL.md` tells the agent what to run and how to read a failure. | The agent verifies its own work the same way every time. |

## What of this is in the project

| Piece | Where | State |
|---|---|---|
| Fake outside world with faults | `src/fake-casino/`, started in tests by `test/fake.ts` | Built. |
| Judge | `test/judge.ts` | Built. Reads the casino's record and the ledger. |
| Flow tests | `test/store.test.ts`, `test/wheel.test.ts`, `test/outbox.test.ts` and others | Built. |
| Property test | `test/properties.test.ts` | Built. Random players, actions, ticks and fault plans on both platforms; after the faults stop, the judge must find nothing and every redemption must be final and settled. Fixed seed in `npm run verify`; `npm run test:deep` uses a random seed and 150 runs. The file header says how to replay a seed. A late contradicting platform B notice is sent at the end of every run. |
| Differential check | `test/store.test.ts`, test 20 | Only for the redemption flow with a few named faults. It is NOT built as a general check (a run with random faults compared with a clean run of the same input). |
| Fake clock | `src/clock.ts`, `FakeClock` | Built. No test sleeps, except where a real time limit is the thing under test. |
| Real processes | `test/processes.test.ts` | Built; part of `npm run verify` (about 40 s, the slowest file). It compiles the app like the image does and starts real `node` processes: an API and workers on the test's PostgreSQL and TigerBeetle, the fake casino in the test process, a real clock, a 3 s lease. A: SIGKILL a worker that holds claimed jobs, two new workers finish them. B: SIGKILL the API after the requests committed and before any job ran, workers finish what they can, a restarted API takes the platform B callbacks. C: three workers, 30 spins and 30 redemptions, every redemption issued once, no job lost. D: a handler that outlives its lease is fenced out. The test found a real defect (a schema deadlock when a process starts under load, see `docs/failure-table.md`). |
| Mutation checks | by hand, results in `docs/ai-log.md` | Not automated. |

What the process test cannot see: a kill at a chosen line of code (the kill comes when a claim shows in the
`outbox` table, so it lands somewhere inside a job), a machine that dies (PostgreSQL and TigerBeetle are never
killed), and more than 3 workers. The outbox does not record which worker holds a claim, so in A the worker
that is killed is the only one running while it claims; the two that finish the work start after the kill.
Platform B has no idempotency key: a handler that outlives its lease can grant twice there. The lease must be
longer than the longest handler (contracts, "Outbox"), and D uses platform A for that reason.

What the property test cannot see: a platform that contradicts itself (the fake never does; the test
adds one late contradicting notice by hand), faults of PostgreSQL or TigerBeetle, and a process that
dies. Concurrent HTTP calls are not ordered by the seed, so a replay is close, not exact.

## Order of work

1. Write down what must never happen. That list is the judge.
2. Build the fake outside world with the faults.
3. Write the first flow test for the main scenario. It fails.
4. Write the code until it passes. Add a flow test per fault that matters.
5. Add one property test over faults and kills.
6. Break the code on purpose in two or three places; check the tests notice.
7. Run every README command on a clean clone.

## Known ways this approach goes wrong (so this project avoids them)

In order of cost:

- Everything outside is fake, and the fake's assumptions are kinder than real APIs (for example:
  a search by our own reference works on every platform). State such assumptions in the README,
  and where time allows make one thin slice real.
- A number in the design ("this is small for PostgreSQL") that was never measured. Do not write
  a number that was not measured; say "not measured".
- A command in the README that fails on a clean machine.
- A demo that switches a safety mechanism off without the README saying so.
- A timeout wrapper that does not cancel the request it wraps, with no test exercising it.
