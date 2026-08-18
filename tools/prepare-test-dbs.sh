#!/usr/bin/env bash
#
# Creates and migrates one test database per test package.
#
# Why one each, rather than the single `loom_test` this repo used until now: the
# three suites below run *concurrently* under turbo and every one of them truncates
# tables the others are mid-way through using. `packages/db` truncates `workspace`,
# which cascades to nearly every domain table, so a server integration test holding
# a run open loses it underneath itself.
#
# That was a known flake, seen "under load and never
# chased", and it passed often enough per-package to stay ignorable. It stopped
# being ignorable when a change that merely made the planner tests slower turned it
# from occasional into every run: a suite that always fails is not a gate, and a
# suite that fails for a reason unrelated to the change under test is worse, because
# it trains you to re-run rather than to read.
#
# `loom_test` itself is deliberately kept and migrated: the live drivers in tools/
# default to it, and repointing those is a separate decision from fixing the suite.
#
# Uses `docker compose exec` rather than a local psql, matching the README — this
# machine has the database in compose and no client on the PATH.
set -euo pipefail

DBS=(loom_test loom_test_db loom_test_server loom_test_gateway)

psql_do() {
  docker compose exec -T postgres psql -U loom -d postgres "$@"
}

for db in "${DBS[@]}"; do
  # `createdb` rather than `CREATE DATABASE IF NOT EXISTS`, which postgres does not
  # have. Already existing is the expected steady state, not an error.
  if psql_do -tAc "select 1 from pg_database where datname = '$db'" | grep -q 1; then
    echo "  $db exists"
  else
    psql_do -c "CREATE DATABASE $db" >/dev/null
    echo "  $db created"
  fi

  DATABASE_URL="postgres://loom:loom@localhost:5432/$db" \
    pnpm --filter @loom/db db:migrate >/dev/null 2>&1
  echo "  $db migrated"
done

echo "test databases ready"
