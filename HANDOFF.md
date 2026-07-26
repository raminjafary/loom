# Handoff — Loom, end of this session

Read this before touching code. `PLAN.md` is the architecture/roadmap (now includes a new §3a for the next planned feature); this file is "what actually happened and what's next."

Session scope was HANDOFF.md's four priorities from last time, all four landed, plus two real bugs your own live testing surfaced along the way. Honest framing up front: **Phase 1's mechanism is now substantially done, but Phase 1 is not ship-criterion-complete** — see "What's NOT built" below, don't skip it. Seven commits this session, in order:

```
f794209  feat: minimal UI for the agent-execution pipeline
26a823c  fix: CORS headers missing on real /api/auth and /rpc responses
056e4fa  fix: integration tests no longer truncate the dev database
17d7e07  feat: clone-per-run isolation for the agent Runner
224a1aa  feat: path-scoped write enforcement for risky tools
4947751  feat: persona storage CRUD (markdown + frontmatter)
845592f  style: give the activity feed and sidebar visual structure
```

Read PLAN.md §3a (new), §5a, §6, §7 Phase 1 before making changes.

---

## What's real right now (not a mock, not a stub)

**A real UI**, not just RPC scripts: mint pairing tokens and see connected Runners (`RunnerPanel.vue`), bind a repo (`RepositoryPanel.vue`), write or pick a persona and start a run (`PersonaForm.vue`), approve/deny risky-tool gates from a live-polled card (`ApprovalCard.vue`), view a run's branch diff on demand (`DiffView.vue`). All wired through a new `agent-session.ts` in `@loom/client-core`, parallel to the existing `workspace-session.ts`, polling `agentRun.get`/`approval.listPending` since there's still no realtime frame for agent-run state (`ServerEvent` only carries message/channel/thread).

**Clone-per-run isolation (PLAN.md §5a), live-verified.** The Runner clones the bound repo into a per-run scratch workspace (`apps/runner/src/run-workspace.ts`) before invoking the SDK — `git clone`, checkout `loom/run-<id>`, `core.hooksPath=/dev/null`, `core.fsmonitor=false`. `agent_run.clonePath`/`branchName` persist once the Runner reports the workspace is ready. `agentRun.getDiff` fetches the branch diff on demand through the same request/response pattern `checkPath` already used. Verified with a real run: separate clone dir, correct branch, hooksPath set, original bound repo untouched.

**Path-scoped write enforcement (PLAN.md §6 A3, the honest subset).** `classifyToolEffect` (`packages/domain/src/risky-tools.ts`) resolves a Write/Edit/NotebookEdit target against the run's clone and auto-denies anything outside it — no human round-trip, since it's not a judgment call. `Bash` still gates by name only; no reliable static argv classifier exists for arbitrary shell, and building one isn't attempted. Verified live: a persona told to write to `/tmp/...` outside its clone was auto-denied, no file created, no stuck approval. **Note the real near-miss this caught**: before this landed, the same persona actually escaped its clone via a plain absolute path and wrote to `/tmp` successfully — that's exactly the gap this closes.

**Persona storage CRUD (PLAN.md §4e Phase 1 subset).** Hand-rolled markdown+frontmatter parser (`packages/domain/src/persona-markdown.ts` — `name`/`description`/`model`/`tools`/`harness.effort`/`harness.maxTurns`; no MCP/skills, that needs the Phase 2 registry). Real `agent_persona` table, `persona.create/list/get/update`. `agentRun.start` now takes `personaId`, not an inline `PersonaSpec` — the use-case denormalizes a frozen `PersonaSpec` snapshot onto the run at start time, so editing a persona never changes an in-flight run. Verified live: create/list/get/update and duplicate-name rejection against the real dev DB.

**89 automated tests, all passing** (was 69 at last handoff — +20 from this session: `risky-tools.test.ts`, `persona-markdown.test.ts`, `resolveWithinRoot` cases in `path-check.test.ts`). None call the real Claude Agent SDK; that's still verified manually (this session's live-verification steps above did cost real tokens, on trivial haiku prompts each time — see the commit messages for what was checked).

---

## Bugs found and fixed this session

