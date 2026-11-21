# Working rules for this repository

These are the standing instructions for every AI agent that works here, and for the main session
that directs them. They were tightened during the day; each rule that came from a mistake says so.

The project is a prototype of a gamification service for casino operators: an architecture and a
working slice. What matters is engineering judgement, a sound architecture, key functionality that
runs, and AI tools used well. Not the amount of code.

## Green gate: the definition of done

Work is **not done** until all of this passes on the current change. A task that leaves a red
test, a lint finding or a skipped check is unfinished, however much of its goal was reached. If a
gate blocks you, fix the cause or stop and say so. Never skip it silently, never weaken an
assertion to get green.

- **Always:** `npm run verify` (typecheck, lint, all tests). Docker must be running. On this
  repository's CI and on a normal machine the tests use TigerBeetle from compose (`TB_ADDRESS`);
  with a local binary set `TB_BIN` in the same shell command. **A run with skipped test files is
  not a green run**: read the summary line.
- **If `web/` changed:** `npm run verify:web`.
- **If the money path changed** (`src/store/`, `src/outbox/`, `src/ledger/`, `src/wheel/`,
  `src/events/`, `src/integrations/`): the property test and the process test must be in the run
  (`test/properties.test.ts`, `test/processes.test.ts`; both are part of `npm run verify`), and at
  least one mutation check: break the guard you touched, see a named test fail, restore.
- **If a route was added or changed:** it is placed in `test/tenant-isolation.test.ts`, in the
  checked list with a check or in the skipped list with a reason. The test fails until it is.
- **If `docker-compose.yml`, the Dockerfile or the schema changed:** the stack starts from nothing
  (`docker compose up -d --build --wait`) and `/health` answers.
- **If a document states a behaviour, a name or a number:** it is true for the code in the same
  commit. See "Documents" below.
- **After the push:** CI is green before the next piece of work is called done.

## Rules for the money path

1. **What must never happen** is listed in `docs/contracts.md`. A change that could touch one of
   those rules needs a flow test that ends with the judge's verdict (`test/judge.ts`).
2. **No network call inside a database transaction.** Not to the casino, not to the ledger. Decide
   and enqueue in one short transaction, call outside it, write the outcome in another. *(Came
   from a mistake: the first outbox ran handlers under a row lock; a load run found it.)*
3. **Look first, then repeat.** After an unknown outcome of a reward request, ask the platform
   whether the reward exists before sending the request again.
4. **A redemption becomes final in one place:** `confirm` in `src/store/redemption.ts`, and only
   from `submitting`. Do not add a second place that sets `issued` or `refused`.
5. **Ledger ids are derived, never random.** A transfer id is a hash of the id of the decision it
   belongs to, so a repeat moves nothing.
6. **Every write goes through `src/audit/audited.ts`**, in the same transaction as the change. No
   bare `UPDATE` or `DELETE` on a business table.
7. **A job is written with the decision that needs it** (`outbox.enqueue(tx, …)`), and a handler
   must be safe to run twice and by two workers.
8. **A tenant comes from a verified token or signature**, never from the request body. A row found
   by id is still checked against the caller's tenant.
9. **No secret in a log line, an audit row, a test fixture or a document.**
10. **Input from outside is bounded and typed before it reaches SQL**: ids have a length cap and a
    strict pattern; a bad value is a 4xx, never a 500. *(Came from an independent review.)*

## Rules for tests

- Read `docs/verification.md` before writing the first test. The outside world is a fake with
  faults; the judge trusts only the casino's record and the ledger.
- **A test must be able to fail.** Write it first and see it fail, or break the code on purpose
  afterwards and see it fail. Report which.
- **No wall-clock limits.** Use the fake clock. A test that asserts "under N ms" of real time
  fails on a busy two-core CI runner. *(Came from two red CI runs.)*
- **No sleeps.** If a test must wait for something real (a child process, a row), poll with a
  deadline.
- **A stop condition is tested as a chain.** For a retry cap, a backoff or a deadline, drive the
  real decision from zero through every step and assert both sides: it does not stop early, and it
  does stop.
- **A defect found by a test, a review or a measurement gets its own commit:** the test that shows
  it, the fix, and the finding in the message.
- **Do not make a test pass by changing what it claims** unless the claim was wrong; then say in
  the commit why the old claim was wrong.

## Documents and comments

- **Do not write a number, a claim or a "tested" that was not measured or run.** Say "not
  measured" or "not tested".
- **Present tense for what the code does now; "not built" for what it does not.** No future tense
  for current behaviour.
- **Fact and hypothesis are kept apart.** When explaining a failure, look at the log, the rows or
  the trace first, and say which statements were checked against what.
- **A comment says why, in place.** No pointers to chats, tickets or other documents that can
  move. If a comment near your change is wrong, fix it in the same change.
- **Committed files are self-contained.** No references to private notes, to an agent's memory, to
  other projects, or to paths outside the repository.
- Plain English: short sentences, no marketing words.

## How agents work here

- **Decisions about what the product does belong to the author.** On a design question, lay out
  the problem and the options; do not arrive with the conclusion. When a requirement is unclear,
  ask one question at a time; if nobody can answer, write the assumption in the README and go on.
- **The main session writes the contract first** (`docs/contracts.md`, `src/schema.sql`,
  `src/domain/`), then gives each coding agent a written brief: the goal, the files it owns, the
  files it must not touch, the tests it must write, the mutation checks, the report it owes.
- **One agent, one branch, one list of files.** Two agents never edit the same file at the same
  time.
- **Every agent reports:** what was built, what can break, which test catches it, what happened
  when the code was broken on purpose, and what was NOT tested.
- **The main session merges, runs the green gate on the result, and only then records it.** An
  agent's "it is green" is not the gate.
- **Build the smallest thing that shows the scenario end to end.** What is not built is described
  in the README, not half-built.

## Git

- Commit at every green point: the gate passed and one logical change is complete. Never commit on
  red; never batch unrelated changes into one commit.
- Stage files by name. Not `git add -A`. *(Came from a mistake: unrelated drafts were swept into a
  commit.)*
- Every commit that changes `src/` or `test/` has a row in `docs/ai-log.md`, in the same commit:
  what changed, who decided, how it was checked. The row names the test that covers the change.
- A test that is expected to fail (written before the code) is committed together with the code
  that makes it pass, not alone.
- Commit messages describe the change and how it was checked. No tool names, no attribution lines.
- Push after each commit.
- Never commit `CLAUDE.local.md`, `.private/`, `.env` or anything with personal data.

## Layout

- `src/` code; `src/schema.sql` the database schema; `src/domain/` the ports.
- `test/` tests; `test/harness.ts` gives each test file its own database; `test/judge.ts` is the
  judge.
- `web/` the player page and the back office (one React app).
- `docs/` design documents, the decision log (`docs/ai-log.md`), the briefs given to agents
  (`docs/agent-briefs/`) and diagrams (`docs/img/*.svg`).
- `docker-compose.yml` PostgreSQL, TigerBeetle, the API, workers, the fake casino, a trace viewer.
- `scripts/tb-old-cpu.sh` workaround for development on a CPU without AVX2; `test/tigerbeetle.ts`
  starts a throwaway TigerBeetle for tests from the binary in `TB_BIN`.
- `.claude/skills/verify/SKILL.md` how to run the gate and read a failure.
