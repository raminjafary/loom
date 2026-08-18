# Loom

A workspace where humans and coding agents work together: a chat-shaped UI over a swarm of
real agent runs, each in its own git clone and container sandbox, with a human in the loop at
the points that matter and nowhere else.

Loom is self-hosted, has no cloud dependency beyond a model API, and is built so the pieces
are replaceable — the execution backend, the store, the transport and the UI framework each
sit behind a port.

**Why this rather than a terminal agent:** one agent in a terminal is already solved. What is
not solved is *ten* of them: who reviews the branches, what stops two of them editing the same
file, where the shared context lives, what a person is asked to decide, and what a run costs.
That is what this is.

---

## What works today

A single agent, end to end: pair a Runner, bind a git repo, write a persona, `@mention` it,
watch it work in a thread, get a push notification when it needs you, approve or deny a risky
tool from a card showing the exact argv, then review and keep, discard, push or queue the
branch.

A swarm: a Planner decomposes a goal into a DAG of subtasks, sub-planners decompose their own
areas, workers share a notes ledger, sibling branches converge through a serialized merge queue
with a reconciler agent that resolves additive conflicts and refuses real ones, and a human can
steer a running swarm — or answer a question a run is blocked on — without stopping it.

Three things worth naming, because they are unusual:

**A definition of done that belongs to the repository, not to a command.** A repo declares
named, ordered checks. The merge queue runs them against a rebased branch; every finished run
runs them against its own. Execution stops at the first failure and the rest are recorded
`not_run` rather than omitted. The verdict is derived server-side, so a Runner cannot certify
its own work.

**Persona memory that is measured rather than assumed.** A mastery run builds a subject map, an
atlas relates maps across projects, and retrieval is a *trial*: some runs are deliberately
denied the map and recorded as the baseline, because an expertise that cannot be shown to help
is a context-window tax with a reassuring name.

**Agents that edit themselves inside a human-set ceiling, and a loop that decides whether the
edit helped.** An **envelope** bounds what a persona may become. Tier 1 rewrites its own prompt
(body only, round-trip checked); tier 2 its own tool list (a list, never a document). Then the
edit goes on **trial** against the document it replaced: an agent with more than one idea
proposes candidate prompts that never go live, the platform deals runs out between them, and
the fitness is a human's disposition, then the repository's definition of done, then cost —
never a model's self-report. A **blinded verifier** in its own session reads the candidates with
the rationales, the incumbency and the generator's notes withheld. It ranks; a person promotes.

### Not built

