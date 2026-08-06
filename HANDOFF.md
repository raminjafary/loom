# Handoff — Loom, end of this session

Read this before touching code. `PLAN.md` is the architecture/roadmap; this file is
"what actually happened and what's next."

Session scope: **complete Phase 1** (PLAN.md §7). Five of the seven remaining items
are done; one is code-complete but not working end to end; one is barely started.
Test suite went 110 → **161**.

---

## What's real right now (not a mock, not a stub)

### Global kill switch (§6 runtime safety) — built, integration-tested

`workspace.runs_paused` + `runControl.{get,pauseAll,resume}` on the contract, a
`Stop all` control in the top bar with a two-step inline confirm.

Pause sets the flag *before* sweeping, so a run started concurrently is rejected by
`startAgentRun` rather than slipping in behind the sweep. It cancels every in-flight
run, resolves the gates they were blocked on (a dead run's pending approval would
otherwise sit in the Inbox forever pointing at a run that can never act), and sends
`cancel_run` to each Runner, which aborts the SDK loop via `AbortController`.

Two decisions worth not re-litigating:

- **Pause and resume are asymmetric.** Resume only lifts the block on new starts; it
  never revives what the pause killed. An operator who hit the switch wanted the work
  stopped.
- **A disconnected Runner cannot veto a stop.** The run is marked `cancelled`
  regardless; the orphaned process is the reaper's problem.

Covered by `runner-gateway.integration.test.ts` over the real protocol: `cancel_run`
delivered, run cancelled, pending gate resolved.

### Approval SLA (§6) — built, integration-tested

`APPROVAL_SLA_MS` (default 15 min). A gate left undecided past it auto-**denies**,
never auto-approves — an unattended gate is exactly the case where nobody vouched for
the call. Denying is also what keeps the run resumable: the SDK's callback resolves,
the model sees a denied tool result, and the loop continues. `resolvedByUserId` stays
null so the row shows no human decided it.

**This exposed a real pre-existing bug, now fixed:** `reapStuckRuns` applied its
no-progress signal to `awaiting_approval` runs, so any approval a human took longer
than `REAPER_NO_PROGRESS_TIMEOUT_MS` (10 min) to answer was killed as stuck — which
would have preempted the SLA in every real case. A run blocked on a human is not
making progress by design. The heartbeat signal still applies.

Both sweeps share one interval, SLA first, so a just-expired gate hands its run back
to `running` before the reaper judges it.

### Event idempotency + append-only event log (§6, §4d-bis) — built, integration-tested

New `agent_run_event` table: the structured tier §4d-bis asks for, doubling as the
idempotency ledger. The Runner assigns a per-run `seq`; the unique `(agent_run_id, seq)`
index is the key. `recordAgentEvent` appends before any side effect and bails on
conflict, so a replayed event cannot double-append a tool call to a thread or
re-apply a terminal status transition.

Dedupe is on the key, **not** the payload: two identical tool calls at different seqs
are genuinely two calls.

### Egress proxy + credential broker (§6 A6) — built, live-verified

`apps/egress-proxy`, a compose service. Two jobs on a sandbox-facing data plane:

1. **Credential-injecting reverse proxy** for the model API (`/anthropic/*` and
   `/v1/*`). Swaps the lease token for the real key. Being on the request path is also
   what makes metering authoritative.
2. **Allowlisting CONNECT forward proxy** for package registries. Tunnels are plain
   TCP, never decrypted — MITM'ing them would need a CA in the sandbox and still would
   not close the hole A5 already names (the model API call is itself an unblockable
   exfil channel).

Lease issuance is a **second listener** bound to loopback and published only to the
host, so a run cannot reach it even knowing the secret. Only the Runner calls it.

Deny-by-default egress is a Docker network with `internal: true`. **Verified live**:
from that network the internet, postgres, valkey and the control plane are all
unreachable while the proxy answers; unleased callers get 401; non-allowlisted hosts
and plaintext ports are refused; an allowlisted host tunnels (3.5 MB downloaded
through it).

### Cost metering + enforced budget caps (§6, §9) — built, not end-to-end verified

