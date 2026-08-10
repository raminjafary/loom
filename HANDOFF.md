# Handoff — Loom, end of this session

Read this before touching code. `PLAN.md` is the architecture/roadmap; this file is
"what actually happened and what's next."

## Latest session: the serialized merge queue (PLAN.md §7 Phase 2)

§7 is explicit that the merge queue must exist *before* the reconciler agent, as the
fallback that catches what the agent gets wrong. It is built, tested at three levels,
and driven live. Test suite 228 → **260**.

**What it does.** A human queues a finished run's branch (**Queue for merge**, alongside
keep/discard/push). A server sweep then advances every repository's queue by at most one
entry: rebase the branch onto the repository's current default-branch tip, run the
repository's verification command, fast-forward. Success marks the run `merged`; failure
hands the branch back to its owning run with its disposition left unset, so it can be
fixed and re-queued.

**Six decisions not to re-litigate:**

- **The merge target is the bound repository's local default branch, not `origin`.**
  Pushing stays the separate §6 A2 path with its own policy and credentials. This also
  keeps the queue exercisable on a repository with no remote, which is what this machine
  has.
- **Serialization is a unique partial index**, `merge_queue_entry(repository_id) where
  status = 'merging'` — not the sweep that reads it. Two servers sweeping concurrently
  both see the same queued entry and both try to claim it; the index lets exactly one
  win. `selectNextMergeEntry` is the *scheduling* rule and is unit-tested, but it is
  advisory, and the code says so.
- **Serial per repository, concurrent across them.** Two repositories share no target
  branch, so making one wait on the other's test suite would be slow for no safety
  reason.
- **Verification runs inside the sandbox**, with `--network none` — tighter than a run
  gets, since verification needs no model API and therefore no egress proxy. The command
  is operator-authored but the code it runs is on the agent's branch, so host execution
  is agent code with the Runner's privileges (§6 A5) — and it happens *after* a human
  approved a merge, which reads as the safe moment. Without a sandbox it needs the same
  `LOOM_ALLOW_UNSANDBOXED` acknowledgement an unsandboxed run needs, and is refused
  before any git runs so a refusal never leaves a branch rewritten.
- **No verification command → the entry merges unverified and says so.** `verified`
  records whether tests ran and passed, not whether any were configured.
- **A dirty target is refused, never stashed** — and only when the target branch is the
  one checked out, since moving a ref no working tree is on touches no files.

**Three failure modes that each needed their own answer**, and are why `MergeFailureReason`
is a closed set rather than free text: a conflict is the run's to fix, a dirty target is
the human's, and a target that moved mid-merge is neither. The fast-forward is a
compare-and-swap (`git update-ref <ref> <new> <old>`, or `merge --ff-only`) against the
tip captured before the rebase, so a target that moved is `stale_target` rather than a
silent overwrite.

**Two bugs the tests found, both real:**

1. `toAgentRunBranchDisposition` did not know `merged`, so the first successful merge
   threw at the mapper. A widened union with a hand-written validator either side of it.
2. **A late Runner answer could overwrite an entry the stuck-check had already given up
   on** — flipping a branch a human was told had been abandoned to `merged`, with a thread
   saying both. `finish` now only applies to a non-terminal entry and returns null
   otherwise; first resolution wins, and the callers skip their messages and notifications
   when they lose.

**And one in the live-check script itself, worth recording** because it is the failure mode
the script exists to catch: its "conflict" case cloned *after* the previous merge landed,
so there was nothing to diverge from and every case was quietly a fast-forward. Two
branches only conflict if both were cloned from the same base before either merged. The
script now clones all three up front — the shape a swarm actually produces.

**Verified live** (`tools/merge-queue-check.mts` — real server, real Runner *process*, real
WebSocket protocol, real git, **no tokens**): a branch merged and fast-forwarded, a sibling
cloned from the same base rebased on top of it rather than beside it, a genuine conflict
failed with the conflicting path named and the repository untouched, an unsandboxed
verification refused, and a dirty target refused with the human's uncommitted edit intact.
Sandboxed verification was driven separately against the real container: a passing command
merged, a failing one did not, and DNS does not resolve inside it.

