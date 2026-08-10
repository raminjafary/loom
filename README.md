# Loom

Human + agent collaboration workspace. See the design notes for the architecture and roadmap, and [HANDOFF.md](./HANDOFF.md) for exact current state and next steps.

**Current state: Phase 1's ship criterion is met; Phase 2 has started.** Realtime chat, real auth, and a real agent pipeline end to end: pair a Runner, bind a git repo, create or `@mention` a persona, watch it work in a thread, get **notified** when it needs you, approve/deny a risky tool from a card showing the exact argv, then review and keep/discard/push the branch — with clone-per-run isolation, a container sandbox holding no credentials, proxy-metered spend against enforced budget caps, and a global kill switch. Phase 2 so far: several runs per workspace at once, `parent_run_id`, and the capability attenuation. See HANDOFF.md before starting new work.

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

Create a second database for the integration test suite — it truncates domain tables and must never point at the one above:

```bash
docker compose exec postgres psql -U loom -d loom -c "CREATE DATABASE loom_test;"
DATABASE_URL=postgres://loom:loom@localhost:5432/loom_test pnpm db:migrate
```

Run the three core processes (separate terminals, or `pnpm dev` via Turborepo):

```bash
pnpm --filter @loom/server dev # API + /rpc + /ws/runner, on:3001
pnpm --filter @loom/ws-gateway dev # client realtime fan-out, on:3002
pnpm --filter @loom/web dev # UI on:5173
```

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
pnpm -r typecheck # all packages
pnpm -r test # 260 tests
npx vitest run tools/architecture.test.ts # layer boundaries
npx eslint packages/ apps/ # boundary lint rules
```

`@loom/db`, `@loom/server`, `@loom/ws-gateway`, and `@loom/runner` (path-check only) tests require the containers to be running — most exercise real Postgres and real Valkey rather than mocks. None of the automated tests call the real Claude Agent SDK (that costs real tokens); that path is verified manually — see HANDOFF.md for how.

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
```

The dependency rule — outer layers depend on inner, never the reverse — is enforced by `eslint.config.js` and `tools/architecture.test.ts`, not by convention. A vendor type crossing a port boundary is a build failure.

## Known gaps

See HANDOFF.md §"What's not built" for the full list. Headline items:

- No RBAC, no rate limiting, no CSP.
- Repository binding is bind-by-absolute-path only — no directory picker, no `git init` flow (a real picker needs the Runner to expose a `listDirectory` capability, which doesn't exist yet — see repository binding).
- Risky-tool classification path-scopes writes against the run's clone (real, enforced, verified live), but `Bash` still gates by name only — no reliable static argv classifier exists for arbitrary shell. Effect-based classification flags this as the honest limit short of a full sandbox rewrite.
- Container sandbox only — no microVM isolation (Kata/microsandbox), which is Phase 3 per the roadmap. Concurrent sandboxes also share one network.
- No skills/MCP attachment — needs the capability registry, which is Phase 2 scope.
- No raw provider transcript tier; the structured tier is real.
- No same-tool-call-N-times stuck detection (heartbeat + no-progress reaping is real).
- No Planner, no swarm decomposition, no tree view — Phase 2's concurrency foundation and
 its serialized merge queue are in, but nothing spawns child runs yet.
- No reconciler agent in front of the merge queue.
- A merge needs the Runner that ran the branch to still hold its clone in memory — the
 same limitation `agentRun.getDiff` and `agentRun.push` already have. A Runner restart
 after the run finished fails the merge with a clear reason rather than losing the entry.