`harness.budgetCapUsd` parses from persona frontmatter, is snapshotted onto the run
(so a mid-run persona edit cannot raise a live run's ceiling), and is handed to the
proxy at lease time. The proxy accrues spend per lease from the provider's own
response, carries spend across a re-lease (reconnecting cannot reset a budget),
refuses further calls once the cap is passed, and the Runner kills the run.

`packages/domain/src/model-pricing.ts` holds the price table and discounts cache reads
to a tenth of input — an agent loop re-reads a large cached prefix every turn, so
charging those at full input rate would trip caps on work that never cost that much.

The SDK's self-reported `total_cost_usd` is now only a **fallback**, used when the run
has no proxy-metered figure (i.e. unsandboxed runs).

Every built-in persona ships capped at $5. Uncapped built-ins would make the
out-of-the-box path the only uncapped one.

### Container sandbox (§6 A5) — code-complete, structurally verified, **model auth NOT working**

See the "not finished" section below for the blocker. What *is* verified:

- Container boots non-root on a read-only rootfs, and the stdio protocol round-trips
  both directions (events out, permission decisions in).
- SDK session id is captured (the input run resumption needs).
- **Wall-clock kill fires** and kills the container, not just the `docker run` client.
- `sandbox.test.ts` asserts each A5 clause by name, so weakening the sandbox fails a
  test that names the requirement.

Structure: a thin `agent-host.ts` runs inside the container and is the only Loom code
there. It holds no credentials and decides nothing about permissions — every risky
call round-trips to the host, so an agent that subverted it could at most refuse to
ask, which cannot manufacture an approval.

The image builds from `apps/runner/sandbox-image/package.json`, **not** the workspace
manifest, with a flat `npm install` and a build-time assertion that the SDK's
per-platform native CLI is present. Both were forced by real failures — see "Things
to NOT redo".

---

## What's NOT built / NOT working — do not assume these exist

### The blocker: model auth from inside the sandbox — root-caused, and it is an SDK limitation

A sandboxed Claude Agent run cannot reach the model API with a *broker-issued* token.
Everything else about the sandbox works, and the proxy chain itself is proven: a
request from inside the container, carrying a lease, was forwarded through the proxy to
Anthropic and came back with a real `request_id`. The remaining failure is entirely in
how the SDK's CLI handles its own credential.

**This is now understood, not open.** See PLAN.md §6's "A6 caveat found in
implementation" for the write-up and its consequences. The short version: a sandboxed
Claude Agent run needs a **real** model key inside the sandbox, so A6's "zero
long-lived credentials in the sandbox" does not hold for that one credential. Egress
is still deny-by-default (so the key is only usable through the proxy), metering and
caps still work, and no other secret enters the sandbox.

**To finish this**, decide between:

1. **Accept the caveat** — pass the real key into the sandbox, keep the shim so the
   proxy still attributes and meters spend per run, and move on. Smallest change; the
   documented limitation stands.
2. **Recover the property with a brokerable backend** — `VllmApiAdapter` or
   `CodexAdapter` are plain HTTP clients with no client-side key validation, so the
   broker works for them unchanged. That is Phase 3 scope (§7).

Either way a real `ANTHROPIC_API_KEY` is needed in `.env` to verify a full run: the
proxy currently injects a placeholder, so even a correct token path ends in Anthropic's
401.

The evidence, established by experiment rather than guessed:

- The SDK's bundled **native** CLI (`claude-agent-sdk-linux-arm64/claude`) validates
  `ANTHROPIC_API_KEY`'s shape **locally** and makes no request at all if it dislikes
  it. Symptom is a bare `Invalid API key · Fix external API key` with nothing in the
  proxy log.
- The validation involves prefix **and** length, and apparently a checksum: a
  109-character `sk-ant-api03-…` token passed and reached the proxy; a 108-character
  one did not. Earlier `sk-ant-` + base64url tokens passed or failed depending on
  whether that random draw happened to contain `-`/`_`, which made a client-side check
  look like an intermittent proxy bug.
- When it *does* forward, it **mangles the value** — a 109-char key arrived as 108,
  and later as 102. So the lease token cannot ride on `ANTHROPIC_API_KEY` at all.
- `ANTHROPIC_AUTH_TOKEN` alone puts the CLI on its OAuth path (`Not logged in · Please
  run /login`), so the API-key path is the only one that honors `ANTHROPIC_BASE_URL`.
- `ANTHROPIC_BASE_URL` **is** honored, and takes a **bare origin** — the CLI discards
  any path and requests `/v1/messages` off it. That is why the proxy serves `/v1/*`.
- The CLI must be exempted from `HTTP_PROXY`/`HTTPS_PROXY` for its own base URL, or it
  proxies the model call to the proxy and arrives on the forward-proxy path.

**What is built and working**, and should be kept regardless of which option above is
chosen: an in-container loopback shim (`apps/runner/src/lease-shim.ts`) attaches the
lease token after the CLI is done rewriting things, so the proxy can still attribute
and meter spend per run — which is what budget caps depend on. It answers only its own
container's addresses, so a sibling sandbox cannot spend another run's budget.

**Still not verified downstream of the model call**: cost metering against real usage,
budget-cap enforcement actually killing a run, and the `cost_report` frame reaching the
database. All three are wired and unit-tested; none has seen a real token.

**Two false trails, so they are not re-walked:**

- A 401 from the proxy path was Anthropic's, relayed — not ours. Ours says
  `proxy_denied`; Anthropic's says `authentication_error` and carries a `request_id`.
  Check the body, not the status.
- Several refusal logs showed `known=[]` (no live leases) when a lease demonstrably
  existed. Those were **stale log lines** read back with `--since`/`--tail`. Confirm
  with fresh output before theorizing.

### Run resumption after a Runner restart — barely started

Session-id capture and a `resumeSessionId` option exist (adapter, sandbox protocol,
and `sessions` map in the Runner). Nothing persists them, nothing reconciles owned
runs on reconnect. Related known gap, already noted in the idempotency commit: a
Runner restart resets its event `seq` counter to 1, so resumed events would collide
with the old run's and be silently dropped. `agentRunEvents.highestSeq()` exists to
seed the counter from the server; wire it when resumption lands.

### Unchanged from previous handoffs

- **No same-tool-call-N-times stuck detection.** Still deliberately absent.
- **No continuous Inbox polling.** Unchanged, deliberate.
- **No microVM isolation** (Kata/microsandbox) — Phase 3 per §7. Containers only.
- **Effect-based gating (§6 A3) is still partial.** The path-scoped write check now
  runs *inside* the container, against the mount point, which is where the paths
  actually are. `Bash` is still gated by name only.
- **No skills/MCP attachment.** Unchanged.
- **No UI test harness.** The kill switch's button specifically has not been clicked in
  a real browser — only exercised via the contract and integration tests.
- **`gh`/`glab` PR creation has still never executed** (no real remote in this setup).
  Deliberately not chased; every failure degrades to a compare URL.
- `apps/tui` still doesn't exist.
- Repository binding is still bind-by-absolute-path only.

---

## New in PLAN.md this session (roadmap only, nothing built)

- **§4d-ter Agentic context management** — validated compaction, extract-then-store,
  hybrid retrieval by regime. Provenance caveats are stated in the section: the source
  is a single-author vendor paper with self-reported, non-reproducible numbers, and a
  third-party harness scores *simpler* setups higher on the same benchmark. The
  decomposition is the transferable part, not the numbers.
- **§4f Ouroboros mode + Phase 3b** — durable identity/memory across runs, and
  self-modification across five tiers including code and dependencies. Two devices make
  it tractable: the **envelope** (a human-set ceiling an agent may rewrite itself
  freely within but can never widen — this amends §5's attenuation rather than deleting
  it) and **build-and-promote, never edit-in-place** (an agent rewriting its own
  running process can destroy its own rollback path). Phase 3b's exit criterion is a
  rollback drill that promotes a knowingly-broken self-modification and recovers from
  it without the modified code participating.

---

## Immediate next steps, in priority order

1. **Decide the A6 caveat** (see the blocker section): accept a real key inside the
   sandbox, or defer sandboxed model calls to a brokerable backend in Phase 3. This is
   a judgement call about the security posture, not an engineering unknown.
2. **Put a real `ANTHROPIC_API_KEY` in `.env`** and do one full run end to end:
   sandboxed, metered, with a small `budgetCapUsd` to confirm the cap actually kills.
   Nothing downstream of the model call has ever executed.
3. **Browser-verify the kill switch**, the one piece of new UI this session added.
4. **Run resumption** (see above), including seeding the event `seq` from `highestSeq()`.
5. Only then: Planner/Swarm (§7 Phase 2), and §11's riskiest-assumption test — parallel
   workers on one repo — which *still* has not been run.

## Things to NOT redo

- Everything in previous handoffs' "do not redo" lists still applies.
- **Don't use pnpm for the sandbox image.** Its symlinked layout left the SDK's
  per-platform native CLI a dangling symlink — recorded in the lockfile, never
  materialized, because the lockfile is resolved on macOS and the image is linux. The
  flat npm install and the build-time assertion exist for this.
- **Don't switch the sandbox image to Alpine.** It installs the `-musl` SDK variant
  while the SDK resolves the glibc name, and fails at runtime.
- **Don't use `tls.connect` for the CONNECT tunnel.** It wraps the client's own TLS
  handshake in a second one and nothing upstream can parse it. A CONNECT tunnel is
  plain TCP; that is also what makes "not decrypted" true.
- **Don't remove the `clientSocket.on('error')` in the CONNECT handler.** Without it,
  refusing one CONNECT crashes the proxy and wipes every in-memory lease, which
  surfaces as "invalid API key" on unrelated valid runs.
- **Don't route the proxy container's start through `pnpm`.** corepack re-downloaded
  pnpm on every container start, making the network boundary itself depend on the
  network to boot.
- **Don't rename compose's `default` network.** It strands containers created under the
  previous name and `docker compose up` refuses to reattach them.
- **Don't "tidy" the lease-token prefix, alphabet, or length** without re-running the
  sandbox smoke check — see the blocker section for how much of it is load-bearing.
- **Don't restore the no-progress reaper for `awaiting_approval` runs.** That is the
  bug the approval SLA exposed.
- Don't add unit tests to `agent-use-cases.ts` expecting them to exist — this project's
  convention there is integration/live verification. Pure domain modules
  (`model-pricing.ts`, `egress-policy.ts`, `push-policy.ts`) do get unit tests.

---

## Environment / how to run

See README.md. Changes this session:

- **Two new migrations**: `0010` (kill switch columns on `workspace`), `0011`
  (`agent_run_event`), `0012` (`agent_persona.harness_budget_cap_usd`). Apply to both
  `loom` and `loom_test`.
- **New compose service `egress-proxy`** and a new `loom-sandbox` network with
  `internal: true`. `docker compose up -d` brings all three services up.
- **New env vars** (see `.env.example`): `ANTHROPIC_API_KEY` (read **only** by the
  proxy container — do not also export it to apps/runner, that would defeat §6 A6),
  `LOOM_EGRESS_CONTROL_SECRET`, `EGRESS_ALLOWED_HOSTS`, `LOOM_CONTAINER_RUNTIME`
  (default `docker`), `LOOM_SANDBOX_ENABLED`, `APPROVAL_SLA_MS`.
- **Sandbox image must be built** before a sandboxed run:
  `docker build -f apps/runner/Dockerfile.sandbox -t loom-agent-sandbox:latest .`
- `LOOM_SANDBOX_ENABLED=0` runs agents unsandboxed on the host, as Phase 1 did before
  this session. It is genuinely less safe, not merely less isolated — the agent gets the
  Runner's privileges, and the Runner holds git credentials and push authority. The
  Runner logs a warning per run in that mode.

## Verification commands (all currently passing)

```bash
pnpm -r typecheck
pnpm -r test                                # 161 tests
npx vitest run tools/architecture.test.ts   # 4 checks
npx eslint packages/ apps/                  # clean
```

A scratch end-to-end sandbox driver was used this session and left outside the repo
(session scratchpad, `sandbox-smoke.ts`). It leases a token, prepares a throwaway git
clone, runs `runAgentInSandbox`, and prints events plus drained usage. Worth
rebuilding as a checked-in script once the model-auth path works.
