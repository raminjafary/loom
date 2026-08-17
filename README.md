# Loom

Human + agent collaboration workspace. See the design notes for the architecture and roadmap, and [HANDOFF.md](./HANDOFF.md) for exact current state and next steps.

**Current state: Phases 0, 1, 2 and 2b are complete. Phase 3's verification harness is
built; Phase 3b's envelope, tiers 1–2, the five and all of the self-improvement loop are built.**

A real agent pipeline end to end: pair a Runner, bind a git repo, author a persona in a
form or in raw markdown, `@mention` it, watch it work in a thread, get **notified** when
it needs you, approve or deny a risky tool from a card showing the exact argv, then
review and keep/discard/push/queue the branch — with clone-per-run isolation, a container
sandbox holding no credentials, proxy-metered spend against enforced budget caps, and a
global kill switch.

And a real swarm: a Planner decomposes a goal into a DAG of subtasks, sub-planners
decompose their own areas, workers share a notes ledger, sibling branches converge
through a serialized merge queue with a reconciler agent that resolves additive conflicts
and refuses real ones, a live board and graph show what each run is doing, and a human can
steer a running swarm without stopping it — or answer a question a run blocks on. Teams are
designed on a canvas that will not draw an edge the runtime would refuse.

Beyond that, three things worth naming because they are unusual:

- **A definition of done that is the platform's, not a command.** A repository declares
 named, ordered checks; the merge queue runs them against a rebased branch and every
 finished run runs them against its own, stopping at the first failure and recording the
 rest as `not_run`. The verdict is derived server-side, so a Runner cannot certify its own
 work.
- **Persona memory that is measured rather than assumed.** A mastery run builds a subject
 map, an atlas relates maps across projects, and retrieval is a *trial*: some runs are
 deliberately denied the map and recorded as the baseline, because "an expertise that
 cannot be shown to help is a context-window tax with a reassuring name".
- **Agents that edit themselves inside a human-set ceiling, and a loop that decides whether
 the edit helped.** An **envelope** bounds what a persona may become; tier 1 rewrites its
 own prompt (body only, round-trip checked), tier 2 its own tool list (a list, never a
 document). Then the self-improvement loop: an edit goes on **trial** against the document it replaced, an
 agent with more than one idea proposes **candidate prompts that never go live** and the
 platform deals runs out between them, the fitness is a human's disposition then the
 repository's definition of done then cost — never a model's self-report — and a **blinded
 verifier** in its own session reads the candidates with the rationales, the incumbency and
 the generator's notes all withheld. It ranks; a person promotes.

Not built: everything else in Phase 3 (other backends, microVM isolation, SeaweedFS,
validated compaction), Phase 3b's tiers 3–4 and their rollback drill, Tier 5's distilled
experience, and Phase 3c (a real browser in CI). **the riskiest-assumption experiment has
been run** — parallel is 2.1× faster at the same cost, with a third of branches needing
hands, which is what put the reconciler in front of the merge queue. See
HANDOFF.md before starting new work.

## Requirements

