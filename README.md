# Loom

**Run ten coding agents at once — and measure them instead of trusting them.**

[![check](https://github.com/raminjafary/loom/actions/workflows/check.yml/badge.svg)](https://github.com/raminjafary/loom/actions/workflows/check.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A522-5FA04E)
![tests](https://img.shields.io/badge/tests-2%2C638-brightgreen)

One agent in a terminal is a solved problem. Ten is not. Who reviews ten branches? What stops
two agents editing the same file? When an agent says it is finished — what checked?

Loom is a multi-agent platform built around one rule:

> **An agent's claim about its own work is never the evidence for it.**

What settles it is always something outside the agent — the repository's own tests, a byte count
at the network boundary, a set of held-out work, or a human reading the exact command.

| | |
|---|---|
| **Spend** | counted at the proxy from the provider's own responses, never self-reported |
| **Done** | the repository's named checks, with the verdict derived server-side |
| **Better** | a prompt change has to win a measurement before the next run is told it |
| **Contained** | one git clone and one container per run, holding no credentials |

---

## Screenshots

**A run in its thread.** Each tool call, its result and the completion render as messages you can
read in order. This one added a row to this file's own table, and cost nine cents.

![A run's thread: Bash, Read and Edit tool calls, an approval, and a completion line reading "Run completed ($0.0881)"](docs/screenshots/thread.jpg)

| | |
|---|---|
| ![An approval card showing the raw Edit payload — file_path, old_string, new_string — above Approve and Deny buttons](docs/screenshots/approval-card.jpg) | ![A diff view of branch loom/run-31b4e85a, one file, +1 −0, with Keep, Discard, Queue for merge and Push buttons](docs/screenshots/diff-review.jpg) |
| **Approval on the exact argv** — the tool call's real payload, never a model's description of it. Approval is bound to a hash of that call, so mutated arguments ask again. | **Nothing merges without a decision.** Keep the branch, discard it, queue it behind the others, or push it and open a PR. |
| ![The Inbox, in five columns: needs you, ready to review, stopped early, in the merge queue, landed](docs/screenshots/inbox.jpg) | ![A team canvas with a planner at the root, four workers below it, and a reconciler, joined by labelled edges](docs/screenshots/team-canvas.jpg) |
| **An inbox, not a firehose** — what needs *you*, not a stream of everything every agent did. | **A canvas that will not draw an edge the runtime would refuse.** Who may hand work to whom, and who reviews whom. |
| ![The persona editor: name, model, description, tool checkboxes, approval mode, budget cap, and a self-modification envelope](docs/screenshots/persona-editor.jpg) | <img src="docs/screenshots/cost.png" width="300" alt="The cost panel: $4.8965 across 40 runs, broken down by model, by persona and by channel"> |
| **A persona is a document.** A model, a tool list, an approval mode, a cap — and an envelope bounding what it may rewrite about itself. | **Spend measured at the network boundary**, and it is what the caps are enforced against. |

---

## What it does

| | |
|---|---|
| 🧵 **Plans and delegates** | A goal becomes a DAG of subtasks; sub-planners take their own areas; workers share a notes ledger |
| 📦 **One clone, one container per run** | No credentials inside, no network but one proxy, and your working tree is never touched |
| 🛡️ **Approves on the real command** | The card shows the argv from the tool call, hash-bound so changed arguments ask again |
| 🚦 **Merges in a queue, not a race** | Rebase, verify, fast-forward — one branch per repository, with a reconciler for additive conflicts |
| ✅ **Lets the repository define "done"** | Named, ordered checks run in the sandbox; the verdict is the platform's, not the agent's |
| 💸 **Meters spend and enforces caps** | Read from the provider's responses at the proxy: pre-flight estimate, per-turn check, hard kill |
| 🎛️ **Steers mid-flight** | Re-plan a running swarm, or answer a question a blocked run asked, without restarting it |
| 🔁 **Improves prompts by measurement** | An agent may rewrite itself inside a ceiling you set — then both versions run, and outcomes decide |
| 🗺️ **Builds expertise it can be held to** | A map of a codebase where every claim carries how it was arrived at, and retrieval is a trial with a withheld arm |
| 🕸️ **Draws harnesses instead of scripting them** | Reusable shapes for a class of work, validated before they can spend — each must beat a planner to earn its place |
| 🔬 **Prosecutes its own diffs** | A pass that writes tests *against the change* and runs them. Evidence for a reviewer; it blocks nothing |
| ⬆️ **Replaces itself, and proves it first** | Frozen install, health check, checks matched against the running revision — only then does a pointer move |

Two execution backends behind one port: the Claude Agent SDK, and any model you serve yourself
over the chat-completions protocol.

**→ [Design notes](docs/design.md)** — what each of these means in practice, and why it is built
that way.

---

## Quickstart

**You need:** Node ≥ 22 · pnpm 11 · Docker or Podman · `claude` installed and authenticated.

```bash
pnpm install
cp .env.example .env      # set BETTER_AUTH_SECRET and WS_SUBSCRIPTION_SECRET
openssl rand -base64 32   # one for each; short ones are refused at boot
make up                   # containers, migrations, then every app
```

Sign up through the UI at `localhost:5173`; a workspace provisions on first login.

<details>
<summary>Starting the pieces individually</summary>

```bash
docker compose up -d               # Postgres 18 + Valkey 9 + egress proxy
pnpm db:migrate                    # apply the schema
pnpm --filter @loom/server dev     # API + /rpc + /ws/runner  :3001
pnpm --filter @loom/ws-gateway dev # realtime fan-out         :3002
pnpm --filter @loom/web dev        # UI                       :5173
```

`make dev` frees the dev ports first, deliberately: a `pnpm dev` that outlived its terminal keeps
serving pre-migration code. `make kill` does that alone — including a hand-started Runner, which
holds no port. `make status` shows what is up.
</details>

### Run an agent

Everything is reachable from the UI sidebar: pair a Runner, bind a repository, write a persona,
`@mention` it. The Runner clones the repository per run and never touches its working tree.

<details>
<summary>Driving it over RPC instead</summary>

1. `runner.createPairingToken({name})` → a `runnerId` and a raw token
2. Start the Runner against the *parent directory* of your repositories:
   ```bash
   LOOM_SERVER_WS_URL=ws://localhost:3001/ws/runner \
   LOOM_PAIRING_TOKEN=<token> \
   LOOM_ALLOWED_ROOTS=/absolute/path/to/allowed/parent \
   pnpm --filter @loom/runner start
   ```
3. `repository.bindExisting({runnerId, path, displayName})`
4. `persona.create({markdownSource})` — markdown plus frontmatter
5. `agentRun.start({threadId, repositoryId, personaId})`
</details>

### Merge a branch

A finished branch is **queued, never merged on the spot** — *Queue for merge*, or
`mergeQueue.enqueue({agentRunId})`. A sweep rebases onto the default branch, runs the
repository's checks **inside the sandbox** with no network, and fast-forwards. One branch per
repository at a time, so siblings converge instead of racing.

The queue refuses rather than forces three things: a branch that conflicts (handed back to its
run to fix and re-queue), a target branch with uncommitted changes, and a target that moved
mid-merge.

---

## How it works

```
packages/
  domain/            pure entities and rules, zero dependencies
  application/       use-cases + ports (interfaces only)
  db/                Drizzle/Postgres adapters — the only place ORM types exist
  api-contract/      oRPC procedures + Zod schemas — the client wire boundary
  runner-protocol/   WS frame schemas shared by server and runner
  client-core/       framework-agnostic client logic
apps/
  server/            Fastify + oRPC + /ws/runner
  ws-gateway/        stateless realtime fan-out to browsers
  web/               Vite + Vue 3 — thin views over client-core
  runner/            local daemon: holds your repositories, drives the Agent SDK
  egress-proxy/      credential-injecting, metering, allowlisting boundary
tools/               37 live drivers: real server, real Runner, real git
```

**Outer layers depend on inner, never the reverse** — enforced by `eslint.config.js` and
`tools/architecture.test.ts`, so a violation is a build failure rather than a review comment.

Two seams matter. The **Runner** is a separate process on the machine holding your repositories;
the server never touches your filesystem. The **egress proxy** sits between every sandbox and the
network, holding the real credential so the sandbox holds only a per-run lease.

**→ [Design notes](docs/design.md#how-it-works)**

---

## Security

Prompt injection is the threat model, not an edge case: any agent reading a file, a diff or a web
page is reading attacker-controllable instructions.

| | |
|---|---|
| **Secrets never enter the sandbox** | The run holds a revocable per-run lease; the proxy swaps it for the real credential. Metering happens on that path, which is why spend is authoritative |
| **The agent never pushes** | It commits in its sandbox; the host pushes after a policy check — own branch only, no force-push, no CI-config change without a second acknowledgement |
| **Approvals are identity-bound** | Only a `user` principal can resolve a gate, so an injected agent cannot approve itself |
| **A network per sandbox** | Holding it and the proxy, so one run cannot reach another by container name. `--cap-drop=ALL`, non-root, read-only rootfs, only the run's clone mounted |
| **The clone gets no vote** | `settingSources: []` — a committed `.claude/settings.json` cannot grant permissions nobody asked for |
| **A planner cannot act** | Read-only tools, enforced when the persona is authored |

Two limits, stated plainly: **the model API call is itself an unblockable exfiltration channel**,
which is why the real control is "secrets never enter the sandbox"; and **unsandboxed runs get
the Runner's own privileges**, which is why that mode needs a deliberately awkward
acknowledgement.

**→ [Design notes](docs/design.md#security-model)**

---

## Development

```bash
make check            # what CI runs: typecheck, lint, the suite, the boundary test
pnpm test             # 2,638 tests across 140 files
pnpm db:test:prepare  # four test databases — re-run after any db:generate
make browser          # the UI in a real browser, against a real server
```

**No automated test calls a real model.** That path belongs to the 37 live drivers in `tools/`,
run by hand — each drives a real server, a real Runner process and real git, and each *asserts*
rather than prints. Most spend nothing at all.

```bash
docker compose up -d postgres valkey
npx tsx tools/workflow-check.mts    # a drawn shape dealing real runs
npx tsx tools/prosecutor-check.mts  # evidence that changes no verdict
npx tsx tools/browser-check.mts     # the UI, asserting on what is visible
```

A few put a real model behind the same machinery, because the cheap drivers answer on the model's
behalf and that is exactly where three defects hid:

```bash
export $(grep -E "^LOOM_EGRESS_CONTROL_SECRET=" .env | xargs)
LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/designer-live.mts  # a model draws a harness
LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/search-live.mts    # a prompt search, end to end
LOOM_USE_HOST_CLAUDE_AUTH=1 npx tsx tools/trial-traffic.mts  # ten tasks, five a side
```

Two things that otherwise cost you a pass: the API key in `.env.example` is a **placeholder**
(without `LOOM_USE_HOST_CLAUDE_AUTH=1` a driver passes about nothing), and after touching
`apps/runner/src/` you must **rebuild the sandbox image** — the Runner refuses a stale one,
because an out-of-date image does not fail, it quietly runs older agent-side code.

**→ [Design notes](docs/design.md#development)** · **[Configuration](docs/design.md#configuration)**

---

## Roadmap

**Recently landed.** A network per sandbox. A real browser in CI. The prosecutor pass.
Self-replacement exercised on a real dependency change. The prompt-improvement loop driven end to
end on real traffic — and the workflow trial's verdict, which now goes *to* the harness on both
dispositions and cost.

**Next.** More traffic through that trial, since one pass is a result rather than a finding ·
RBAC, rate limiting and CSP · microVM isolation, on a host that provides the runtime · platform
channels on the second execution backend.

## Contributing

Run `make check` before opening a pull request — it is exactly what CI runs. The dependency rule
is enforced, so a violation is a build failure rather than a review comment. If a change needs a
reason recorded, that reason belongs in a comment next to the code it affects.

## License

[MIT](./LICENSE) — use it, fork it, ship it.
