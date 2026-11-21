# AI development log

How AI was used on this task, kept as the work went. One entry is one decision or one piece of
work: what was decided or done, who decided (the author or the agent), and how the result was
checked. Times are local (UTC+5), to within a few minutes. The tool is Claude Code; its standing instructions are in
`CLAUDE.md`, the verification routine in `.claude/skills/verify/SKILL.md` and
`docs/verification.md`.

"Author" means the decision was made by the author, sometimes from options the agent laid out.
"Agent" means the agent chose and the author did not object. "Not checked" is written where
nothing was run.

| Time | What | Who decided | How it was checked |
|---|---|---|---|
| 11:00 | The ledger is double entry and lives in TigerBeetle. Conditions: prove the official image runs on hardware other than the dev machine (its CPU has no AVX2) in the first hour; integration must be done by 14:00; otherwise fall back to a transfers table in PostgreSQL and say so in the README. | Author | See the 11:13 row. |
| 11:00 | PostgreSQL keeps real work: state, event intake, the queue of outgoing calls. | Author | - |
| 11:00 | Code structure must stay simple enough for the author to change by hand in the live session. No line-by-line review of generated code; instead a short summary after each piece: what it does, what can break, which test catches it. | Author | - |
| 11:00 | First hour is for reading the task and deciding scope. No code. | Author | - |
| 11:07 | This log is kept in `docs/ai-log.md` and written by the agent during the day. | Agent proposed | Author to confirm. |
| 11:10 | TigerBeetle goes into `docker-compose.yml` with two image lines: the official image, and a commented line for a local build for CPUs without AVX2. | Author | Agent wrote it and ran it with the local build only: the server formats its data file, starts, passes the ledger smoke test (`TB_ADDRESS=127.0.0.1:30009`), and starts again on the same data file after a restart. The official image line has not been run anywhere yet. |
| 11:13 | Prove the official TigerBeetle image on other hardware with a throwaway private repository that holds only the compose file and the smoke test, run by GitHub Actions. The main repository gets no remote. | Author, from three options the agent gave | Run at 11:13 on a GitHub-hosted runner (AMD EPYC with AVX2, Docker 29.4.2): the official image formatted, started, passed the smoke test with the official npm client, and started again on the same data file. A second job without `seccomp=unconfined` failed with "io_uring is not available", so that line is required. Not checked: Docker Desktop on macOS or Windows, a host with io_uring disabled by sysctl, a client inside the compose network. |
| 11:14 | Scope. Code: the workflow 1-8 for two platforms, and eight flow tests for Part C (duplicate deposit, concurrent spins, duplicate redemption, timeout with recovery, refused issuance returns the coins, concurrent redemptions cannot overdraw, bad signature rejected, tenant isolation). Words only: admin, observability, RBAC, Part E. Code stops at 16:30; texts until 18:15; clean clone and independent review until 18:45. Redis is removed from compose (nothing uses it). A property test only if all is green at 16:00. | Author accepted the agent's version; the author's own draft had four tests and a later code stop | - |
| 11:14 | A playground page that plays the casino side is wanted. | Author | - |
| 11:16 | The playground page is in scope, not optional: "not a polished frontend" does not mean "no frontend". Model: a sandbox page from the author's earlier payments project, which plays the outside party, runs a chosen scenario through the public API in numbered steps and shows every request and raw response. | Author; the agent had proposed it as optional | - |
| 11:18 | Playground: one HTML file with no build step, served by the fake casino process. Scenario part right after the first full pass of the workflow (cap 40 minutes). Fault panel after the eight tests (cap 30 minutes): fault rates and weights per call point, a seed, "run N players", and the judge's verdict on the page. It replaces a separate property test. Faults live inside the fake casino, not in a proxy in our code, because a proxy that fails before the call cannot model "the casino granted the reward and the answer was lost". | Author accepted the agent's proposal; the chaos panel was the author's idea, from an earlier project of his | - |
| 11:20 | Commit policy (see `CLAUDE.md`): a commit at every green point, one logical change each, with a row in this log. Private remote created and the setup pushed. Redis removed from compose. CI runs `npm run verify` on a GitHub runner with the official TigerBeetle image. | Author (policy, remote); agent (CI) | `npm run verify` before the commit; CI result in the next row. |
