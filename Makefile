# Loom's dev stack, in two commands.
#
# `pnpm dev` alone is not enough to start from and not enough to stop with, and both
# gaps have cost real time. Starting: a dev server that outlives its terminal keeps
# serving pre-migration code, and a session was spent diagnosing a canvas that was not
# broken — the database had simply moved underneath a process nobody had restarted.
# Stopping: `pnpm dev` runs four processes through turbo, and Ctrl-C in the wrong
# terminal leaves some of them holding their ports, which the next `make dev` then
# fails on for a reason that names the port and not the cause.
#
# So `make dev` always clears the ports first, and `make down` stops everything a dev
# session started — processes and containers both.

SHELL := /bin/bash

# Every port a dev process binds. The web app is Vite's default; the other two are
# `.env`'s, and are read from it rather than repeated here so this file cannot drift
# from the thing it kills.
SERVER_PORT ?= $(shell grep -E '^SERVER_PORT=' .env 2>/dev/null | cut -d= -f2)
WS_GATEWAY_PORT ?= $(shell grep -E '^WS_GATEWAY_PORT=' .env 2>/dev/null | cut -d= -f2)
WEB_PORT ?= 5173
DEV_PORTS := $(or $(SERVER_PORT),3001) $(or $(WS_GATEWAY_PORT),3002) $(WEB_PORT)

.PHONY: help up dev down kill infra migrate status test check

help: ## What each target does
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

up: infra migrate ## Containers + migrations, then the dev processes in the foreground
	@$(MAKE) dev

dev: kill ## Clear the dev ports, then run every app under turbo
	pnpm dev

infra: ## Postgres, Valkey and the egress proxy
	docker compose up -d

migrate: ## Apply the schema to the dev database
	pnpm db:migrate

# `pnpm db:test:prepare` is deliberately not folded into `migrate`: the test databases
# are truncated by the suite, and a target that quietly touched them would make
# "I ran the migrations" ambiguous about which database moved.

kill: ## Free the dev ports, whatever is holding them
	@for port in $(DEV_PORTS); do \
		pids=$$(lsof -ti tcp:$$port 2>/dev/null); \
		if [ -n "$$pids" ]; then \
			echo "killing $$pids on :$$port"; \
			kill $$pids 2>/dev/null || true; \
		fi; \
	done
	@# A Runner is started by hand and by every live driver in tools/, so it holds no
	@# port and would survive the loop above — it is matched by its entrypoint instead.
	@pkill -f 'apps/runner/src/main.ts' 2>/dev/null || true
	@sleep 1

down: kill ## Stop the dev processes and the containers
	docker compose down

status: ## What is currently up
	@docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Ports}}' 2>/dev/null || true
	@echo
	@for port in $(DEV_PORTS); do \
		pid=$$(lsof -ti tcp:$$port 2>/dev/null | head -1); \
		echo ":$$port $${pid:-free}"; \
	done

test: ## The suite, against the test databases
	pnpm db:test:prepare
	pnpm test

check: ## Everything CI would run if this repository had CI
	pnpm typecheck
	pnpm lint
	$(MAKE) test
