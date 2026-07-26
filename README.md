# Loom

Human + agent collaboration workspace. See the design notes for the architecture and roadmap, and [HANDOFF.md](./HANDOFF.md) for exact current state and next steps.

**Current state: Phase 0 complete, Phase 1 substantially built.** Realtime chat, real auth, and a working agent-execution pipeline: pair a Runner, bind a real git repo, start a real Claude Agent SDK run, watch it work in a thread, with a human-only approval gate on risky tools. See HANDOFF.md before starting new work.

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

### Running a real agent

1. Pair a Runner: call `runner.createPairingToken({name})` (no UI for this yet — see HANDOFF.md) to get a `runnerId` and a raw pairing token.
2. Start the Runner against a real git repo's parent directory:
 ```bash
 LOOM_SERVER_WS_URL=ws://localhost:3001/ws/runner \
 LOOM_PAIRING_TOKEN=<token> \
 LOOM_ALLOWED_ROOTS=/absolute/path/to/allowed/parent \
 pnpm --filter @loom/runner start
 ```
3. Bind a repo: `repository.bindExisting({runnerId, path: '/absolute/path/to/repo', displayName})`.
4. Start a run: `agentRun.start({threadId, repositoryId, persona: {name, systemPrompt, model, tools}})`.
5. Watch it work via `message.list`/realtime — tool calls, results, and the final `run_completed` all render as messages in the thread.

## Verifying

```bash
pnpm -r typecheck # all packages
pnpm -r test # 69 tests
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
- Persona storage is inline JSON on `agent_run` — no markdown/git-backed persona files or CRUD UI yet.
- Repository binding is bind-by-absolute-path only — no directory picker, no `git init` flow.
- Risky-tool classification is a hardcoded name list (`Bash`/`Write`/`Edit`/`NotebookEdit`) — effect-based classification already flags this as insufficient long-term; it's the documented Phase 1 starting point, not the final design.
- Sandbox hardening (network egress policy, resource limits, read-only mounts — the sandbox spec) is not implemented. The Runner executes agent runs with the same filesystem/network access as the process running it.
