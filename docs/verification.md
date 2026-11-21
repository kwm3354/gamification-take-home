# How this project is verified

The approach follows "How the Claude Code team thinks about verification"
(https://claude.dev/blog/how-the-claude-code-team-thinks-about-verification/). Read it before
writing the first test. This page is the short version of how it is applied here; it was worked
out on an earlier project (https://github.com/kwm3354/publishing-pipeline), where it found three
real bugs that reading the code had missed.

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
| Clock the test moves | No test sleeps. Time is an interface; the fake advances when the test says so, and also during fake calls, because real calls take time. | Fast, and timing bugs become reproducible. On the earlier project a bug hid until the clock advanced during a call. |
| Real processes | One slower suite starts real worker or server processes and kills them (SIGKILL) while they work. | In-process tests cannot show what a crash between two statements does. |
| Mutation check | Before trusting a suite, break the code on purpose (remove a guard, skip a check) and confirm a test fails. | A suite that passes on broken code proves nothing. |
| `verify` skill | `.claude/skills/verify/SKILL.md` tells the agent what to run and how to read a failure. | The agent verifies its own work the same way every time. |

## Order of work

1. Write down what must never happen. That list is the judge.
2. Build the fake outside world with the faults.
3. Write the first flow test for the main scenario. It fails.
4. Write the code until it passes. Add a flow test per fault that matters.
5. Add one property test over faults and kills.
6. Break the code on purpose in two or three places; check the tests notice.
7. Run every README command on a clean clone.

## What the earlier project got wrong (so this one does not)

An independent review of that project found these, in order of cost:

- Everything outside was fake, and three assumptions were kinder than real APIs (search by our
  own key works on every platform; the provider reports usage per call with our reference; the
  price of a call is known in advance). State such assumptions in the README, and where time
  allows make one thin slice real.
- A number in the design ("this is small for PostgreSQL") was never measured, and was wrong at
  the stated volume. Do not write a number that was not measured; say "not measured".
- A command in the README (`test:deep`) failed on a clean machine because of a timeout setting.
- The demo switched one safety mechanism off and the README did not say so.
- Generated content was stored as it came, with no check that it was usable.
- A timeout wrapper did not cancel the request it wrapped, and no test exercised it.
