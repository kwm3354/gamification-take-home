---
name: verify
description: Run this before every commit and after any change to src/. Cheap checks first, then the tests that run the service end to end against a fake outside world, then read the judge's verdict.
---

# Verify the service

Verification here means running the service, not reading the diff. Run the steps in order and
stop at the first failure. Docker must be running: the tests start their own PostgreSQL.

1. `npm run typecheck` and `npm run lint`. Seconds.
2. `npm test`. Flow tests and property tests on a clock that only moves when the test moves it.

`npm run verify` runs both. Tests that need the ledger are skipped unless `TB_ADDRESS` or `TB_BIN` is
set in the same shell command; a run with skipped files is not a green run, so read the summary line.
`test/app.ts` boots the whole app in the test process. `test/processes.test.ts` is the slower suite:
it starts real API and worker processes and kills them. `test/properties.test.ts` generates random
faults (`npm run test:deep` for more runs with a random seed). `test/tenant-isolation.test.ts`
fails when a route has no decision about tenant isolation. If `web/` changed, also run
`npm run verify:web`. The full list of gates is "Green gate" in `CLAUDE.md`.

## Reading a failure

- Every test asserts on what an outside observer can see (the judge), not on our own tables.
- A failing property test prints a seed and the smallest failing case. Replay it with the same
  seed before changing anything.
- A failure in a test that uses real processes is a real bug. Do not rerun it to see whether it
  goes away.

## Rules

- Never make a test pass by adding a sleep, a retry or a skip. Find the cause. If a test cannot
  be made reliable, delete it and write down why.
- Never change the judge or the assertions in `test/` in the same change as the code they judge.
- A bug found any other way becomes a flow test first, then a fix.
- Every command the README mentions must have been run, on a clean clone, before the work is
  handed in.
- If the same check still fails after three attempts at a fix, stop and ask a person.
