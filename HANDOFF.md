# Handoff — Loom, end of this session

Read this before touching code. `PLAN.md` is the architecture/roadmap; this file is
"what actually happened and what's next."

Session scope: the seven items previously tracked as remaining Phase 1 work. All seven
are built and verified. Test suite 110 → **166**.

**Phase 1 is not finished.** Those seven were the list carried forward from the previous
handoff, not PLAN.md §7's full Phase 1 list. Still open there:

- **Notifications.** §3 calls the inbox-plus-notification loop "the retention hook" and
  puts it ahead of the tree view. The Inbox exists; nothing tells a human a run needs
  them, so they have to go and look. No `NotificationPort`, no web push. **The largest
  remaining Phase 1 gap**, and the reason the ship criterion is only substantially met —
  it says "is notified when it needs them".
- **Skills attachment** (§4e). Parsed in persona frontmatter, never wired to a run.
- **Directory picker and `git init` repo creation** (§5a). Binding is still
  by-absolute-path only.
- **Runner backpressure.**
- **Raw transcript tier** (§4d-bis tier 3). The structured tier is built; the verbatim
  provider stream is not persisted anywhere.
- **Effect-based gating (§6 A3) remains partial** — path-scoped writes are enforced,
  `Bash` is still gated by tool name.

**What was observed end to end** (`tools/e2e-run.mts`), both unsandboxed and fully
sandboxed: a persona created, a run against a real git repo, the agent working, an
approval gate whose card carried the **exact tool argv** (not a model summary), a human
approving, the run completing with proxy-metered cost, the branch diff rendering, the
Inbox surfacing it, and `keep` resolving it. Everything in the ship criterion except
being *notified* rather than having to look.

---

## What's real right now (not a mock, not a stub)

### Global kill switch (§6 runtime safety)

`workspace.runs_paused` + `runControl.{get,pauseAll,resume}`, and a `Stop all` control
in the top bar with a two-step inline confirm.

