# Brief 16: behind the scenes link

Wave 7. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
Repository: a NestJS backend with a React app in `web/` (hash routes `#/play` for the player page and `#/admin/...` for the back office). Read `CLAUDE.md` first and follow it. Do NOT read `CLAUDE.local.md` or `.private/`. Touch only files under `web/` and one row in `docs/ai-log.md`. Do not touch `src/`, `test/`, `docker-compose.yml`.

## Change
On the player page (`web/src/pages/PlayPage.tsx`) there is a control "See what happened behind the scenes" that opens a drawer (`web/src/components/BehindScenes.tsx`, with helpers such as `CallDetail.tsx`, `narrate.ts`, `curl.ts`). The drawer retells in its own words what the back office already shows from the server. Replace it:

1. The control becomes a link that opens, in a new tab (`target="_blank" rel="noopener"`), the back office page of THIS player in THIS tenant: the existing player detail route. Build the hash with `buildAdminHash` from `web/src/admin/routes.ts`; read that file and `web/src/sections/PlayerAndEvent.tsx` to see the exact route and which id it takes (our internal player uuid; the player page gets it from `GET /me` — check `web/src/api.ts` / `state.ts`; if the page does not keep it yet, keep it).
2. Before the player exists on our side (no deposit yet, so no uuid), the link goes to the tenant's overview in the back office instead.
3. Deep link after sign-in: opening `#/admin/...player...` while signed out must show the sign-in form and, after a successful sign-in, land on that same player page, not on the default page. Check `web/src/admin/AdminApp.tsx` / `SignIn.tsx`; fix if it does not already work. Also: a tenant admin of the other tenant gets the normal "not found / not allowed" behaviour, nothing special.
4. The link sits outside the widget frame (it is a demo aid, a real player never sees it), with a small "demo" tag and the text "See what happened behind the scenes" plus a short hint "opens the back office". Keep the visual style of the existing demo controls.
5. Remove the drawer and every file that becomes unused because of it (components, helpers, their tests, CSS rules). Check with grep that nothing else imports them before deleting; keep what is still used elsewhere.
6. Update `web/dev/mock-server.mjs` only if needed.

## Tests
Unit tests (vitest, as the other `web/src/*.test.ts`): the function that builds the link gives the player route when the uuid is known and the overview route when it is not; the sign-in return-to-deep-link logic if you had to write any. Mutation check: break the function on purpose, see the test fail, restore.

## Verify
`npm run verify:web` must be green (run from repo root; see package.json). If you can, also look at the page in headless Chrome against `node web/dev/mock-server.mjs` or the built app, at 1440 and 390 px width, and look at the screenshots yourself. Do not start docker compose on default ports (the author's demo stack is running on 30080/30081).

## Commit
One commit on your worktree branch, message describing the change and how it was checked, no tool names, no attribution or co-author lines. Add one row to the end of the table in `docs/ai-log.md` in the same commit: `| HH:MM | what | Author (the link goes to the back office instead of a drawer); agent (details) | how checked |` using `date +%H:%M`. Do not push.

## Report
Short: what changed, files deleted, what can break and which test catches it, what was not checked.
````

## The agent's report

````text
The "See what happened behind the scenes" control on the player page is now a link to the back office. It is committed as `8850a87` on the worktree branch and not pushed. `npm run verify:web` is green with 98 tests, and I looked at screenshots of the player page at 1440 and 390 px against the mock server.

**What changed**
- **Link:** it opens in a new tab with `target="_blank" rel="noopener"`. It goes to `#/admin/players/<uuid>?tenant=<tenantId>`, using the uuid from `me.playerId` that the page already keeps. Before the player exists it goes to `#/admin/overview?tenant=<tenantId>`. The new builder is `backOfficeHash` in `web/src/back-office-link.ts`.
- **Placement and style:** the link sits below the widget frame, with a small "demo" tag and the hint "opens the back office". The CSS is in `play.css`.
- **Tenant for platform admins:** a platform admin opening the link in a new tab would have landed in the first tenant, because the tab has no tenant stored. I added `?tenant=` handling in `web/src/admin/AdminApp.tsx`: a known id from the link becomes the picked tenant, and the dropdown still works afterwards. This was not in your brief.
- **Deep link after sign-in:** this already worked, so I wrote no code for it. Sign-in does not touch the hash, so a signed-out user sees the form and then lands on the same page.
- **Other tenant's admin:** a tenant admin of the other tenant is pinned to their own tenant and gets the existing "Not found for this tenant." for the player.
- **Mock server:** no change needed.

**Files deleted:** `web/src/components/BehindScenes.tsx`, `web/src/components/CallDetail.tsx`, `web/src/narrate.ts`, `web/src/narrate.test.ts`, `web/src/curl.ts`. I also removed the drawer CSS from `play.css` and the `.call` rules from `base.css`. I kept `.tl-mark` and `state.log`, because `Rewards.tsx` and the store still use them.

**What can break and what catches it**
- `web/src/back-office-link.test.ts` checks that the player route is built when the uuid is known, the overview route when it is not, and that the tenant is left out when it is empty. As a mutation check I changed the player section to `events` and the test failed. I then restored it.
- The `?tenant=` handling and the sign-in return are not covered by a unit test. That code is a component effect, and there was no sign-in logic to test.

**Not checked**
- I did not click through a real sign-in with a platform admin and a tenant admin. Only the player page was screenshotted.
- Chrome headless would not go narrower than about 500 px, so the 390 px shot is cropped on the right. That cropping was already there before this change.
- I did not run the real docker stack.

`docs/ai-log.md` has the one new row, in the same commit.
````