Other execution backends (Codex, vLLM, Cursor), microVM isolation, SeaweedFS blob storage,
validated compaction, self-modification tiers 3–4 (Loom's own source and its dependencies) and
their rollback drill, distilled cross-run experience, and a real browser in CI. The
[known gaps](#known-gaps) section is kept honest about what is missing rather than about what
is there.

---

## Requirements

| | |
|---|---|
| Node | ≥ 22 (developed on 24) |
| pnpm | 11 |
| Docker | or Podman — Postgres 18, Valkey 9, the egress proxy |
| `claude` | installed and authenticated, for real agent runs |

`apps/runner` imports `@anthropic-ai/claude-agent-sdk` as a library rather than shelling out to
the CLI, but it needs the same underlying auth.

## Quickstart

```bash
pnpm install
cp.env.example.env # then set BETTER_AUTH_SECRET
openssl rand -base64 32 # ← use this for it
make up # containers, migrations, then every app
```

`make up` is the whole stack. Individually:

```bash
docker compose up -d # Postgres 18 + Valkey 9 + egress proxy
pnpm db:migrate # apply the schema
pnpm --filter @loom/server dev # API + /rpc + /ws/runner:3001
pnpm --filter @loom/ws-gateway dev # realtime fan-out:3002
pnpm --filter @loom/web dev # UI:5173
```

Sign up through the UI (email/password via Better Auth); a default workspace auto-provisions on
first login.

**`make dev` frees the dev ports before starting, deliberately.** A `pnpm dev` that outlived its
terminal keeps serving pre-migration code, and a session was once spent diagnosing a canvas that
was not broken — the database had moved underneath a process nobody had restarted. `make kill`
does that part alone, and also stops any Runner started by hand, since a Runner holds no port and
survives everything else. `make status` shows what is up and what is holding each port.

### Running a real agent

Everything below is reachable from the UI sidebar. To drive it over RPC instead:

1. `runner.createPairingToken({name})` → a `runnerId` and a raw pairing token.
2. Start the Runner against the *parent directory* of your repos:
 ```bash
 LOOM_SERVER_WS_URL=ws://localhost:3001/ws/runner \
 LOOM_PAIRING_TOKEN=<token> \
 LOOM_ALLOWED_ROOTS=/absolute/path/to/allowed/parent \
 pnpm --filter @loom/runner start
 ```
3. `repository.bindExisting({runnerId, path, displayName})`
4. `persona.create({markdownSource})` — markdown plus frontmatter.
5. `agentRun.start({threadId, repositoryId, personaId})`

The Runner clones the bound repo into a per-run scratch workspace first. It never touches the
bound repo's own working tree. Watch the run via `message.list`/realtime; fetch its branch diff
with `agentRun.getDiff({agentRunId})`.

### Merging an agent's branch

A finished run's branch is **queued, never merged on the spot** — *Queue for merge* on the diff
view, or `mergeQueue.enqueue({agentRunId})`. A background sweep merges one branch per repository
at a time, in order: rebase onto the current default branch, run the repository's verification,
fast-forward. Sibling branches converge through that queue rather than racing.

The target is the bound repository's own default branch, locally. Pushing to `origin` is the
separate `agentRun.push` path with its own policy.

Set what verifies a merge per repository — the line under each repo in the sidebar, or
`repository.setVerifyCommand({repositoryId, verifyCommand})`. That command runs **inside the
sandbox** with `--network none`. It is operator-authored, but the code it executes lives on the
agent's branch, so running it on the Runner host would be agent code with the Runner's
privileges; without a sandbox the merge is refused unless
`LOOM_ALLOW_UNSANDBOXED=i-understand-the-agent-gets-my-privileges` is set. Because there is no
network, verification runs what is already in the clone and cannot install anything.

Three things the queue refuses rather than forces: a branch that conflicts (handed back to its
run, disposition left unset so it can be fixed and re-queued), a repository with uncommitted
changes on the target branch, and a target that moved mid-merge.

---

## Architecture

```
packages/
 domain/ pure entities and rules, zero dependencies
 application/ use-cases + ports (interfaces only)
 db/ Drizzle/Postgres adapters — the only place ORM types exist
 api-contract/ oRPC procedures + Zod schemas (the browser/client wire boundary)
 runner-protocol/ WS frame schemas shared by apps/server and apps/runner
 client-core/ framework-agnostic client logic
apps/
 server/ Fastify + oRPC + /ws/runner; implements the contract, drives Runners
 ws-gateway/ stateless realtime service (Valkey fan-out to browsers only)
 web/ Vite + Vue 3 — thin views over client-core
 runner/ local daemon: pairs with the server, drives the real Agent SDK
 egress-proxy/ credential-injecting, metering, allowlisting egress boundary
tools/
 architecture.test.ts asserts the dependency rule holds
 *-check.mts live drivers: real server, real Runner process, real SDK, real git
```

**The dependency rule — outer layers depend on inner, never the reverse — is enforced by
`eslint.config.js` and `tools/architecture.test.ts`, not by convention.** A vendor type crossing
a port boundary is a build failure.

Two seams are worth knowing about. The **Runner** is a separate process on the machine that
holds your repositories, connected by an authenticated WebSocket; the server never touches your
filesystem. The **egress proxy** sits between every sandbox and the network, holding the real
credential so the sandbox holds only an opaque per-run lease.

Design decisions and their reasoning live in the design notes — is a reference key
mapping every section to what it decides. Code cites it (`the worker-notes design — worker notes`),
so a comment that explains *why* is one search away from the argument behind it.

## Security model

Prompt injection is the threat model, not an edge case: any agent reading a file, a diff or a
web page is reading attacker-controllable instructions. The load-bearing controls:

| | |
|---|---|
| **Secrets never enter the sandbox** | A run holds an opaque, revocable, per-run lease token. The proxy swaps it for the real credential, which lives on the host. Metering happens on that path, so cost is authoritative rather than self-reported. |
| **The agent never pushes** | It commits in its sandbox; the host-side Runner pushes after a policy check — the run's own branch only, no force-push, no tags, no protected branches, and no CI-config change without a second acknowledged request. |
| **Approvals are identity-bound** | Only a principal of type `user` can resolve a gate, so an injected agent cannot approve itself. Cards render the exact argv from the tool-call payload, never a model-authored summary, and approval is bound to a hash of that exact call. |
| **The sandbox is the boundary** | `--network=none` by default with all egress through the proxy, never the container socket, `--cap-drop=ALL`, no-new-privileges, default seccomp, non-root in a userns, read-only rootfs, only the run's clone mounted. |
| **The clone gets no vote** | The SDK runs with `settingSources: []`, so a `.claude/settings.json` committed to a repository cannot grant permissions nobody was asked for. A repo's `CLAUDE.md` is not auto-injected either — the persona is the instruction source. |
| **A planner cannot act** | Read-only tools, enforced at persona-authoring time. Its only effect on the world is a decomposition the server validates itself. |

Two limits stated plainly rather than buried. **The model API call is itself an unblockable
exfiltration channel**, which is why the real control is "secrets never enter the sandbox" and
not "the sandbox cannot talk out". And **unsandboxed runs get the Runner's own privileges** —
one `Bash` call reaches the login keychain — so that mode needs a separate, deliberately
awkward acknowledgement.

---

## Verifying

```bash
make check # what CI runs: typecheck, lint, the suite, the boundary test
pnpm test # 1,662 tests across 96 files
pnpm db:test:prepare # four test databases — re-run after any db:generate
```

CI runs the same commands on every push and pull request
([`.github/workflows/check.yml`](.github/workflows/check.yml)).

**One database per test package**, not one shared `loom_test`: `packages/db`, `apps/server` and
`apps/ws-gateway` run concurrently under turbo and each truncates tables the others are mid-way
through using. Sharing one made `pnpm test` fail for reasons unrelated to whatever was being
changed, which trains you to re-run rather than to read. Re-run `pnpm db:test:prepare` after
generating a migration — a migration applied only to `loom` shows up as integration tests timing
out rather than as a missing-table error.

**No automated test calls the real model API** (that costs real tokens). That path is covered by
the live drivers in `tools/*-check.mts`, run by hand. Each drives a real server, a real Runner
*process*, the real SDK and real git, and each **asserts** rather than prints:

```bash
docker compose up -d
LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/self-edit-check.mts

set -a;../.env; set +a # sandboxed mode needs the egress control secret, or every run is
 # *refused* rather than sandboxed — and the refusal reads like a
 # broken feature
LOOM_USE_HOST_CLAUDE_AUTH=1 LOOM_SANDBOX_ENABLED=1 npx tsx tools/self-edit-check.mts
```

Two things that otherwise cost you a pass:

- **The API key in `.env.example` is a placeholder.** Without `LOOM_USE_HOST_CLAUDE_AUTH=1` a
 driver "passes" about nothing.
- **After touching `apps/runner/src/`, rebuild the sandbox image.** The Runner refuses a stale
 one on purpose — an out-of-date image does not fail, it runs older agent-side code and the
 model is quietly never offered whatever the newer sources added:
 ```bash
 docker build -f apps/runner/Dockerfile.sandbox -t loom-agent-sandbox:latest.
 ```

## Configuration

`.env.example` documents every variable. The ones that change behaviour rather than wiring:

| Variable | Default | Meaning |
|---|---|---|
| `LOOM_SANDBOX_ENABLED` | on | Container isolation per run. Needs `LOOM_EGRESS_CONTROL_SECRET` set, or runs are refused rather than sandboxed |
| `LOOM_ALLOW_UNSANDBOXED` | unset | The acknowledgement that lets a run hold the Runner's privileges |
| `LOOM_USE_HOST_CLAUDE_AUTH` | off | Lets the Runner read the host's Claude OAuth token and push it to the proxy |
| `LOOM_ALLOWED_ROOTS` | — | Parent directories a repository may be bound from |
| `LOOM_DEP_CACHE_ENABLED` | off | Shared package-manager cache; a warmed repository also captures a **prepared tree**, so runs open with `node_modules` already in place |
| `LOOM_DEP_CACHE_MODE` | `copy` | `shared` is faster and unsound — a directory shared between sandboxes is a channel between them |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | unset | Web push. Off until configured; `npx web-push generate-vapid-keys` |

Only directories a repository's own `.gitignore` covers are captured into a prepared tree, which
is what makes it invisible to review: a run's `git status`, its commit, and the diff a human
reads are exactly what they would have been.

---

## Known gaps

Kept honest about what is *not* here.

- **No RBAC, no rate limiting, no CSP.**
- **`Bash` gates by name, not by effect.** Write paths are scoped against the run's own clone
 (real, enforced, verified live), but no reliable static argv classifier exists for arbitrary
 shell. This is the honest limit short of a full sandbox rewrite.
- **Container isolation only** — no microVM boundary. Concurrent sandboxes also share one
 network, behind the credential-injecting proxy.
- **A merge, a diff, a push and a verification all need the Runner that ran the branch to still
 hold its clone.** A Runner restart after the run finished fails them with a clear reason
 rather than losing the entry.
- **Self-modification tiers 3 and 4 are off**, and stay off until the rollback drill exists: a
 scripted exercise that promotes a knowingly-broken self-modification and recovers without the
 modified code participating.
- **The self-improvement loop has never reached a measured verdict from real traffic.** Five
 decided runs an arm across three arms is fifteen dispositioned runs on one persona; the arms,
 the arithmetic and the verifier are each verified, the whole loop closing is not.
- **No same-tool-call-N-times stuck detection.** Heartbeat and no-progress reaping are real.
- **No browser in CI**, which is where every UI defect this project has shipped was actually
 found — by a human looking at a browser, never by the suite.

## License

Not yet chosen. **Until a `LICENSE` file exists, this code is "all rights reserved" by default**
and nobody may legally reuse it, which is worth fixing before announcing it anywhere.
