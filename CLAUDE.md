# Working rules for this repository

This is a time-boxed take-home: an architecture and a small working prototype. The person
reviewing it wants to see engineering judgement, a sound architecture, key functionality that
runs, and AI tools used well. Not the amount of code.

## How to work

- Read `docs/verification.md` before writing the first test, and follow its order of work.
- Run `npm run verify` after every change to `src/` and before every commit (see
  `.claude/skills/verify/SKILL.md`). Docker must be running.
- Build the smallest thing that shows the key scenario working end to end. Everything else is
  described in the README, not half-built.
- Decisions about what the product does belong to the author. When a requirement is unclear, ask
  one question at a time; if nobody can answer, write the assumption in the README and go on.
- Do not write a number, a claim or a "tested" that was not actually measured or run.
- Plain English in code, comments and docs: short sentences, no marketing words.

## Git

- Commit at every green point: `npm run verify` passed and one logical change is complete. Do not
  wait to be asked. Never commit on red; never batch unrelated changes into one commit.
- Every commit that changes `src/` or `test/` has a row in `docs/ai-log.md`, in the same commit:
  what changed, who decided, how it was checked. The row names the test that covers the change.
- A test that is expected to fail (written before the code) is committed together with the code
  that makes it pass, not alone.
- A defect found by a test, a review or a mutation check gets its own commit: the test that shows
  it and the fix, with the finding described in the message.
- Commit messages describe the change and how it was checked. No tool names, no attribution lines.
- Push after each commit. CI must be green before the next piece of work is called done.
- Never commit `CLAUDE.local.md`, `.private/`, `.env` or anything with personal data.

## Layout

- `src/` code, `src/schema.sql` database schema.
- `test/` tests; `test/harness.ts` gives each test file its own database.
- `docs/` design documents and diagrams (`docs/img/*.svg`).
- `docker-compose.yml` PostgreSQL and TigerBeetle for running the prototype by hand.
- `scripts/tb-old-cpu.sh` workaround for development on a CPU without AVX2; `test/tigerbeetle.ts`
  starts a throwaway TigerBeetle for tests from the binary in `TB_BIN`.
