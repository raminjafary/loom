# Handoff — Loom, end of this session

Read this before touching code. It tells you exactly what's real, what's stubbed, and what to do next — so you don't re-derive context or redo verified work. `PLAN.md` is the architecture/roadmap; this file is "what actually happened and what's next."

Session scope was originally framed as "implement Phase 1." Honest accounting: **most of Phase 1's hard mechanism is built and live-verified**, but real gaps remain (listed below, don't skip that section). Four commits this session, in order:

```
a0a85db  Phase 0 foundation — layered realtime workspace
4fb9ce5  Better Auth swap
ae4bef7  Repository binding + agent run/approval protocol
fcd495a  apps/runner — real Claude Agent SDK integration
```

Read PLAN.md §4a–§4e, §5a, §6, §7 Phase 1 before making changes — this session's work implements those sections directly and the file has been kept current, including corrections made mid-build.

---

## What's real right now (not a mock, not a stub)

**Auth.** Real Better Auth (1.6.25) — sign-up/sign-in through `/api/auth/*`, sessions resolved server-side via `auth.api.getSession`, workspace auto-provisioned on first login. `devAuth` still exists (`apps/server/src/auth.ts`) but is test-only — never wired as the default in `buildApp` unless explicitly passed.

**The full agent-execution pipeline, live-verified end to end:**
1. A Runner (`apps/runner`) pairs with the server over `/ws/runner` using a hashed pairing token.
2. It validates a real path against its allowed roots (realpath-resolved, symlink-safe — see the bug fixed below) and confirms it's a git repo.
3. The server persists a `repository` row bound to that Runner.
4. `agentRun.start` dispatches a real job to the Runner, which imports `@anthropic-ai/claude-agent-sdk` **as a library** (not a subprocess) and calls `query()`.
5. The SDK's message stream is mapped to four structured event kinds (assistant_text, tool_call, tool_result, run_completed/run_failed — PLAN.md §4d-bis) and streamed back over the same socket.
6. The server persists each event as a `message` (actor = the agent_run) and publishes it over Valkey, so it renders live in the thread exactly like a human message.
7. Risky tools (`Bash`/`Write`/`Edit`/`NotebookEdit`) pause via the SDK's `canUseTool` callback, which sends a `permission_request` to the server, creates an `approval_request` row, and posts a card message — the Runner's promise doesn't resolve until a human calls `approval.decide` and the server relays `permission_response` back.
8. **Only a `user`-kind actor can call `decideApproval`** — enforced in `packages/application/src/agent-use-cases.ts`, closing the exact forgery flaw PLAN.md §6 A1 flagged in the original plan review.

This was proven with a real (not mocked) Claude Agent SDK call: paired a Runner, bound a throwaway git repo, ran a trivial Read-only persona (haiku model), and watched Claude try a relative path, get a real tool error, self-correct to the absolute path, and return a planted marker phrase from the actual file — see the commit message on `fcd495a` for the full transcript. Cost was $0.0126, captured from the SDK's own result message into `agent_run.totalCostUsd`.

**69 automated tests, all passing**, none of which call the real SDK (that costs real tokens — the live proof above was manual, not part of the suite). `pnpm -r test`, `pnpm -r typecheck`, the architecture boundary test, and ESLint are all clean as of the last commit.

---

## Bugs found and fixed this session (worth knowing, not just "trust the tests")

