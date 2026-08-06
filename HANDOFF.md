# Handoff — Loom, end of this session

Read this before touching code. `PLAN.md` is the architecture/roadmap; this file is "what actually happened and what's next."

Session scope, in order: last session's priority #1 (visually verify the Inbox in a real browser — the previous session's biggest verification gap), then priority #2 ("merge" on `DiffView`, PLAN.md §6 A2's host-side push policy).

---

## What's real right now (not a mock, not a stub)

### Inbox — visually verified this session

Last session built keep/discard + the dead-run reaper + the Inbox view but could not click through it (browser extension unavailable). This session the extension connected and the full flow was verified live against the real dev DB: Inbox toggle renders, badge count refreshes correctly on entry and after actions, row selection populates the approval card and diff panel for the *inspected* run (independent of `activeRun`), "Load diff" renders real diff content, "Keep branch" posts the chat message and clears the row.

One real, pre-existing environment issue found and worked around during that verification, **then fixed at the end of the session** (see "Stale `runner.connected` flag" below): `stage2-runner` showed "connected" in the Runners panel but any dispatch to it (`agentRun.start`, `getDiff`) failed with "Runner ... is not connected". `verify-runner` was unaffected and is what got used for the rest of the session's verification.

### "Push & open PR" on `DiffView` (PLAN.md §6 A2 push policy) — built and live-verified

The third branch disposition, alongside `kept`/`discarded`: **`pushed`**. Two things reshaped PLAN.md's "merge" into "push" — found during design, not assumed:

- **No git remote/provider is tracked anywhere in the schema.** `repository` stores only `absolutePath`/`runnerId`/`defaultBranch`. A run's clone is `git clone <repository.absolutePath> <scratch-dir>` — the clone's own `origin` points at the local bound repo, not any upstream. The real upstream (if any) is read fresh, host-side, from `git -C <boundRepoPath> remote get-url origin` at push time — never stored, never agent-controlled.
- **No credential broker exists** (Phase 3). Per explicit direction this session, the push and any PR/MR creation reuse whatever git/`gh`/`glab` auth already lives on the **Runner host** — the same trust boundary the push itself already uses. No new credential storage anywhere.

