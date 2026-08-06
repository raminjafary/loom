# The egress proxy holds the real model credential (PLAN.md §6 A6), so it is
# built as its own image rather than sharing one with anything a run can reach.
FROM node:24-alpine

RUN corepack enable

WORKDIR /app

# Workspace-aware install: the proxy imports @loom/domain for the price table and
# the egress allowlist, so those manifests have to be present before install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json packages/domain/
COPY apps/egress-proxy/package.json apps/egress-proxy/
RUN pnpm install --filter @loom/egress-proxy... --frozen-lockfile

COPY packages/domain packages/domain
COPY apps/egress-proxy apps/egress-proxy
COPY tsconfig.base.json ./

# Non-root: this process is internet-facing on one side and sandbox-facing on the
# other, which is exactly where a root process is least appropriate.
USER node

CMD ["pnpm", "--filter", "@loom/egress-proxy", "start"]