- Node >= 22 (developed on 24.18)
- pnpm 11
- Docker (or Podman) for Postgres + Valkey
- `claude` CLI installed and authenticated, for real agent runs (`apps/runner` imports `@anthropic-ai/claude-agent-sdk` as a library — it doesn't shell out to the CLI, but needs the same underlying auth)

## Getting started

```bash
pnpm install
docker compose up -d # Postgres 18 + Valkey 9
pnpm db:migrate # apply schema
```

Copy `.env.example` to `.env` and set a real `BETTER_AUTH_SECRET` (`openssl rand -base64 32`).

Create the test databases. They truncate domain tables and must never point at the one above:

```bash
pnpm db:test:prepare
```

**One database per test package**, not one shared `loom_test`: `packages/db`, `apps/server`
and `apps/ws-gateway` run concurrently under turbo and each truncates tables the others
are mid-way through using — `packages/db` truncates `workspace`, which cascades to nearly
every domain table. Sharing one database made `pnpm test` fail for reasons unrelated to
whatever was being changed, which trains you to re-run rather than to read. `loom_test`
is still created and migrated because the live drivers in `tools/` default to it.

**Re-run `pnpm db:test:prepare` after generating a migration** — it applies to every test
database as well as creating any that are missing. A migration applied only to `loom`
shows up as integration tests timing out rather than as a missing-table error.

Run the three core processes (separate terminals, or `pnpm dev` via Turborepo):

```bash
pnpm --filter @loom/server dev # API + /rpc + /ws/runner, on:3001
pnpm --filter @loom/ws-gateway dev # client realtime fan-out, on:3002
pnpm --filter @loom/web dev # UI on:5173
```

Or the whole stack at once, which is what the `Makefile` is for:

```bash
make up # containers + migrations, then every app under turbo
make down # stops the processes and the containers
make status # what is up, and what is holding each dev port
```

`make dev` frees the dev ports before starting, deliberately. A `pnpm dev` that outlived
its terminal keeps serving pre-migration code, and a session was spent diagnosing a
canvas that was not broken — the database had moved underneath a process nobody had
restarted. `make kill` does that part alone, and also stops any Runner started by hand
or by a driver in `tools/`, since a Runner holds no port and survives everything else.

Sign up through the web UI (email/password via Better Auth) — a default workspace auto-provisions on first login.

### Notifications

Optional, and off until configured. With no keys set the UI shows "Notifications off (server)" and everything else works unchanged.

```bash
npx web-push generate-vapid-keys # put the pair in.env as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```

Then click **Enable notifications** in the top bar once per browser. After that a run that needs you reaches you without the app being open — a gate waiting on a decision, a finished branch, a failed or reaped run — and clicking the notification opens the Inbox on that run. Web push needs a secure context: `localhost` counts, any other host needs HTTPS.

To confirm delivery against a real push service after subscribing:

```bash
set -a &&../.env && set +a
npx tsx tools/push-check.mts # pushes one notification to every registered browser
```

### Merging an agent's branch

A finished run's branch is queued, never merged on the spot — **Queue for merge** on the
diff view, or `mergeQueue.enqueue({agentRunId})`. A background sweep then merges one
branch per repository at a time, in queue order: rebase onto the current default branch,
run the repository's verification command, fast-forward. Sibling branches converge
through that queue rather than racing.

The merge target is the **bound repository's own default branch**, locally. Pushing to
`origin` is the separate `agentRun.push` path with its own policy.

Set what verifies a merge per repository — the line under each repo in the sidebar, or
`repository.setVerifyCommand({repositoryId, verifyCommand})`:

```bash
pnpm -r test # for example; null or empty merges unverified, and the entry says so
```

That command runs **inside the sandbox**, with `--network none`. It is operator-authored,
but the code it executes — test files, package scripts — is on the agent's branch, so
running it on the Runner host is agent code with the Runner's privileges. Without a
sandbox the merge is refused unless
`LOOM_ALLOW_UNSANDBOXED=i-understand-the-agent-gets-my-privileges` is set, the same
acknowledgement an unsandboxed run needs. Because there is no network, verification runs
what is already in the clone and cannot install anything.

Three things the queue refuses rather than forces: a branch that conflicts (handed back to
its run, disposition left unset so it can be fixed and re-queued), a repository with
uncommitted changes on the target branch, and a target that moved mid-merge.

```bash
docker compose up -d
npx tsx tools/merge-queue-check.mts # real Runner, real git, no tokens spent
```

### Dependency cache and prepared trees

Off by default. `LOOM_DEP_CACHE_ENABLED=1` on the **Runner** gives runs a shared
package-manager cache; a repository with an install command
(`repository.setInstallCommand`) can then be warmed from Settings, which fills the cache
*and* captures that repository's install output as a **prepared tree** — so later runs
open with `node_modules` (or `.venv`, or `target`) already in place instead of spending
a model turn installing.

Only directories the repository's own `.gitignore` covers are captured, which is what
makes it invisible to review: a run's `git status`, its commit, and the diff a human
reads are exactly what they would have been. Each run gets a copy-on-write **copy**, never
a shared mount — a directory shared between sandboxes is a channel between them.

| Variable | Default | Meaning |
|---|---|---|
| `LOOM_DEP_CACHE_ENABLED` | off | Master switch; nothing below applies without it |
| `LOOM_DEP_CACHE_ROOT` | `$TMPDIR/loom-dep-cache` | Where the warmed cache lives |
| `LOOM_DEP_CACHE_MODE` | `copy` | `shared` is faster and unsound — see `dep-cache.ts` |
| `LOOM_PREPARED_TREE_ENABLED` | on with the cache | Set `0` for the cache without prepared trees |
| `LOOM_PREPARED_TREE_ROOT` | beside the cache | One directory per repository |
| `LOOM_PREPARED_TREE_MAX_BYTES` | 8 GB | Over this, runs install for themselves and the warm says so |

```bash
set -a &&../.env && set +a
LOOM_USE_HOST_CLAUDE_AUTH=1 LOOM_DEP_CACHE_ENABLED=1 \
 npx tsx tools/prepared-tree-check.mts # real warm + one real run, ~$0.01
```

### Running a real agent

All of this is reachable from the web UI's sidebar now (mint a pairing token, bind a repo, write or pick a persona, start a run, approve/deny gates, view the diff). To drive it directly over RPC instead:

1. Pair a Runner: call `runner.createPairingToken({name})` to get a `runnerId` and a raw pairing token.
2. Start the Runner against a real git repo's parent directory:
 ```bash
 LOOM_SERVER_WS_URL=ws://localhost:3001/ws/runner \
 LOOM_PAIRING_TOKEN=<token> \
 LOOM_ALLOWED_ROOTS=/absolute/path/to/allowed/parent \
 pnpm --filter @loom/runner start
 ```
3. Bind a repo: `repository.bindExisting({runnerId, path: '/absolute/path/to/repo', displayName})`.
4. Create a persona (markdown + frontmatter — see the capability registry for the format): `persona.create({markdownSource})`.
5. Start a run: `agentRun.start({threadId, repositoryId, personaId})`. The Runner clones the bound repo into a per-run scratch workspace first — it never touches the bound repo's own working tree.
6. Watch it work via `message.list`/realtime — tool calls, results, and the final `run_completed` all render as messages in the thread. Fetch the run's branch diff on demand with `agentRun.getDiff({agentRunId})`.

## Verifying

```bash
make check # what CI would run: typecheck, lint, the suite
pnpm typecheck # all packages, including apps/web's vue-tsc
pnpm db:test:prepare # four test databases — after any db:generate
pnpm test # 1646 tests
npx vitest run tools/architecture.test.ts # layer boundaries
npx eslint packages/ apps/ # boundary lint rules
```

`@loom/db`, `@loom/server`, `@loom/ws-gateway`, and `@loom/runner` (path-check only) tests require the containers to be running — most exercise real Postgres and real Valkey rather than mocks.

**None of the automated tests call the real Claude Agent SDK** (that costs real tokens). That path is covered by the live drivers in `tools/*-check.mts`, run by hand — each one drives a real server, a real Runner *process*, the real SDK and real git, and each **asserts** rather than prints:

```bash
docker compose up -d
LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/self-edit-check.mts # continuity mode + the self-improvement loop, 41 checks

set -a;../.env; set +a # sandboxed mode needs the egress control secret, or every run
 # is *refused* rather than sandboxed — and the refusal reads
 # like a broken feature
LOOM_USE_HOST_CLAUDE_AUTH=1 LOOM_SANDBOX_ENABLED=1 npx tsx tools/self-edit-check.mts
```

Two things that will otherwise cost you a pass:

- **The API key in `.env` is a placeholder.** Without `LOOM_USE_HOST_CLAUDE_AUTH=1` a driver "passes" about nothing.
- **After touching `apps/runner/src/`, rebuild the sandbox image.** The Runner refuses a stale one on purpose — an out-of-date image does not fail, it runs older agent-side code and the model is quietly never offered whatever the newer sources added:

```bash
docker build -f apps/runner/Dockerfile.sandbox -t loom-agent-sandbox:latest.
```

## Layout

```
packages/
 domain/ pure entities, zero dependencies
 application/ use-cases + ports (interfaces only)
 db/ Drizzle/Postgres adapters — the only place ORM types exist
 api-contract/ oRPC procedures + Zod schemas (browser/client wire boundary)
 runner-protocol/ WS frame schemas shared between apps/server and apps/runner
 client-core/ framework-agnostic client logic
apps/
 server/ Fastify + oRPC + /ws/runner, implements the contract and drives Runners
 ws-gateway/ stateless realtime service (Valkey fan-out to browsers only)
 web/ Vite + Vue 3 (thin views over client-core)
 runner/ local daemon: pairs with the server, drives the real Claude Agent SDK
tools/
 architecture.test.ts asserts the dependency rule holds
 *-check.mts live drivers: real server, real Runner process, real SDK, real git
```

The dependency rule — outer layers depend on inner, never the reverse — is enforced by `eslint.config.js` and `tools/architecture.test.ts`, not by convention. A vendor type crossing a port boundary is a build failure.

## Known gaps

See HANDOFF.md for the full current picture — this list is the headline items only, and it is
kept honest about what is *not* here rather than about what is.

- No RBAC, no rate limiting, no CSP.
- **`Bash` still gates by name**, not by effect. Risky-tool classification path-scopes writes
 against the run's own clone (real, enforced, verified live), but no reliable static argv
 classifier exists for arbitrary shell. Effect-based classification flags this as the honest limit short of
 a full sandbox rewrite.
- **Container sandbox only** — no microVM isolation (Kata/microsandbox), which is Phase 3.
 Concurrent sandboxes also share one network, behind the credential-injecting egress proxy.
- **A merge, a diff, a push and a verification all need the Runner that ran the branch to
 still hold its clone.** A Runner restart after the run finished fails them with a clear
 reason rather than losing the entry.
- **No CI.** `make check` is exactly what a CI job would run; nothing runs it automatically,
 and Phase 3c (a real browser in CI) is the roadmap's trailing item.
- **Phase 3b's tiers 3 and 4 are off**, and stay off until the rollback drill exists: a
 scripted exercise that promotes a knowingly-broken self-modification and recovers without
 the modified code participating.
- **the self-improvement loop has never reached a measured verdict from real traffic.** Five decided runs an arm
 across three arms is fifteen dispositioned runs on one persona; the arms, the arithmetic and
 the verifier are each verified, the whole loop closing is not.
- No same-tool-call-N-times stuck detection (heartbeat + no-progress reaping is real).