1. **CORS headers silently missing on every real `/api/auth` and `/rpc` response** (`apps/server/src/app.ts`) — `toNodeHandler` and `RPCHandler#handle` both write straight to `reply.raw`, bypassing Fastify's send lifecycle that `@fastify/cors` hooks into. The OPTIONS preflight worked (short-circuited earlier, before the route handler runs); every real response was missing `Access-Control-Allow-Origin`/`-Credentials`, so the browser accepted cookies but silently refused to hand the response body to JS — auth appeared to "hang" with no error the app itself could see. Caught because the user was live-testing sign-in in a real browser, not just via curl (curl ignores CORS entirely, so scripted smoke tests never would have caught this). Fixed by setting the two headers by hand before the raw-write calls.
2. **Integration tests were truncating the real dev database** (`packages/db/src/repositories.integration.test.ts`) — that suite does `TRUNCATE ... workspace CASCADE` in `beforeEach` to reseed its own fixtures, but it pointed at the same `DATABASE_URL` a developer uses by hand. Running `pnpm -r test` while also using the app live wiped the live workspace/runners/repos mid-session. Fixed: `NODE_ENV=test` now always resolves `DATABASE_URL` to a separate `TEST_DATABASE_URL` (`loom_test`, same server, own database — see README's "Create a second database" step, already run this session). **Anyone who hasn't created `loom_test` yet needs to before running tests** — it now defaults there unconditionally under `NODE_ENV=test`.
3. **Duplicate auto-deny message** (`apps/runner/src/claude-agent-adapter.ts`) — the new path-scoped auto-deny emitted its own `tool_result` event on top of the one the SDK already reports naturally when `canUseTool` denies (the deny `message` becomes the tool's own reported result). Fixed by removing the redundant manual emission — caught from a live screenshot the user sent showing the same denial line rendered twice.

---

## What's NOT built — do not assume these exist

Everything from the last handoff's list still applies except the four items that closed this session (UI, clone-per-run, path-scoped gating, persona CRUD — struck from that list). Additionally, now that the UI actually exists, these gaps are sharper and worth restating against **PLAN.md §7 Phase 1's own ship criterion** ("a human creates a persona, `@mention`s it, watches it work, is notified when it needs them, approves a gate, merges a reviewed diff, with no path by which the agent could push on its own"):

- **No `@mention`.** Starting a run is a static sidebar picker (repo dropdown + persona dropdown + button), not something triggered by addressing an agent in a channel. **This is the next planned slice — see PLAN.md §3a, added this session, not yet built.**
- **No built-in personas, no persona groups ("Teams").** Every persona has to be hand-authored from nothing. PLAN.md §3a plans seven seeded roles (PM, SWE, Frontend/Backend Engineer, QA, Security Reviewer, Solution Architect) and an organizational persona-grouping UI — scoped explicitly as *not* parallel execution (that's still Phase 2 swarm territory).
- **No merge/keep/discard on the diff.** `DiffView.vue` only *displays* the branch diff; there's no action to actually merge, keep the branch, or discard it.
- **No real inbox/notifications.** Approval only surfaces in-thread; there's no separate "3 runs need you" surface (PLAN.md §3's own stated center of gravity, not built).
- **No run resumption after a Runner restart, no idempotency keys, no stuck-run detection, no budget caps, no global kill switch** — all still flagged in PLAN.md §6/§7 as required runtime safety mechanics, none implemented.
- **No container/microVM sandbox, no egress proxy, no credential broker, no host-side git-push policy.** The agent has no way to push at all yet, so there's nothing to gate on that front. This is a genuinely separate, substantial project (container/VM rewrite of the Runner's execution model) — flagged, not attempted.
- **No skills/MCP attachment** — needs the Phase 2 capability registry (PLAN.md §4e).
- Repository binding is still bind-by-absolute-path only, deliberately — a real directory picker needs the Runner to expose a `listDirectory` capability that doesn't exist (confirmed with the user this session: kept as typed-path for now).
- `apps/tui` still doesn't exist (contract-agnosticism is enforced by the architecture test + lint rule, not proven by a second real client).
- No UI test harness — the new Vue components (`RunnerPanel`, `RepositoryPanel`, `PersonaForm`, `ApprovalCard`, `DiffView`) have no automated component tests, only manual live verification this session.

---

## Immediate next steps, in priority order

1. **Built-in personas, persona groups, and `@mention`-starts-a-run — PLAN.md §3a, planned this session, not started.** This was actually being scoped and about to enter implementation when the session ended (user asked to pick it up next time instead). Full design is written into PLAN.md §3a: seven seeded personas per workspace (real editable rows, seeded off `ensureWorkspace`'s currently-discarded `created` flag — see `packages/db/src/membership.ts`), a persona-grouping UI (click/drag chips, organizational only), and `@mention` in `Composer.vue` that both posts the chat message and starts a run — which needs a new optional `task` field threaded from `agentRun.start` through to the Runner's SDK prompt (today the Runner always prompts a fixed "begin working now" regardless of persona). Read PLAN.md §3a's "Explicit non-scope" paragraph before starting — it names three deliberate cuts (no per-channel roster, no channel-repo binding, single-active-run limit preserved) that are easy to accidentally scope-creep past.
2. **Merge/keep/discard on `DiffView`** — the diff is real and reviewable (this session), but there's no action button. Needs the host-side push policy PLAN.md §6 A2 describes (agent never holds git credentials; the Runner pushes after a policy check) — at minimum "keep the branch" and "discard" don't need that policy work and could land first.
3. **Inbox/notifications + stuck-run detection** — PLAN.md §3 calls this the actual job-to-be-done, ahead of the tree view. Still nothing built.
4. **Container/microVM sandbox + egress proxy + credential broker** — flagged as its own project in the previous handoff, still true. Don't fold this into a small PR; it's a rewrite of how the Runner executes tools (in-process SDK call → subprocess/container boundary).
5. Only after the above: Planner/Swarm (PLAN.md §7 Phase 2) — and PLAN.md §11's riskiest-assumption test (parallel workers on one repo, net-positive or not) still hasn't been run. Do that cheaply before building a merge queue or tree view on an unvalidated assumption.

## Things to NOT redo

- Everything in the previous handoff's list still applies (don't move `/ws/runner` back to `apps/ws-gateway`, don't add hard FKs on actor/resolver columns, don't reintroduce `tsc -b` project references, don't put a real SDK call in the automated test suite).
- Don't point integration tests at the same `DATABASE_URL` a developer uses by hand — that's exactly bug #2 above. `NODE_ENV=test` now forces `TEST_DATABASE_URL`; don't override that per-test-file.
- Don't add a `channel_persona`/`channel_team` membership table for `@mention` without re-reading PLAN.md §3a's non-scope paragraph first — it was deliberately left out, not forgotten.
- Don't mention a persona **group** to start multiple runs — groups are organizational only; the single-active-run limitation is preserved on purpose, not an oversight to "helpfully" fix while touching that code.
- When generating a handoff doc, write it to the repo's actual `HANDOFF.md` at root (this file) — not a new `handoffs/` subdirectory. README.md and PLAN.md both link to `HANDOFF.md` by that exact path; a differently-named/located file just goes stale and unlinked. (A `handoffs/HANDOFF-2026-07-26-0917.md` was auto-generated this session and folded into this file instead of being kept as a second copy.)

---

## Environment / how to run

See README.md — kept current this session. Quick reference:

- Postgres 18 + Valkey 9 via `docker compose up -d`.
- `.env` needs a real `BETTER_AUTH_SECRET` (32+ chars) and now also `TEST_DATABASE_URL` (see `.env.example`) — create the second database once: `docker compose exec postgres psql -U loom -d loom -c "CREATE DATABASE loom_test;"` then `DATABASE_URL=postgres://loom:loom@localhost:5432/loom_test pnpm db:migrate`.
- Three long-running processes: `apps/server` (:3001, owns `/rpc` and `/ws/runner`), `apps/ws-gateway` (:3002, `/ws/client` only), `apps/web` (:5173, everything above is reachable from its sidebar now).
- `apps/runner` is started separately, per-machine, with `LOOM_SERVER_WS_URL`/`LOOM_PAIRING_TOKEN`/`LOOM_ALLOWED_ROOTS` — not part of the docker-compose stack, not auto-started.
- Migrations: `pnpm db:migrate` from repo root, applied to **both** `loom` and `loom_test` databases now (two migrations landed this session: `0004` clonePath/branchName, `0005` agent_persona).

## Verification commands (all currently passing)

```bash
pnpm -r typecheck
pnpm -r test                                # 89 tests
npx vitest run tools/architecture.test.ts   # 4 checks
npx eslint packages/ apps/                  # clean
```