1. **Symlink escape in path validation** (`apps/runner/src/path-check.ts`): comparing a realpath-resolved target against an *unresolved* allowed root silently rejected every valid repo on macOS, where `/tmp` → `/private/tmp`. Caught by the test suite, not by inspection. Fixed by resolving both sides. This is the actual security boundary from PLAN.md §5a — a naive version of this check would have been bypassable by symlink, not just broken.
2. **Runner-facing WS traffic needs a database** — PLAN.md originally put `/ws/runner` on the stateless `apps/ws-gateway`. Corrected mid-build: it moved to `apps/server`, documented in PLAN.md §4c note and in the `ws-gateway`/`server` source comments. Don't move it back without re-solving that constraint.
3. **`decideApproval`'s only path to the Runner was via `approvalRequestId`**, which the Runner never sees — fixed to key on `toolUseId` (what the SDK's `canUseTool` actually holds), which also simplified the wire protocol.
4. **No way for any client to retrieve a pending approval's id** — the approval card only had human-readable text embedding the id. Added `approval.listPending` before it became a real API gap for whatever builds the approval UI next.
5. **Test-isolation bug**: a test file built its app/workspace once in `beforeAll` and truncated `workspace` itself in every `beforeEach` — the second test onward inserted against a workspace row that no longer existed. Fixed by making `truncateDomainTables` cover the new agent tables *without* touching `workspace`, and reserving `truncateAll` for files that intentionally rebuild the workspace per test.
6. **Unhandled rejection on Runner disconnect during shutdown** — `setRunnerConnection` fired without a catch; a closing DB pool mid-shutdown surfaced as an unhandled rejection instead of being swallowed. Fixed.
7. **`approval_request.resolvedByUserId` had a hard FK to `user.id`** that broke every `devAuth`-based test (synthetic user ids aren't real Better Auth rows). Dropped, consistent with the existing actor-column pattern elsewhere in the schema.

---

## What's NOT built — do not assume these exist

- **No persona CRUD or markdown/git-backed persona storage.** `PersonaSpec` is inline JSON passed directly to `agentRun.start` and stored as a JSONB blob on `agent_run`. PLAN.md §4/§4e's markdown-with-frontmatter format, the visual persona builder, and git-backed versioning are all still just plan, not code.
- **No directory picker or `git init` flow for repository binding.** `repository.bindExisting` requires the caller to already know the absolute path. PLAN.md §5a's `listDirectory` capability doesn't exist.
- **Risky-tool classification is a hardcoded name list** (`packages/domain/src/risky-tools.ts`). PLAN.md §6 A3 already says this isn't a real security boundary long-term (`Bash` subsumes everything). It's the documented Phase 1 starting point, not a finished design — don't treat it as done.
- **No sandbox hardening.** The Runner executes with the same filesystem/network access as the process running it — no network egress policy, no resource limits, no read-only mounts. PLAN.md §6 A5/§8 (Kata/microsandbox) is unimplemented. Running this against anything you don't trust is not safe yet.
- **No planner/swarm.** Everything above is one Worker persona running once. Planner decomposition, `parent_run_id` hierarchies, the merge queue, and the tree view (PLAN.md §7 Phase 2) don't exist.
- **No notifications/inbox** — the retention hook PLAN.md §3 calls out as more important than the live stream doesn't exist.
- **No stuck-run detection, no idempotency keys, no budget enforcement, no global kill switch** — all flagged in PLAN.md §6 as required runtime safety mechanics, none implemented.
- **`apps/tui`** (the second driving-side client that was supposed to validate the contract stays client-agnostic, PLAN.md §4c) was never built. The contract boundary is enforced by the architecture test and ESLint rules, not proven by a second real client.
- **No UI for any of the agent-execution pipeline.** `apps/web` still only renders plain chat (Phase 0's `ChannelList`/`MessageList`/`Composer`). Agent runs and approvals are currently only reachable via direct RPC calls (see the smoke-test pattern in the `fcd495a` commit message, or write a throwaway script like the ones used and removed during this session).
- **No git-worktree/clone-per-run isolation.** The Runner ran the smoke test directly against a repo's working directory. PLAN.md §5a's clone-per-run requirement (needed because `git worktree` shares `.git` and isn't real isolation) is not implemented — right now, concurrent runs against the same repo would collide.

---

## Immediate next steps, in priority order

1. **Minimal UI for the agent pipeline.** Highest leverage: without this, every verification is a hand-written script. At minimum: a way to create a pairing token and see connected Runners, a repo-binding form, an `@mention`-or-button way to start a run with a persona, and rendering for the approval card (currently just a system-message string — needs an actual approve/deny UI hitting `approval.decide`). Touches `apps/web/src/components/`, `packages/client-core/src/workspace-session.ts` (extend the session model to track agent_run/approval state), and `packages/api-contract` only if new procedures are needed (unlikely — the contract already covers this).
2. **Clone-per-run isolation** (PLAN.md §5a). Runner currently runs directly in the bound repo's working directory. Add: clone (not worktree) into a scratch dir per run, `core.hooksPath=/dev/null`, and the branch/diff-review/merge flow described in §5a. Lives in `apps/runner` (new module, e.g. `run-workspace.ts`), called from `client.ts`'s `start_run` handler before invoking `runAgent`.
3. **Effect-based tool gating, not name-based** (PLAN.md §6 A3). Replace/augment `isRiskyTool` with real sandboxing — at minimum, network egress policy and path-scoped write access, enforced where the Runner actually executes tools, not just as a permission prompt.
4. **Persona storage** — move off inline JSON toward the markdown+frontmatter format in PLAN.md §4e, at least for read/CRUD; git-backed versioning can come later.
5. Only after the above: Planner/Swarm (PLAN.md §7 Phase 2) — and remember PLAN.md §11's riskiest-assumption test (whether parallel workers on one repo net-positive) hasn't been run yet. Do that cheaply before building the merge queue/tree view on top of an unvalidated assumption.

## Things to NOT redo

- Don't move `/ws/runner` back to `apps/ws-gateway` — see bug #2 above and PLAN.md §4c.
- Don't add a hard FK on `message.actorUserId`/`actorAgentRunId`/`approval_request.resolvedByUserId` — deliberate, see bug #7 and the comments in `packages/db/src/schema.ts`.
- Don't reintroduce composite TypeScript project references (`tsc -b`) — removed in Phase 0 for being pure friction given packages export source directly.
- Don't add the real Claude Agent SDK call into the automated `pnpm test` suite — it costs real API tokens per run. Verify manually with a throwaway script when you need to (pattern: `smoke-daemon.mjs` + `smoke-drive.mjs` from this session, both deleted after use — recreate similarly if needed, and delete again after).

---

## Environment / how to run

See README.md — it's current as of this session. Quick reference:

- Postgres 18 + Valkey 9 via `docker compose up -d`.
- `.env` needs a real `BETTER_AUTH_SECRET` (32+ chars) — `openssl rand -base64 32`.
- Three long-running processes: `apps/server` (:3001, owns `/rpc` and `/ws/runner`), `apps/ws-gateway` (:3002, `/ws/client` only), `apps/web` (:5173).
- `apps/runner` is started separately, per-machine, with `LOOM_SERVER_WS_URL` / `LOOM_PAIRING_TOKEN` / `LOOM_ALLOWED_ROOTS` env vars — it is not part of the docker-compose stack and isn't auto-started by anything.
- Migrations: `pnpm db:migrate` from repo root (delegates to `@loom/db`). Four migrations exist (`0000`–`0003`), all applied to the local dev DB as of this session.

## Verification commands (all currently passing)

```bash
pnpm -r typecheck
pnpm -r test                                # 69 tests
npx vitest run tools/architecture.test.ts   # 4 checks
npx eslint packages/ apps/                  # clean
```
