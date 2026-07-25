# Loom

Human + agent collaboration workspace. See [PLAN.md](./PLAN.md) for the architecture and roadmap.

**Current state: Phase 0 complete.** A working realtime chat foundation with the layer boundaries, actor model, and audit log in place. No agents yet — that is Phase 1.

## Requirements

- Node >= 22 (developed on 24.18)
- pnpm 11
- Docker (or Podman) for Postgres + Valkey

## Getting started

```bash
pnpm install
docker compose up -d              # Postgres 18 + Valkey 9
pnpm db:migrate                   # apply schema
pnpm --filter @loom/server seed   # create the dev workspace, prints its id
```

Copy `.env.example` to `.env` and set `LOOM_DEV_WORKSPACE_ID` to the id the seed printed.

Then run the three processes (separate terminals, or `pnpm dev` via Turborepo):

```bash
pnpm --filter @loom/server dev       # API on :3001
pnpm --filter @loom/ws-gateway dev   # realtime on :3002
pnpm --filter @loom/web dev          # UI on :5173
```

## Verifying

```bash
pnpm -r typecheck                          # all packages
pnpm -r test                               # 53 tests
npx vitest run tools/architecture.test.ts  # layer boundaries
npx eslint packages/ apps/                 # boundary lint rules
```

`@loom/db`, `@loom/server`, and `@loom/ws-gateway` tests require the containers to be running — they exercise real Postgres and real Valkey rather than mocks.

## Layout

```
packages/
  domain/         pure entities, zero dependencies
  application/    use-cases + ports (interfaces only)
  db/             Drizzle/Postgres adapters — the only place ORM types exist
  api-contract/   oRPC procedures + Zod schemas (the wire boundary)
  client-core/    framework-agnostic client logic
apps/
  server/         Fastify + oRPC, implements the contract
  ws-gateway/     dedicated realtime service (Valkey fan-out)
  web/            Vite + Vue 3 (thin views over client-core)
tools/
  architecture.test.ts   asserts the dependency rule holds
```

The dependency rule — outer layers depend on inner, never the reverse — is enforced by `eslint.config.js` and `tools/architecture.test.ts`, not by convention. A vendor type crossing a port boundary is a build failure.

## Known gaps before this is more than a local dev stack

- **Auth is a development stub.** `apps/server/src/auth.ts` trusts request headers, so anyone who can reach the port is any user they claim to be. Better Auth drops in behind the same `AuthPort` interface. Do not expose this beyond localhost until that is done.
- No RBAC, no rate limiting, no CSP.
- `/ws/runner` is declared but closes immediately — the Runner protocol is Phase 1.