The script spends no tokens because it starts runs the Runner's own unsandboxed guard
refuses — the guard fires *after* the clone, so each run has a real workspace and branch,
and the script writes the commits an agent would have left.

**Known limitation, shared with `getDiff` and `push`:** a merge needs the Runner that ran
the branch to still hold its clone in memory. A Runner restart after the run finished
fails the merge with a clear reason rather than losing the entry, but it does fail.

**Not built:** the reconciler agent that §7 wants in front of this queue. The queue is the
fallback it is supposed to sit behind, and it exists now.

Session scope, in order: **notifications** (the item the previous handoff called the
largest remaining Phase 1 gap), Runner **backpressure**, and then the **start of
Phase 2**. All built and verified live. Test suite 166 → **228**.

**The Phase 1 ship criterion is now fully met**, including the clause that was only
substantially met before: "is notified when it needs them". Verified end to end in a
real browser this session, not just in tests — see "Notifications" below.

Also built this session: **Runner backpressure** (§7's Runner list) and a hardening fix
it uncovered — see "Backpressure and settings sources" below.

Still open in PLAN.md §7's Phase 1 list:

- **Skills attachment.** Note the plan contradicts itself here: §7 lists it under Phase 1,
  while §4e's own phasing note puts MCP/skills behind the Phase 2 capability registry.
  Nothing is parsed today (the earlier handoff's "parsed but never wired" was wrong — the
  parser explicitly excludes it). The SDK does have a first-class `skills: string[] | 'all'`
  option, so the plumbing is straightforward; what is *not* settled is where skill files
  come from. With `settingSources: []` (see below) it is unclear whether `.claude/skills`
  in the clone is still discovered, and that question needs a real run to answer, not a
  guess. A registry that provisions skills into a run is squarely §4e Phase 2.
- **Directory picker and `git init` repo creation** (§5a). Binding is still
  by-absolute-path only. Needs a Runner `listDirectory` capability that does not exist.
- **Raw transcript tier** (§4d-bis tier 3). The structured tier is built; the verbatim
  provider stream is not persisted anywhere. Needs `BlobStoragePort` (local FS first).
- **Effect-based gating (§6 A3) remains partial** — path-scoped writes are enforced,
  `Bash` is still gated by tool name.

**What was observed end to end** (`tools/e2e-run.mts`), both unsandboxed and fully
sandboxed: a persona created, a run against a real git repo, the agent working, an
approval gate whose card carried the **exact tool argv** (not a model summary), a human
approving, the run completing with proxy-metered cost, the branch diff rendering, the
Inbox surfacing it, and `keep` resolving it — and now an OS notification arriving when
the gate opened, whose click landed on that run in the Inbox.

---

## Phase 2 has started — the concurrency foundation is in

Not the Planner, not the tree view, not the merge queue. What landed is what all
three need first:

- **A workspace runs several agents at once.** Phase 1's hard "one active run"
  became `MAX_CONCURRENT_RUNS_PER_WORKSPACE` (default **3**, matching §11's own
  experiment). Still a limit, deliberately: concurrency multiplies both spend and
  the human attention §11 is about, and a fourth start gets a clear error rather
  than a silent queue.
- **`parent_run_id` + `relation`** on `agent_run` (migration `0014`), with
  `relation` distinguishing delegation from review/reconcile exactly as §5 asks,
  rather than letting a reviewer masquerade as a delegation child.
- **Capability attenuation (§5)** as a pure domain module with 13 tests: a child
  can't hold tools its parent lacks, can't auto-approve when its parent can't,
  can't raise or drop the budget cap, and can't reach a higher model tier. An
  unranked child model under a ranked parent is refused (a typo would otherwise be
  the way past the tier check), while a parent that is itself unranked — §8's
  open-weight path — constrains nothing. **This is what makes a `tools: []`
  Planner meaningful**: without it, a Planner just spawns a child that has tools.
- **A run may spawn children, and only its own.** An `agent_run` actor may start a
  run only with itself as parent; anything else is refused, so a run can't graft
  work onto a tree it isn't part of and have attenuation measured against the
  wrong parent. The kill switch applies to child starts too.
- **`agentRun.listActive` / `listChildren`** on the contract, `activeRuns` in the
  client snapshot, and an **Active runs** sidebar panel that switches which run the
  workspace view is watching.

**Verified live in a browser**: three concurrent runs rendered, the fourth refused
with the limit message, and switching the watched run landing on the run that was
clicked.

**The second bug a browser found this session:** `listActiveByWorkspace` and
`listNeedsAttention` had no `ORDER BY`, so both lists — clickable rows, re-polled
every ~1.5s — reshuffled between polls, and a click could land on a different run
than the one aimed at. Both now order by `(createdAt, id)`; `id` breaks ties
because a swarm's runs are created in the same millisecond. The concurrency test
asserts order twice rather than membership.

**What is deliberately not wired yet:** nothing calls the child-run path. The only
thing that should is a Planner, which does not exist — so the path is exercised by
integration tests against the real deps rather than exposed on the contract, where
a human starting a "child" by hand would mean nothing.

## What's real right now (not a mock, not a stub)

### Notifications (§3's retention hook, §4a `NotificationPort`) — new this session

`NotificationPort` with a **web-push adapter** (`apps/server/src/notifications.ts`), a
`notification_target` table, `notification.{config,subscribe,unsubscribe}` on the
contract, a service worker (`apps/web/public/sw.js`), and an **Enable notifications**
control in the top bar next to the kill switch.

Fan-out points, all in `agent-use-cases.ts`: a gate needing a decision, a run finishing
(with branch name and metered cost), a run failing, a run **reaped** — that last one
matters most, since a reaped run emits no terminal event of its own, so a watcher just
sees the thread stop — and an approval **expiring** under the SLA. The kill switch
deliberately sends nothing: the human who pressed it does not need telling.

Four decisions worth not re-litigating:

- **A notification never carries tool arguments.** §6 A3's rule is that a human decides
  against the exact argv, which the approval card renders in the app. A body containing
  `rm -rf …` invites deciding from a lock screen, which is the failure mode A3 exists to
  prevent. Guarded by a domain test and an integration test.
- **Delivery is best-effort and swallowed.** A dead push service must never leave a run
  stuck in `awaiting_approval`; the Inbox is unaffected either way. The adapter logs,
  the use-case layer does not (it has nothing to log with).
- **VAPID keys alone decide whether the port is configured**, so `clientConfig()` and
  `deliver()` can never disagree. With no keys the UI says "Notifications off (server)"
  rather than offering a button that cannot work, and every other path is unaffected.
- **One notification per run, coalesced on `tag: run:<id>`.** An approval notification is
  replaced by that run's finish notification rather than stacking, because the question
  being asked has changed. Verified live.

**Verified live, not just green:** subscribing produced a real FCM endpoint stored with
both encryption keys; the adapter's RFC 8291 payload was accepted by FCM; the service
worker rendered it; a second push on the same tag replaced rather than stacked; a real
run started from the UI produced `swe needs approval` and then
`swe finished / loom/run-… is ready to review. $0.31`; clicking through both the
cold-start (`?run=`) and warm (`postMessage`) paths opened the Inbox on that run;
unsubscribing removed the row. Delivery to a real push service is what
`tools/push-check.mts` exists for.

**One bug the tests could not have caught:** the toggle read `config` only on mount, so it
sat on "Notifications…" forever — `config` arrives when the session's `init()` resolves.
It is a `watch` now. This is the second session in a row where a real browser found
something a green suite did not.

### Backpressure and settings sources (§7 Phase 1) — new this session

`onEvent` is awaited the whole way down — SDK stream loop, the container's stdout
reader, and agent-host's own stdout drain — so when the socket's backlog passes a
high-water mark the **agent loop waits** rather than the Runner buffering without
limit. Dropping events was the cheaper option and the wrong one: the thread is the
record of what the agent did, and §4d-bis already chose a structured tier over a
lossy stream.

Frames sent while the socket is down are now **held and replayed in order** on
`hello_ack` (not on socket open — an event sent before the server resolves the
Runner's identity has no run to attach to). Bounded, so an hour-long disconnect is
not a memory leak, and a drop is logged loudly rather than leaving a silent hole.
Only run events are held: a heartbeat replayed later would vouch for liveness at a
moment that has passed. All of this lives in `send-queue.ts` and is unit-tested.

The container's stdout reader also forwards events **one at a time**. It previously
called an async `onEvent` concurrently for lines arriving in a single chunk, which
would assign event sequence numbers in whatever order the awaits happened to
resolve.

**The hardening this uncovered:** the SDK was loading filesystem settings with CLI
defaults, which includes `<clone>/.claude/settings.json` — content the agent can
write and, in the general case, content nobody in the workspace authored. Claude
Code's precedence puts `permissions.allow` ahead of a prompt, so a settings file
shipped in a repository is at minimum a plausible route past the `canUseTool` gate
that §6 A1/A3 exist to guarantee. Now `settingSources: []`, with
`LOOM_SDK_SETTING_SOURCES` as an explicit operator opt-in. Note this also stops a
repo's `CLAUDE.md` being auto-injected — deliberate: the persona is the instruction
source. `claude-agent-adapter.test.ts` asserts these options by name, the way
`sandbox.test.ts` asserts the A5 flags.

Verified on a real unsandboxed run: the gate fired, the work was committed, the diff
was 155 bytes, and $0.0189 was metered — so isolation mode does not disturb the
SDK's own auth or execution.

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

0. **A reconciler agent in front of the merge queue** (§7 Phase 2) — now unblocked, since
   §7 required the mechanical queue to exist first and it does. Measure agent-reconciled
   merge *correctness* and token cost before trusting it unsupervised, per §7.
1. **§11's riskiest-assumption test** — three clones, three workers, one repo, measuring
   human minutes to reconcile versus doing it serially. Still never run, and all of
   Phase 2 rides on it. **This is the highest-value thing left in the whole plan**, and
   it needs real token spend plus a human with a stopwatch, so it cannot be quietly
   folded into a build session.
2. **Browser-verify the kill switch** — still the one Phase 1 surface never clicked by a
   human. (The notification toggle beside it now has been, and that click found a bug.)
3. The remaining smaller Phase 1 items: skills attachment (read the caveat above first),
   directory picker + `git init`, raw transcript tier.
4. **Phase 2, continuing from the foundation above**, in this order: the **serialized
   merge queue** (deterministic and cheap, and the fallback the reconciler agent needs
   to exist behind — build it first, per §7), then the **Planner** (`tools: []`,
   structured decomposition, aggregation) which is the first real caller of the
   child-run path, then the **tree view** over `parent_run_id`.
5. Or Phase 3's brokerable backend (vLLM/Codex), which removes the licensing and
   undocumented-integration caveats above entirely.

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
  `egress-policy.ts`, `push-policy.ts`, `notifications.ts`) do get unit tests.
- **Don't put tool arguments in a notification body.** See the notification section
  above; two tests exist specifically to stop it coming back.
- **Don't let a notification failure propagate.** `notifyRun` swallows deliberately; a
  push service must not be able to hold a run in `awaiting_approval`.
- **Don't read `notificationConfig` once on mount** in a component — it is null until the
  session's `init()` resolves. That was this session's live-found bug.
- **Don't re-enable SDK filesystem settings by default.** `settingSources: []` is a
  permission boundary, not tidiness — see the backpressure/settings section above.
- **Don't drop agent events under load, and don't forward container events
  concurrently.** The first loses the record; the second scrambles event ordering.
- **Don't remove the `ORDER BY` from a query whose rows are clickable and re-polled.**
  `listActiveByWorkspace` and `listNeedsAttention` both need it — see above.
- **Don't merge on click.** `mergeQueue.enqueue` queues; the sweep merges. A synchronous
  "merge now" endpoint would be exactly the race §5a says the queue replaces, and there is
  deliberately no way to jump the queue.
- **Don't rebase at enqueue time.** Entry N+1 must land on the *result* of entry N, which
  is the only reason the ordering is worth anything.
- **Don't run a merge's verification command on the host without the acknowledgement**,
  and don't move the refusal after the rebase. See the merge-queue section above.
- **Don't report a merge with no verification command as verified.**
- **Don't let a late `merge_result` overwrite a terminal entry.** `finish` returns null for
  an already-resolved entry, and callers must honour it.
- **Don't stash or commit a human's uncommitted work to make a merge fit.**
- **Don't let a run spawn a child of anything but itself**, and don't skip
  `attenuateChildPersona` on a child start. Together they are the only reason a
  `tools: []` Planner is a boundary rather than a suggestion.

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

This session's live-check leftovers are also gone: the fake Runner it paired, the repo it
bound, the run it started, and its `notification_target` row (the browser unsubscribed at
the end of the check). `dev` still holds the older `pushtest-repo` binding and its
completed run from a previous session.

**A browser has granted notification permission for `localhost:5173`.** That is Chrome
profile state, not repo state — a next session verifying push will not see a permission
prompt, and must click *Enable notifications* again to re-create a target row.

Nothing is left running that a next session needs to stop first — a normal `pnpm dev`
plus a re-paired Runner is the cold start.

## Environment / how to run

See README.md. Changes this session:

- **New migration `0015`** (`merge_queue_entry`, plus `repository.verify_command`), applied
  to both `loom` and `loom_test`. Earlier sessions added `0010`–`0014`.
- **New env var `MERGE_STUCK_TIMEOUT_MS`** (default 30 min) — how long an entry may sit
  `merging` before the queue abandons it. This is the merge queue's dead-run reaper, and it
  exists for one failure: a server dying mid-merge leaves a `merging` row that the unique
  index makes unclaimable, stalling that repository's queue with nothing to notice.
  `LOOM_MERGE_TIMEOUT_MS` (gateway, 15 min) and `LOOM_MERGE_VERIFY_TIMEOUT_MS` (Runner, 10
  min) bound the two halves under it.
- **New migration `0013`** (`notification_target`), applied to both `loom` and `loom_test`
  in an earlier session. Earlier sessions added `0010`–`0012`.
- **New env vars** `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`, read only
  by apps/server. Generate with `npx web-push generate-vapid-keys`. All optional — with
  the keys unset, notifications report themselves off and nothing else changes. The dev
  `.env` has a locally-generated pair; the private key is a signing key, so treat it like
  `BETTER_AUTH_SECRET`.
- **New dependency `web-push` (MPL-2.0)** in apps/server. OSI-approved, so §8's
  all-OSS constraint holds.
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
pnpm -r test                                # 260 tests
npx vitest run tools/architecture.test.ts   # 4 checks
npx eslint packages/ apps/ tools/           # clean

npx tsx tools/e2e-run.mts                   # real Runner, real repo, real agent run
```

```bash
npx tsx tools/push-check.mts                # real web push to every subscribed browser
npx tsx tools/merge-queue-check.mts         # real Runner, real git, real merges, no tokens
```

`tools/push-check.mts` covers the one leg no test can: the adapter's RFC 8291 encryption,
the VAPID signature a push service validates, and whether the service worker renders what
arrives. Needs VAPID keys in `.env` and a browser that has clicked *Enable notifications*.

`tools/e2e-run.mts` is a hand-run driver, not a test: it spends real tokens and asserts
nothing, it prints what happened. It found both the uncommitted-work bug and the
terminal-event ordering bug. Defaults to unsandboxed; for the sandboxed path:

```bash
set -a && . ./.env && set +a
LOOM_SANDBOX_ENABLED=1 LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/e2e-run.mts
```