Pause sets the flag *before* sweeping, so a run starting concurrently is rejected rather
than slipping in behind it. It cancels every in-flight run, resolves the gates they were
blocked on (a dead run's pending approval would otherwise sit in the Inbox forever), and
sends `cancel_run`, which aborts the SDK loop.

Two decisions not to re-litigate: **pause and resume are asymmetric** (resume only
unblocks new starts, it never revives what the pause killed), and **a disconnected
Runner cannot veto a stop** (the run is cancelled regardless; its orphan is the reaper's
problem). Covered by integration tests over the real protocol.

### Approval SLA (§6)

`APPROVAL_SLA_MS`, default 15 min. An undecided gate auto-**denies** — never
auto-approves, since an unattended gate is exactly the case where nobody vouched for the
call. Denying also keeps the run resumable: the SDK callback resolves, the model sees a
denied result, the loop continues. `resolvedByUserId` stays null so the row shows no
human decided.

**Fixed a pre-existing bug this exposed:** `reapStuckRuns` applied its no-progress
signal to `awaiting_approval` runs, so any approval a human took longer than 10 minutes
to answer was killed as stuck — which would have preempted the SLA in every real case.
A run blocked on a human is not making progress by design. The heartbeat signal still
applies.

### Event idempotency + append-only event log (§6, §4d-bis)

`agent_run_event` is both the structured tier §4d-bis asks for and the idempotency
ledger. The Runner assigns a per-run `seq`; unique `(agent_run_id, seq)` is the key.
`recordAgentEvent` appends before any side effect and bails on conflict, so a replay
cannot double-append a tool call or re-apply a terminal transition. Dedupe is on the
key, **not** the payload — two identical calls at different seqs are two calls.

### Egress proxy + credential broker (§6 A6)

`apps/egress-proxy`, a compose service, doing two jobs on a sandbox-facing data plane:
credential-injecting reverse proxy for the model API, and an allowlisting CONNECT
forward proxy for package registries. Tunnels are plain TCP and never decrypted.

Lease issuance is a **second listener** on loopback, published only to the host, so a run
cannot reach it even knowing the secret.

Deny-by-default egress is a Docker network with `internal: true`. **Verified live:** from
that network the internet, postgres, valkey and the control plane are all unreachable
while the proxy answers; unleased callers get 401; non-allowlisted hosts and plaintext
ports are refused; an allowlisted host tunnels (3.5 MB through it). A leased request was
forwarded to Anthropic and came back with a real `request_id`.

### Container sandbox (§6 A5)

Per-run container; the agent no longer runs with the Runner's privileges. A thin
`agent-host.ts` inside is the only Loom code there — it holds no credentials and decides
nothing about permissions, so an agent that subverted it could at most refuse to ask,
which cannot manufacture an approval. The approval gate survives the move via a
line-delimited stdio protocol with a `ready` handshake (stdin written before the
container attaches is discarded, which cost real debugging time).

`sandbox.test.ts` asserts each A5 clause **by name**, so weakening the sandbox fails a
test that states the requirement. Documented deviations, not silent ones: internal
network rather than literal `--network=none` (A5's own sentence cannot be literally true
of both), containers rather than microVMs (Phase 3 per §7), docker rather than podman by
default, and **two** run-scoped bind mounts rather than one — the clone plus a
host-backed HOME, because the SDK keeps its resumable transcript there and a tmpfs would
make resumption impossible.

Verified: boots non-root on a read-only rootfs, protocol round-trips both ways, session
id captured, wall-clock kill fires and kills the container rather than just the client.

### Cost metering + enforced budget caps (§6, §9)

`harness.budgetCapUsd` parses from frontmatter, is snapshotted onto the run (so a
mid-run persona edit cannot raise a live run's ceiling), and is handed to the proxy at
lease time. The proxy accrues real spend, carries it across a re-lease so reconnecting
cannot reset a budget, refuses further calls past the cap, and the Runner kills the run.
Cache reads are priced at a tenth of input, since an agent loop re-reads a large cached
prefix every turn. The SDK's self-reported cost is now only a fallback for unsandboxed
runs. Every built-in ships capped at $5.

### Run resumption after a Runner restart (§7 Phase 1)

The Runner keeps durable per-run state on disk and declares resumable runs in its
`hello`. The server reconciles before anything else: a run the Runner still holds gets
`resume_run`; one it no longer holds is failed immediately with a real reason instead of
waiting minutes for the reaper's generic message. Both branches integration-tested.

Two load-bearing details: the event counter continues from the **server's** watermark
(it is authoritative about what it ingested; restarting at 1 would make every new event
collide and vanish), and persona/task come from the Runner's state file, not the frame,
so a persona edited while the Runner was down cannot change what a resumed run does.

### The agent's work gets committed

The Runner commits whatever is left in the working tree onto the run's branch at any
terminal outcome. Found by the first real run: the agent edited a file, the run
completed, and the diff was **zero bytes** because nothing was committed — so both §5a's
diff review and §6 A2's push silently depended on the model remembering `git commit`.
Attributed to the persona, never a human.

---

## Credentials: A6 holds, and how

A sandboxed run holds **no credential of any kind** — only an opaque, per-run, revocable
lease token. This works, and the route matters because the obvious one fails.

`ANTHROPIC_API_KEY` cannot carry a brokered token: the SDK's bundled CLI validates it
client-side (prefix, length, something checksum-shaped — identically-shaped random keys
are accepted or rejected by draw), rewrites what it forwards, and on failure ignores
`ANTHROPIC_BASE_URL` and calls `api.anthropic.com` directly.

The **OAuth path** has none of those behaviours. Given a structurally valid
`$HOME/.claude/.credentials.json` the CLI considers itself signed in, honors the base
URL, and forwards the token byte-exact as `Authorization: Bearer`. So the sandbox gets a
credentials file containing its lease token, and the proxy swaps it for the real
credential. The upstream credential is a short-lived OAuth token rather than a permanent
key — better than what A6 originally imagined.

That token lives in the operator's login keychain, which no container can read, so the
Runner reads it host-side and pushes it to the proxy's loopback control plane, refreshing
on an interval. **Explicit opt-in** via `LOOM_USE_HOST_CLAUDE_AUTH=1` — reading an
operator's keychain is not something the Runner should start doing quietly. Never logged,
never written to disk by Loom, never crosses into a container. `sandbox.test.ts` guards
the property directly: no credential-shaped variable may appear in the sandbox env.

**Two caveats, both real and neither technical:**

- **Licensing.** §8 records that the SDK's terms prohibit exposing claude.ai
  subscription limits to *your users*. Single-operator self-hosted is one reading; a team
  workspace on one person's subscription is the case the term is about. `ANTHROPIC_API_KEY`
  on the proxy remains supported and is the right choice for multi-user.
- **Undocumented.** The credentials-file shape is not a published integration point and
  could change. The API-key fallback exists so a break degrades rather than outages.
- **The API-key fallback is wired but unverified upstream.** The sandbox always presents
  an OAuth-shaped credentials file, so the CLI declares `anthropic-beta:
  oauth-2025-04-20`; the proxy now strips `oauth-*` flags when using a key, keeping the
  rest. Unit-tested at the header level. Whether the provider accepts the resulting
  request has **not** been confirmed — no API key was available. First thing to check if
  anyone runs Loom key-only.

A brokerable backend (vLLM/Codex, §7 Phase 3) stays the most durable answer — neither
validates credentials client-side at all.

## Also not built — do not assume these exist

- **No microVM isolation** (Kata/microsandbox) — Phase 3 per §7. Containers only.
- **Effect-based gating (§6 A3) is still partial.** The path-scoped write check now runs
  *inside* the container against the mount point, which is where the paths actually are.
  `Bash` is still gated by name only.
- **No same-tool-call-N-times stuck detection**; **no continuous Inbox polling**. Both
  still deliberate.
- **No skills/MCP attachment.**
- **No UI test harness.** The kill switch's button has not been clicked in a real
  browser — only exercised through the contract and integration tests.
- **`gh`/`glab` PR creation has still never executed** (no real remote here).
  Deliberately not chased; every failure degrades to a compare URL.
- **Concurrent sandboxes share one network** and can reach each other. They hold no
  credentials, and the lease shim answers only its own container, so the blast radius is
  one run's clone. Per-run networks would close it.
- `apps/tui` still doesn't exist.
- Repository binding is still bind-by-absolute-path only.

## New in PLAN.md this session (roadmap only, nothing built)

- **§4d-ter Agentic context management** — validated compaction, extract-then-store,
  hybrid retrieval by regime. The section states its own provenance caveats: a
  single-author vendor paper, self-reported non-reproducible numbers, and a third-party
  harness scoring *simpler* setups higher on the same benchmark.
- **§4f Ouroboros mode + Phase 3b** — durable identity/memory across runs plus
  self-modification across five tiers including code and dependencies. Two devices make
  it tractable: the **envelope** (a human-set ceiling an agent may rewrite itself freely
  within but can never widen — amending §5's attenuation rather than deleting it) and
  **build-and-promote, never edit-in-place** (an agent rewriting its own running process
  can destroy its own rollback path). Exit criterion is a rollback drill that promotes a
  knowingly-broken self-modification and recovers without the modified code taking part.
- **§6 A6 caveat** — the SDK finding above, and the three-way fork it forces.

---

## Immediate next steps, in priority order

1. **Notifications** — the largest remaining Phase 1 gap, and the one §3 argues is the
   product's retention hook. Everything else in Phase 1 is either small or explicitly
   deferred.
2. **Browser-verify the kill switch** — the only new UI this session added, and the only
   Phase 1 surface never clicked by a human.
3. **§11's riskiest-assumption test** — three clones, three workers, one repo, measuring
   human minutes to reconcile versus doing it serially. Still never run, and all of
   Phase 2 rides on it. This is the highest-value thing left in the whole plan.
4. The remaining smaller Phase 1 items: skills attachment, directory picker + `git init`,
   Runner backpressure, raw transcript tier.
5. Then Phase 2 proper (Planner/Swarm), or Phase 3's brokerable backend (vLLM/Codex),
   which removes the licensing and undocumented-integration caveats above entirely.

## Things to NOT redo

- Everything in previous handoffs' "do not redo" lists still applies.
- **Don't use pnpm for the sandbox image.** Its symlinked layout left the SDK's
  per-platform native CLI a dangling symlink — recorded in the lockfile, never
  materialized, because the lockfile resolves on macOS and the image builds for linux.
  The flat npm install and the build-time assertion exist for this.
- **Don't switch the sandbox image to Alpine.** It installs the `-musl` SDK variant while
  the SDK resolves the glibc name, and fails at runtime.
- **Don't use `tls.connect` for the CONNECT tunnel.** It wraps the client's own handshake
  in a second one and nothing upstream can parse it. A CONNECT tunnel is plain TCP.
- **Don't remove `clientSocket.on('error')` in the CONNECT handler.** Without it, refusing
  one CONNECT crashes the proxy and wipes every in-memory lease, which surfaces as
  "invalid API key" on unrelated valid runs.
- **Don't route the proxy container's start through `pnpm`.** corepack re-downloaded pnpm
  on every container start, making the network boundary depend on the network to boot.
- **Don't rename compose's `default` network.** It strands containers created under the
  old name and `docker compose up` refuses to reattach them.
- **Don't point the sandbox's `ANTHROPIC_BASE_URL` at loopback.** The CLI ignores a
  loopback base URL and goes straight to `api.anthropic.com`; it must be the container's
  own name, and `NO_PROXY` must exempt both that and the proxy host.
- **Don't restore the no-progress reaper for `awaiting_approval` runs.**
- **Don't make the model commit its own work.** That was the bug.
- **Don't try to broker a token through `ANTHROPIC_API_KEY`.** It is validated
  client-side and rewritten. The OAuth credentials-file path is the one that works.
- **Don't send a run's terminal event before its work is committed.** The server marks
  the run completed on that event and clients immediately fetch the diff.
- Don't add unit tests to `agent-use-cases.ts` expecting them to exist — the convention
  there is integration/live verification. Pure domain modules (`model-pricing.ts`,
  `egress-policy.ts`, `push-policy.ts`) do get unit tests.

### Two false trails, so they are not re-walked

- A 401 from the proxy path was **Anthropic's, relayed** — not ours. Ours says
  `proxy_denied`; theirs says `authentication_error` and carries a `request_id`. Check
  the body, not the status.
- Several refusal logs showed `known=[]` (no live leases) when a lease demonstrably
  existed. Those were **stale log lines** read with `--since`/`--tail`. Confirm with
  fresh output before theorizing.

---

## State of the machine at handoff

Cleaned up: no stray containers, no scratch clones or run-state directories, and the
only workspace left in either database is `dev`. The compose stack (postgres, valkey,
egress-proxy) is up and healthy. The sandbox image `loom-agent-sandbox:latest` is built.

Nothing is left running that a next session needs to stop first — a normal `pnpm dev`
plus a re-paired Runner is the cold start.

## Environment / how to run

See README.md. Changes this session:

- **Three new migrations**: `0010` (kill-switch columns on `workspace`), `0011`
  (`agent_run_event`), `0012` (`agent_persona.harness_budget_cap_usd`). Apply to both
  `loom` and `loom_test`.
- **New compose service `egress-proxy`**, plus a `loom-sandbox` network with
  `internal: true`. `docker compose up -d` brings all three services up.
- **Build the sandbox image** before a sandboxed run:
  `docker build -f apps/runner/Dockerfile.sandbox -t loom-agent-sandbox:latest .`
- **New env vars** — see `.env.example`. `ANTHROPIC_API_KEY` is read **only** by the proxy
  container; do not also export it to apps/runner, that would defeat §6 A6.
- `LOOM_SANDBOX_ENABLED=0` runs agents unsandboxed. Genuinely less safe, not merely less
  isolated: the agent gets the Runner's privileges, and the Runner holds git credentials
  and push authority. The Runner logs a warning per run in that mode.

## Verification commands (all currently passing)

```bash
pnpm -r typecheck
pnpm -r test                                # 166 tests
npx vitest run tools/architecture.test.ts   # 4 checks
npx eslint packages/ apps/                  # clean

npx tsx tools/e2e-run.mts                   # real Runner, real repo, real agent run
```

`tools/e2e-run.mts` is a hand-run driver, not a test: it spends real tokens and asserts
nothing, it prints what happened. It found both the uncommitted-work bug and the
terminal-event ordering bug. Defaults to unsandboxed; for the sandboxed path:

```bash
set -a && . ./.env && set +a
LOOM_SANDBOX_ENABLED=1 LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/e2e-run.mts
```
