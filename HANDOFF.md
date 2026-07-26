# Handoff — Loom, end of this session

Read this before touching code. `PLAN.md` is the architecture/roadmap (§3a is now marked **[BUILT]**); this file is "what actually happened and what's next."

Session scope: last session's priority #1 (PLAN.md §3a — built-in personas, persona groups, `@mention` starts a run), plus one feature added mid-session on explicit request (per-persona auto-approve), plus two real gaps found during live verification and fixed on the spot. Three commits, in order:

```
8e675cc  feat: built-in personas, persona groups, @mention starts a run
2872e91  feat: per-persona auto-approve, skip the human approval round-trip
9c200a2  fix: post a visible chat message when a run fails to dispatch
```

Read PLAN.md §3a, §7 Phase 1 before making changes.

---

## What's real right now (not a mock, not a stub)

**Built-in personas, seeded once per workspace.** Seven roles (`packages/domain/src/builtin-personas.ts`: Product Manager, SWE, Frontend Engineer, Backend Engineer, QA, Security Reviewer, Solution Architect) are real, editable `agent_persona` rows, not templates — same table, same CRUD path a hand-authored persona uses. Seeded exactly once per workspace, keyed off `ensureWorkspace`'s `created` flag, now threaded up through `ensureWorkspaceMembership` (`packages/db/src/membership.ts`) → `WorkspaceMembership.ensureMembership` (`apps/server/src/auth.ts`) → `apps/server/src/app.ts`'s wiring, where `seedBuiltinPersonas` (`packages/application/src/agent-use-cases.ts`) fires only when `created: true`. **Live-verified twice**: a fresh workspace got exactly 7 personas; re-authenticating against the same workspace didn't duplicate them. Tool sets differ by role (Security Reviewer/PM/Solution Architect stay read-only `[Read, Grep, Glob]`; engineering roles get `[Read, Edit, Write, Bash, Grep, Glob]`; QA gets `[Read, Grep, Glob, Bash]`, no `Write` — it has to run tests via `Bash`, which matters below).