Mechanics (`apps/runner/src/run-workspace.ts`'s new `pushRunBranch`):
1. Resolve the bound repo's `origin`. No `origin` configured → clean failure, **no disposition set** (unlike discard, a push failure must stay retriable — nothing was mutated).
2. `git diff --name-only <defaultBranch>...HEAD` → new domain classifier `packages/domain/src/push-policy.ts`'s `classifyPushEffect` (unit-tested, mirrors `risky-tools.ts`'s classify-then-gate shape) — rejects if the changed paths touch CI config (`.github/workflows/`, `.gitlab-ci.yml`, `.circleci/`) unless the request carries `acknowledgeCiChange: true`.
3. `git push <remoteUrl> HEAD:refs/heads/<branchName>` — force-push/tags/protected-branch are enforced **by construction**, not a runtime check: the target is always exactly the run's own trusted DB-stored branch name, as a plain push, never anything else. There is no code path that could push elsewhere.
4. Best-effort PR/MR: `gh pr create`/`glab mr create` if the remote host is `github.com`/`gitlab.com`; any failure (CLI missing, not authed) downgrades to a `warning` + a manually-constructed compare URL rather than failing the push. Unparseable or unrecognized remotes (e.g. a local bare-repo path, used for this session's own testing) get a plain "pushed, no PR attempted" message — never an error.

Full stack, mirroring keep/discard's existing shape exactly: `RunDispatchPort.pushRun` (`agent-ports.ts`) → `pushAgentRun` use-case (`agent-use-cases.ts`) → contract `agentRun.push` → router → `client-core`'s `pushRun` → Pinia `agent.ts` store → two new buttons on `DiffView.vue` ("Push & open PR" / a muted "Push anyway (CI/workflow changes)" for the rare override case) → wired through both `WorkspaceView.vue` usages and `InboxView.vue`'s re-emit, same pattern as `keep`/`discard`. New wire frames `push_run`/`push_result` in `packages/runner-protocol`, new `pendingPushes` map + dispatch case in `runner-gateway.ts`, new `push_run` case in `apps/runner/src/client.ts` (its per-run `runWorkspaces` map now also carries `sourcePath`/`branchName`, needed to resolve the remote and target ref without any new frame fields from the server). `AgentRunBranchDisposition` gained `'pushed'` — no migration needed, it's a plain validated `text` column, not a DB enum.

**Live-verified end to end**, via a throwaway runner + repo + local bare "remote" (not any of the existing `stage2`/`verify` scratch fixtures, and cleaned up after — see below):
- A real push landed the run's branch in the bare remote, `branchDisposition` became `'pushed'`, and the chat message correctly reported the graceful "no PR attempted, unparseable remote" fallback.
- A run that touched `.github/workflows/ci.yml` was correctly **rejected** (400, exact policy reason, branch never reached the remote) without `acknowledgeCiChange`, then **succeeded** once resubmitted with it.
- **The real `gh pr create`/`glab mr create` path has never executed** — no `github.com`/`gitlab.com` remote or token exists in this dev setup, so only the fallback branch has ever run. **Deliberately not being chased** (decided this session): the code stays, but nobody should treat verifying it as pending work. It's best-effort by design — every failure mode already degrades to "pushed, here's the compare URL" rather than failing the push, so the worst case if the CLI invocation is subtly wrong is a missing PR link on a push that still succeeded. Verify opportunistically if a real remote ever gets bound; don't build scaffolding for it.
- **The UI path is now verified too**, in a real browser against a fresh DB: signed in, ran `swe` on a bound repo, approved two real gates from the approval card (which rendered exact tool argv, not a model summary — §6 A3), loaded the diff, clicked **Push & open PR**, and confirmed all four buttons render (Keep / Discard / Push & open PR / the muted "Push anyway"), the panel switched to "Branch pushed." with the buttons removed, the Inbox emptied, `branch_disposition` became `pushed`, and the branch **plus its file content** actually landed in the bare remote.

### Stale `runner.connected` flag — fixed, but not runtime-verified

Root cause of the drift described above: `runner.connected` is set `true` on the `hello` handshake and cleared **only** in the socket close/error handler (`apps/server/src/runner-gateway.ts`). A server killed uncleanly (SIGKILL/crash — exactly what happened repeatedly across these sessions) never runs that handler, so every flag stays stale-true, while the next server process boots with an empty in-memory `connections` Map. The Runners panel reads the DB flag; dispatch reads the live Map. Hence "connected" in the UI, "not connected" on dispatch.

Fix: new `clearAllRunnerConnections(db)` in `packages/db/src/agent-repositories.ts`, called once at boot in `apps/server/src/app.ts` immediately before `registerRunnerGateway`. A fresh process owns zero live connections by definition, so the reset is always correct; anything genuinely alive re-sets its own flag through the Runner's existing 2s auto-reconnect. Documented inline as assuming a single server instance owns `/ws/runner` (true today; horizontal scaling per PLAN.md §7 Phase 4 would need per-instance connection ownership instead, since this reset is global).

**Verified behaviorally** (after Docker came back up): connected a real Runner (flag → true), `kill -9`'d both server and Runner so the close handler never ran, confirmed the flag was left **stale-true** with nothing alive — reproducing the original bug exactly — then booted the server and watched the flag flip to **false**. Also incidentally confirmed the self-heal path: an earlier attempt where the Runner process survived showed it reconnecting ~1s after boot and legitimately re-setting the flag to true, which is the intended behavior, not a regression. Full suite green including the previously-blocked 37 DB/Valkey tests.

### Test suite

104 → **110** tests. New: `packages/domain/src/push-policy.test.ts` (6 tests — CI-config detection per pattern, non-CI paths pass, `acknowledgeCiChange` override, empty changeset). `app.integration.test.ts`'s contract-completeness list now includes `push`. Everything else — `pnpm -r typecheck`, `npx eslint packages/ apps/`, `npx vitest run tools/architecture.test.ts` — clean.

---

## What's NOT built — do not assume these exist

Everything from the last handoff's list still applies except the Inbox visual-verification gap and "merge", which are struck. Restated:

- **No same-tool-call-N-times stuck detection.** Still deliberately not added — see previous handoffs' reasoning, unchanged.
- **No continuous Inbox polling.** Unchanged, deliberate.
- **No run resumption after a Runner restart, no idempotency keys, no budget caps, no global kill switch.** Unchanged, still flagged in PLAN.md §6/§7.
- **No container/microVM sandbox, no egress proxy, no credential broker.** Unchanged. The push feature explicitly does *not* introduce a credential broker — it reuses host-level git/`gh`/`glab` auth on the Runner, by design, per this session's direction. Don't read "push is built" as "credential broker is built."
- **No skills/MCP attachment.** Unchanged.
- **No UI test harness**, and the new push buttons specifically have not been clicked in a real browser (see above) — only exercised via direct RPC calls.
- Repository binding is still bind-by-absolute-path only; still no remote/provider column anywhere in the schema (push resolves `origin` fresh, host-side, every time — nothing new is persisted).
- `apps/tui` still doesn't exist.

---

## Immediate next steps, in priority order

1. **Global kill switch / pause-all** (PLAN.md §6 runtime safety: *"One button. Nothing had one."*) — the most self-contained of the remaining §6 gaps and the highest-value one: today there is no way to stop everything at once. Suggested starting point for the next session.
2. **Approval SLA** (§6: timeout → auto-deny → resumable) — smaller than the rest, and the approval round-trip it builds on is already working and now browser-verified.
3. **Run resumption + idempotency keys + budget caps** — still flagged in PLAN.md §6/§7, none implemented. Budget caps want cost metering at the proxy (§6 A6), which doesn't exist, so they're gated behind that.
5. **Container/microVM sandbox + egress proxy + credential broker** — still its own project, not a small PR. The push feature deliberately did not pull this forward.
6. Only after the above: Planner/Swarm (PLAN.md §7 Phase 2) — and PLAN.md §11's riskiest-assumption test (parallel workers on one repo) still hasn't been run.

## Things to NOT redo

- Everything in the previous handoffs' "do not redo" lists still applies.
- Don't add a credential broker "while you're in there" on the push feature — explicitly out of scope this session, by direction. Push/PR creation reuses host-level auth on purpose.
- Don't add a same-tool-call-N-times reaper heuristic without asking first.
- Don't add continuous Inbox polling casually.
- Don't move the Inbox toggle to `App.vue` without first also moving (or duplicating) `agent.start()` there.
- Don't assume `packages/application/src/agent-use-cases.ts` has FakeStore unit tests — it still doesn't, for any function, old or new (`pushAgentRun` included) — this project's established convention is manual/live verification for that file, not unit tests. `push-policy.ts` (pure domain logic) *does* get a unit test, same convention as `risky-tools.ts`.
- Don't go looking for the old `stage2-*`/`verify-repo` scratch rows or personas — the dev Postgres volume came up empty mid-session and both databases were rebuilt from migrations, so all of it is gone (see "Environment" below for exactly what's in the DB now). Any earlier handoff note about cleaning those up no longer applies.
- This session's dev processes (server/ws-gateway/web, plus the two long-lived leftover Runner processes from prior sessions) were all stopped during cleanup. Next session needs a fresh `pnpm dev` + re-paired Runners to pick back up, same as any normal cold start.

---

## Environment / how to run

See README.md. Unchanged except:

- No new migrations this session. `AgentRunBranchDisposition` gained `'pushed'` at the app-validation layer only (`branch_disposition` is a plain `text` column, not a DB enum) — nothing to migrate.
- No new env vars. Push/PR creation relies on whatever `git`/`gh`/`glab` config and auth already exist on the Runner host — nothing new to configure through Loom itself.
- **The dev Postgres volume was empty at the start of this session's second half** — the `loom`/`loom_test` databases had no schema, so both were re-created from scratch (`docker compose up -d`, `CREATE DATABASE loom_test`, `pnpm db:migrate` against each). Every prior scratch fixture (the old `stage2-*`/`verify-*` runners/repos, old personas, old runs) is therefore **gone** — the "don't leave scratch rows lying around" note from earlier handoffs is now moot. Current DB contains only this session's own verification fixtures (a `verify@example.test` account, `verify-runner`, `pushtest-repo`, a `#push-verify` channel, one pushed run); harmless, but that's all that's there.

## Verification commands (all currently passing)

```bash
pnpm -r typecheck
pnpm -r test                                # 110 tests
npx vitest run tools/architecture.test.ts   # 4 checks
npx eslint packages/ apps/                  # clean
```
