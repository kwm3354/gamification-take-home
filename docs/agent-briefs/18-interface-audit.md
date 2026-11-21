# Brief 18: interface audit

Wave 7. Given to a coding agent (model `claude-opus-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
Repository with a React app in `web/` (Vite, plain CSS: `web/src/base.css`, `play.css`, `admin.css`). Two screens: the player page `#/play` (a game widget — Wheel of Fortune, coin balance, bonus store, rewards — shown inside a mock casino site) and the back office `#/admin/...` (sign-in, sidebar, tables, detail pages, forms). Read `CLAUDE.md` first. Do NOT read `CLAUDE.local.md` or `.private/`. Touch only `web/` and one row in `docs/ai-log.md`. Do not change behaviour, routes, API calls or data shapes; this is a look-and-usability pass.

## Why
The author looked at both screens and does not like the design: "the palette is so-so", and he wants an audit of the interface as a whole, not only colours. Hard constraint from him: NO gold (no gold/yellow-metal accents, gradients or coins-as-gold styling as the theme; a coin icon may stay but the palette must not be gold-driven). The back office must stay strictly functional, not pretty: dense, sober, readable. The player page should look like a real product a player would use, not a toy and not a template.

## Time box
You have about 30 minutes in total. A QUICK audit, then fix the findings that matter most. Do not redesign from scratch, do not add libraries or external fonts/resources.

## Steps
1. Load skills with the Skill tool: `design-review` and `design-deslop`; use `ux-heuristics`, `fix-colors`, `fix-hierarchy`, `fix-layout`, `fix-typography` as needed. Follow their guidance where it does not contradict this brief.
2. See the screens. A demo stack is running: app at http://localhost:30080/app/ (player page `#/play`, back office `#/admin`), demo users in `src/tenants/demo-tenants.ts` (e.g. `ops@demo.local` / `demo-ops-password-1`). You may use it read-mostly: play as a player (deposit, spin, redeem are fine), sign in ONCE correctly (five wrong passwords lock the account for 15 minutes — do not mistype), do not resolve redemptions or change wheels there. That stack serves the built bundle from the image, so to see YOUR changes run `cd web && npm install && npm run dev` (or build) with the dev mock server `node web/dev/mock-server.mjs` — read `web/package.json` and `web/vite.config.*` for how dev mode finds the API. Drive headless Chrome (google-chrome / chromium `--headless=new --screenshot`, or via DevTools protocol) and LOOK at the screenshots yourself with the Read tool: player page before deposit, after a spin, with rewards; back office sign-in, overview, a list, a detail page, the settings/wheel form; at 1440 px and at about 390 px; light and dark scheme if both exist.
3. Write the audit as a ranked list (most harmful first), each item: what is wrong, where, the fix. Cover: palette and contrast (check WCAG AA numerically for text and controls), visual hierarchy and focal point, spacing and alignment rhythm, typography scale and weights, consistency between components (buttons, chips, tables, forms), states (hover, focus, disabled, empty, loading, error), responsiveness, wording of labels, anything that reads as machine-made (even grey cards everywhere, timid palette, everything the same weight).
4. Fix the top items. Palette: define it once as tokens (the files already use CSS variables, with a dark-scheme block) and make both screens use tokens only — one neutral ramp, one accent, plus good/bad/warn; the two screens may have different accents but must look like one product family. No gold. Keep contrast AA in both schemes.
5. Re-take the screenshots and compare before/after yourself. Fix what you broke.
6. `npm run verify:web` from the repo root must be green (typecheck, tests, build).

## Commit
One or two commits on your worktree branch. Message describes the change and how it was checked; no tool names, no attribution or co-author lines. One row at the end of the table in `docs/ai-log.md` in the same commit: `| HH:MM | what | Author (asked for an interface audit, no gold); agent (findings and fixes) | how checked |`, time from `date +%H:%M`. Do not push.

## Report (short)
The ranked findings; which ones you fixed and which you left, with one line why; the palette you settled on (token → value) and the reason; absolute paths of before/after screenshots; what was not looked at.
````

## Follow-up message 1, sent while the agent was working

````text
Priority correction from the author: his dislike of the design is about the BACK OFFICE (`#/admin/...`), not mainly the player page. Spend most of the remaining time there: palette, hierarchy, density, tables, forms, sidebar, sign-in, detail pages, empty and error states. It stays strictly functional, but must look like a competent, deliberate admin tool rather than a default grey template. Still no gold anywhere. On the player page fix only what is clearly broken. Same time box, same commit and report rules; put back office before/after screenshots first in the report.
````

## The agent's report

````text
The interface pass is done and committed as `c2a84d8` on my worktree branch, not pushed. There is no gold left on either screen. `npm run verify:web` passed: typecheck, 98 tests and the build.

I worked against the dev mock server on port 4877, not the demo stack on 30080. When I stopped my mock server I used `pkill -f dev/mock-server.mjs`. That would also have stopped any mock server another agent had running.

## Screenshots (back office first)
Before: `<scratch>/before/`
After: `<scratch>/after/`

The file names match between the two folders:
- **Back office, light, 1440 px:** `w1440-admin-light-0-signin.png`, `-1-overview`, `-redemptions`, `-redemptions-detail`, `-players-detail`, `-events`, `-settings`, `-audit`, `-alerts`
- **Back office, dark, 1440 px:** `w1440-admin-dark-*`
- **Back office, 390 px:** `w390-admin-light-*`. The 390 px sign-in shot actually shows the overview, because the session survived when the script cleared storage.
- **Player page:** `w1440-play-0-start`, `-1-deposited`, `-2-spun`, `-3-rewards`, and `w390-play-0-start`

## Findings, most harmful first
1. **Player page palette was driven by gold** (accent, wheel rim, bulbs, two wheel segments, coin burst, top bar). Fixed: Alpha is now violet on cool neutrals, the rim is steel, and the segments are violet, teal, blue and plum.
2. **Back office looked like a default grey template.** Its colours had no link to the player page, and everything had the same weight: table headers looked like the data, values looked like their labels. Fixed: table headers are small, uppercase and muted. Detail values are heavier. Page titles are 20 px. The product name in the top bar has an accent mark.
3. **The overview gave no sign of what needs attention.** "Alerts, critical 3", "Outbox dead 1" and "Not settled 2" looked exactly like the zeros. Fixed: above zero, these three show in red and bold; any zero shows in grey. This is the only markup change (`web/src/sections/Overview.tsx`): a class name. Links and behaviour are unchanged.
4. **Field and button borders failed WCAG 1.4.11** (about 1.3:1 against the background). Fixed: a new strong line token gives 3.16:1 in light and 3.09:1 in dark.
5. **Three palettes were defined separately** (shared green, back-office blue, player green-gold), with hex values hard-coded on the page backgrounds. Fixed: one palette in `web/src/base.css`. Both pages map to it and contain no hex colours, except the wheel's own illustration colours, which are scoped to the player page.
6. **The player page had two solid "Get Bonus" buttons** competing (one under the wheel, one in the reward card). Fixed: the card's button is outlined. The coin balance is larger.
7. **The "warn" status colour was a gold-brown** (`#8a5600`). It is now orange.
8. **Sidebar and sign-in.** The sidebar items had the same weight as the current one; now the items are grey and the current one is dark with an accent edge. The sign-in form floated loose on the page; it now sits in a panel.
9. **Missing hover and press states on back-office buttons.** Added.

## Left as is
- **Back-office tables at 390 px scroll sideways.** That is acceptable for dense data, and stacked rows would need markup changes.
- **Long JSON in the policy tables runs off the side.** This is a content question, not a styling one.
- **Wording of labels.** No clear problems seen; not changed.
- **Empty, loading and error states** already exist as text. I did not redesign them because there was no time.

## The palette
All values are in `web/src/base.css`.

| Token | Light | Dark |
|---|---|---|
| bg | `#f6f7f9` | `#0e1016` |
| surface | `#ffffff` | `#151821` |
| surface-2 | `#eceef2` | `#1c202b` |
| line | `#dcdfe6` | `#2a2f3d` |
| line-strong (control borders) | `#858b99` | `#5f6679` |
| text | `#171a21` | `#e7e9ee` |
| muted | `#575d6c` | `#9aa1b2` |
| accent, back office (indigo) | `#3a4bd1` | `#9aa6ff` |
| accent, player page: Alpha (violet) | — | `#ab97ff` |
| accent, player page: Beta (cyan) | — | `#6cc6e0` |
| good | `#1b7340` | `#66d394` |
| bad | `#b42f26` | `#ff8c80` |
| warn | `#a04f00` | `#f2a465` |

The player page is always dark, so its accents have no light value.

Indigo and violet are neighbouring hues, so the two screens read as one product family with different accents. The neutrals are cool so nothing reads as warm or metallic. I computed contrast for every text and background pair in both schemes. The lowest text pair is muted text on the table header, 5.67:1, so everything passes AA. Button text is 6.8:1 on indigo and 7.6:1 on violet; white wheel labels are at least 6.98:1.

## Not looked at
- The Beta casino brand (I only checked its button contrast numerically).
- The Spins, Outbox, Waiting changes and Stuck pages.
- The demo controls panel.
- Hover and focus states in screenshots (only checked in CSS).
- The real stack on port 30080.

Files changed: `web/src/base.css`, `web/src/admin.css`, `web/src/play.css`, `web/src/sections/Overview.tsx`, plus one row in `docs/ai-log.md`.
````