**Persona groups, organizational only.** New `persona_group` table (`personaIds: string[]` as jsonb, same convention as `agentPersona.tools` — no join table, since there's no per-attachment metadata). Full CRUD through the contract (`personaGroup.list/create/update/delete`), a `PersonaGroupPanel.vue` in the sidebar (click a persona chip to toggle membership, immediate save). Doesn't start anything, doesn't bind to a channel — exactly per PLAN.md §3a's non-scope paragraph. Live-verified: created, toggled membership, deleted, all through the real UI against the real DB.

**`@mention` starts a run, with the mentioned text as the actual task.** `Composer.vue` has real autocomplete (typing `@qa` shows matching personas with descriptions) and, on send, still posts the message as ordinary chat — but if it parses as a mention of a known persona (`packages/client-core/src/mention.ts`), `WorkspaceView.vue` shows an inline "Start `<persona>` on: `<repo picker>`" bar. Confirming it calls `agentRun.start` with a new optional `task` field, threaded all the way through `contract.ts` → `router.ts` → `startAgentRun` → `RunDispatchPort.startRun` → the `start_run` wire frame (`packages/runner-protocol/src/protocol.ts`) → `apps/runner/src/client.ts` → `claude-agent-adapter.ts`, where the prompt is now `You are {persona}. {task}` instead of the previous always-fixed `"Begin working now."`. **Live-verified end to end, twice**: `@qa write your name to a file called qa-verify.txt` → the QA persona (no `Write` tool) correctly reached for `Bash` instead, correctly triggered the risky-tool approval gate, got approved, and actually wrote the file with the right content. Second run confirmed the SDK really receives the mentioned text as its task, not a generic prompt.

**Single-active-run guard, server-side.** `AgentRunRepositoryPort.findActiveByWorkspace` (new) backs a check at the top of `startAgentRun`: if any non-terminal run exists in the workspace, it throws a `ValidationError` (→ `400 BAD_REQUEST`, not 409 — the auto-generated draft of this handoff said 409, that was wrong) with a clear message, surfaced via `agentSnapshot.error`. **Live-verified**: a genuinely stale `running` row from before this session (never reaped — see "no stuck-run detection" in the not-built list) correctly blocked a new mention-start until manually marked terminal; then a real second run correctly refused to start while the first was still active.

**`agentRun.getActive` — resume watching an active run after a reload.** Found live, not speculative: reloading the page during an active run left *zero* path back to its approval card (nothing in `init()` re-fetched run/approval state). New contract endpoint + `agent-session.ts` change: on `init()`, fetch the workspace's active run (if any) and resume polling immediately. Fixed and reloaded live to confirm the approval card came back.

**Per-persona `harness.autoApprove`** (not in original §3a scope — added mid-session on explicit request, after clarifying scope: per-persona opt-in, not a global bypass). New `harness.autoApprove: true` frontmatter field (`persona-markdown.ts`), new `agent_persona.harness_auto_approve` column, threaded through `PersonaSpec`/`WirePersonaSpec` to the Runner's `canUseTool`: when true, skips the human approval round-trip for that run's risky tools. **The path-scoped write boundary (classifyEffect) is never skipped** — that's a hard boundary, not a judgment call, and autoApprove only ever touches the "ask a human" step. **Live-verified**: created a real persona with `autoApprove: true`, mentioned it, watched it run `Bash: echo autoapprove-worked` to completion with **zero** `approval_request` rows created — confirmed directly against the DB, not inferred from the UI.

**Dispatch-failure visibility fix.** Found live: when `dispatch.startRun` throws (e.g. Runner not connected), the run was marked `failed` in the DB but nothing was ever posted to the thread — every *other* failure mode (`run_failed`, approval-needed) posts a system message, this was the one silent exception. Fixed in `startAgentRun`'s catch block. Live-verified: intentionally started a run against a repo bound to a disconnected Runner, saw `✗ Run failed to start: Runner ... is not connected` appear in chat.

**104 automated tests, all passing** (was 89 at last handoff). New: `builtin-personas.test.ts`, `mention.test.ts`, plus new cases in `persona-markdown.test.ts` (harness.autoApprove parse/serialize round-trip) and `app.integration.test.ts` (contract-completeness list updated for `personaGroup` and `agentRun.getActive`). None call the real Claude Agent SDK — as before, that's verified manually, and this session did substantially more manual verification than usual because the feature is inherently interactive (chat + autocomplete + inline UI).

---

## Bugs/gaps found and fixed this session

1. **`tsx watch` + Node 24's native `--env-file` flag.** `apps/server`/`apps/ws-gateway`'s dev script was `tsx --env-file=../../.env watch src/main.ts` — Node 24.18 now recognizes `--env-file` natively and appears to consume it ahead of tsx's own CLI parsing, breaking tsx's "is the first arg `watch`?" detection; it tried to import a module literally named `watch`. Fixed by reordering: `tsx watch --env-file=../../.env src/main.ts` (`watch` first). Confirmed `pnpm dev` now starts all three (server/ws-gateway/web) cleanly with live-reload intact.
2. **Reload loses all run/approval visibility** (see `agentRun.getActive` above) — fixed.
3. **Dispatch failures were silent in chat** (see above) — fixed.

---

## What's NOT built — do not assume these exist

Everything from the last handoff's "not built" list still applies except `@mention`/built-in-personas/persona-groups, which are struck. Restated against PLAN.md §7 Phase 1's ship criterion:

- **No merge/keep/discard on `DiffView`.** Still only displays the branch diff; no action button. Needs PLAN.md §6 A2's host-side push policy for "merge," but "keep the branch"/"discard" don't need that and could land without it.
- **No real inbox/notifications.** Approval only surfaces in-thread; PLAN.md §3's own stated center of gravity ("3 runs need you") still doesn't exist.
- **No stuck-run detection, no dead-run reaper, no run resumption after a Runner restart, no idempotency keys, no budget caps, no global kill switch.** The stale `running` row this session's single-active-run guard tripped over is a live example of exactly this gap — nothing currently marks an abandoned run terminal.
- **No container/microVM sandbox, no egress proxy, no credential broker, no host-side git-push policy.** Unchanged, still a separate project.
- **No skills/MCP attachment.** Unchanged — needs the Phase 2 capability registry.
- **No UI test harness.** `PersonaGroupPanel.vue`, the Composer autocomplete, and the mention-bar have no automated component tests, only this session's live verification.
- **`autoApprove` has no UI toggle** — it's raw-markdown-only, consistent with PLAN.md §7's Phase 1 cut ("ship a textarea with frontmatter validation," no form builder). A persona author has to type `harness:\n  autoApprove: true` by hand.
- Repository binding is still bind-by-absolute-path only (unchanged, deliberate — see previous handoff).
- `apps/tui` still doesn't exist (unchanged).

---

## Immediate next steps, in priority order

1. **Merge/keep/discard on `DiffView`** — the diff is real and reviewable; there's no action button yet. "Keep"/"discard" don't need the push-policy work and could land first; "merge" needs PLAN.md §6 A2 (agent never holds git credentials; host-side push after policy check).
2. **Inbox/notifications + stuck-run detection** — PLAN.md §3 calls this the actual job-to-be-done, and this session's own guard-vs-stale-run incident is a concrete argument for why it's overdue, not just a nice-to-have.
3. **Run resumption + idempotency keys + budget caps + kill switch** — all still flagged in PLAN.md §6/§7, none implemented.
4. **Container/microVM sandbox + egress proxy + credential broker** — still its own project, not a small PR.
5. Only after the above: Planner/Swarm (PLAN.md §7 Phase 2) — and PLAN.md §11's riskiest-assumption test (parallel workers on one repo) still hasn't been run.

## Things to NOT redo

- Everything in the previous handoff's "do not redo" list still applies.
- Don't reintroduce a per-channel persona/team roster, or repository pre-binding per channel, for `@mention` — deliberately out of scope per PLAN.md §3a's non-scope paragraph.
- Don't lift the single-active-run limit "to be helpful" — it's preserved on purpose; a second mention while a run is active must keep erroring clearly, never silently replace what's being watched.
- Don't build `autoApprove` as a global toggle or a run-time override — it's per-persona, opt-in, in the markdown. This was an explicit scope decision made mid-session (the user was asked, and chose per-persona over global) — don't casually widen it later without asking again.
- Don't put `harness.autoApprove` anywhere near the path-scoped write boundary (`classifyEffect`/`risky-tools.ts`) — that boundary must stay unconditional. `autoApprove` only ever skips the human round-trip for effect-ok risky calls.
- **When generating a handoff doc, write directly to this file at repo root — not a `handoffs/` subdirectory.** The `/handoff` skill defaulted to `handoffs/HANDOFF-2026-07-26-2348.md` again this session (same mistake flagged in the previous handoff); it was folded into this file and the stray copy deleted. If this keeps happening, it may be worth a standing project instruction rather than a per-session correction.
- Don't leave the `stage2-runner`/`stage2-repo`/`verify-runner`/`verify-repo` test data lying around indefinitely — it's harmless (isolated to a scratch repo under a session tmp dir) but is now real rows in your dev `loom` database. Clean up when convenient; not urgent.

---

## Environment / how to run

See README.md. Quick reference, updated for this session's fix:

- Postgres 18 + Valkey 9 via `docker compose up -d`.
- `.env` needs `BETTER_AUTH_SECRET` and `TEST_DATABASE_URL` (see `.env.example`).
- `pnpm dev` now works cleanly (was broken under Node 24 until this session's fix) — starts `apps/server` (:3001), `apps/ws-gateway` (:3002), `apps/web` (:5173) with live-reload.
- `apps/runner` is still separate, per-machine, started manually with `LOOM_SERVER_WS_URL`/`LOOM_PAIRING_TOKEN`/`LOOM_ALLOWED_ROOTS`. Mint a pairing token from the RunnerPanel UI — the raw token is shown once, copy it precisely (a misread character cost real time this session).
- Migrations: `pnpm db:migrate` from repo root. **Two new migrations this session**: `0006` (`persona_group` table), `0007` (`agent_persona.harness_auto_approve` column). Apply to both `loom` and `loom_test`.

## Verification commands (all currently passing)

```bash
pnpm -r typecheck
pnpm -r test                                # 104 tests
npx vitest run tools/architecture.test.ts   # 4 checks
npx eslint packages/ apps/                  # clean
```
