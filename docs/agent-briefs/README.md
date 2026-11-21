# Agent briefs

The instructions the coding agents received, as they were sent, and the report each one returned.
Local paths are replaced with placeholders; nothing else is edited.

How the work was organised:

1. The main session and the author made the decisions (`docs/ai-log.md`).
2. The main session wrote the contract the modules agree on (`docs/contracts.md`, `src/schema.sql`,
   `src/domain/`) and committed it.
3. Each brief below went to one agent on a smaller model, working on its own git branch, with its
   own list of files. Agents in one wave ran at the same time.
4. Every brief required the agent to break its own code on purpose and show that a test fails
   ("mutation checks"), and to report what it did not test.
5. The main session merged each branch, ran `npm run verify` on the result and recorded the outcome.

| File | Wave | What it built |
|---|---|---|
| `01-ledger-and-outbox.md` | 1 | The coin ledger on TigerBeetle and the outbox |
| `02-fake-casino.md` | 1 | The two simulated casino platforms with faults |
| `03-audit-tenants-intake.md` | 1 | Audit write path, tenants, player tokens, deposit intake |
| `04-wheel-and-grant-policy.md` | 2 | The wheel and the policy for granting spins |
| `05-bonus-store-redemptions.md` | 2 | Redemptions, outbound adapters, the judge, the failure table |
| `06-admin-operations-alerts.md` | 3 | Admin endpoints, manual resolution, alerts, the monitoring playbook |
| `07-playground-and-samples.md` | 3 | The casino control panel page and the sample requests |
| `08-react-frontend.md` | 4 | The React app; includes the redirect sent after the author rejected the first page |
| `09-structured-logging.md` | 4 | Structured logs with verbosity by tenant policy |
| `10-review-fixes.md` | 5 | Six fixes found in review, one commit each |
| `11-back-office-api.md` | 5 | Sign-in, roles, back office endpoints, the settings-change intent |
| `12-back-office-screen.md` | 5 | The back office screen and the casino frame for the widget |
