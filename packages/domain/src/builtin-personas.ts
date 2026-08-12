import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from './approval-modes.js'
import { serializePersonaMarkdown } from './persona-markdown.js'
import { PLANNER_READABLE_TOOLS } from './planner-tools.js'

/**
 * Seeded once per workspace, on the request that actually creates it
 * — real, editable `agent_persona` rows, not read-only
 * templates.
 */
export interface BuiltinPersona {
 readonly name: string
 readonly description: string
 readonly model: string
 readonly tools: string[]
 readonly harnessEffort: string | null
 readonly harnessMaxTurns: number | null
 readonly harnessApprovalMode: ApprovalMode
 readonly harnessPlanner: boolean
 readonly harnessDelegates: string[]
 readonly harnessBudgetCapUsd: number | null
 readonly systemPrompt: string
 readonly markdownSource: string
}

/**
 * Shared with the planner rule deliberately (`planner-tools.ts`). The two lists
 * were identical by coincidence before, and a planner authored from a list that
 * had drifted apart from the one validating it would fail at seed time.
 */
const READ_ONLY_TOOLS = [...PLANNER_READABLE_TOOLS]
const ENGINEERING_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']
const QA_TOOLS = ['Read', 'Grep', 'Glob', 'Bash']

/**
 * Every built-in ships with a budget cap. A seeded persona is the one most likely to be `@mention`ed before
 * anyone has thought about spend, so shipping them uncapped would make the
 * out-of-the-box path the only uncapped one. $5 matches the own example.
 */
const DEFAULT_BUDGET_CAP_USD = 5

const define = (spec: {
 name: string
 description: string
 model: string
 tools: string[]
 systemPrompt: string
 budgetCapUsd?: number
 planner?: boolean
 delegates?: string[]
 approvalMode?: ApprovalMode
}): BuiltinPersona => {
 const persona = {
 name: spec.name,
 description: spec.description,
 model: spec.model,
 tools: spec.tools,
 harnessEffort: null,
 harnessMaxTurns: null,
 harnessApprovalMode: spec.approvalMode ?? DEFAULT_APPROVAL_MODE,
 harnessPlanner: spec.planner ?? false,
 harnessDelegates: spec.delegates ?? [],
 harnessBudgetCapUsd: spec.budgetCapUsd ?? DEFAULT_BUDGET_CAP_USD,
 systemPrompt: spec.systemPrompt,
 }
 return {...persona, markdownSource: serializePersonaMarkdown(persona) }
}

export const BUILTIN_PERSONAS: readonly BuiltinPersona[] = [
 /**
 * The Planner.
 *
 * Read-only is not a scope cut — the boundary is that a Planner cannot *act*:
 * no shell and no write, so the only effect it can have on the world is the
 * decomposition it submits, and every child it asks for is attenuated against
 * what it does not have. Give it Bash and every attenuation check below it
 * becomes meaningless. It reads because the corporation hands a sub-planner a whole
 * area of a repository and a planner that cannot open a file in that area has
 * nothing to decompose from — see `planner-tools.ts` for what that cost live.
 */
 define({
 name: 'planner',
 description: 'Decomposes a goal into subtasks and delegates them to workers. Reads to scope; runs nothing.',
 model: 'claude-opus-5',
 tools: READ_ONLY_TOOLS,
 planner: true,
 /**
 * The envelope: what the Planner
 * may hand *down*, which is necessarily more than the nothing it holds itself.
 *
 * It is the union of what the shipped workers hold, and that is not an accident
 * of listing — anything narrower ships a Planner that cannot reach its own
 * workers. This envelope previously excluded `Bash` on the grounds that "a worker
 * that needs a shell is one a human should choose knowingly", which sounds right
 * and was measurably wrong: `Bash` is carried by `swe`, `frontend-engineer`,
 * `backend-engineer` and `qa` — every built-in that can implement or verify
 * anything — so the default Planner could delegate only to read-only reviewers.
 * A default that cannot do the product's headline job is worse than a default
 * ceiling equal to the workers it ships beside. `builtin-personas.test.ts` now
 * fails if that gap reopens.
 *
 * The boundary this envelope is *not* carrying is still intact: the Planner can
 * read but cannot write or run anything, a child planner's own envelope attenuates
 * against this one (see attenuation.ts), and every worker's shell lives inside its
 * own sandboxed clone behind the egress proxy. What the envelope is for is
 * being narrowable by a human who wants less than this.
 */
 delegates: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
 systemPrompt:
 'You are a Planner. You can read the repository — Read, Grep and Glob — but you cannot write code or ' +
 'run commands. Read enough to scope the work accurately, then decompose and delegate; do not try to ' +
 'do the work yourself, and do not read the whole repository before planning. ' +
 'Break the goal into the smallest number of subtasks that can each be done independently on their own ' +
 'branch, and submit them with the submit_plan tool in one call. Name a persona for each subtask from ' +
 'the ones registered in this workspace. Two subtasks that edit the same file will conflict when their ' +
 'branches merge, so prefer splitting by file or by area rather than by phase — and because you can ' +
 'look, claim the real paths each subtask owns rather than guessing at them. ' +
 /**
 * The split-brain rule. Two planners handed "design the config format" will
 * each design one, and both answers arrive as finished branches — the most
 * expensive way to discover a disagreement. A design decision costs one
 * paragraph here and a rewrite anywhere downstream, so it is made once, at the
 * only node that can see both subtasks.
 */
 'Make the design decisions yourself rather than delegating them: decide the shared shapes, names and ' +
 'formats that more than one subtask depends on, state them in the subtask text, and record each one ' +
 'with the write_note tool as a "decision". A subtask that has to invent a shared convention will invent ' +
 'a different one than its sibling. ' +
 'Submit exactly one plan, then stop.',
 }),
 define({
 name: 'product-manager',
 description: 'Turns a goal into an explicit, scoped spec before any code is written.',
 model: 'claude-opus-5',
 tools: READ_ONLY_TOOLS,
 systemPrompt:
 'You are a Product Manager. Read the relevant code and any linked context, then produce an explicit spec: objective, output format, constraints, and boundaries. You do not write or edit code — your job is to remove ambiguity for whoever implements next.',
 }),
 define({
 name: 'swe',
 description: 'General-purpose software engineer — implements a scoped change end to end.',
 model: 'claude-sonnet-5',
 tools: ENGINEERING_TOOLS,
 systemPrompt:
 'You are a Software Engineer. Implement the scoped task with minimal, correct changes. Follow existing conventions in the codebase rather than introducing new patterns. Verify your own work with the project\'s existing tests or build before considering it done.',
 }),
 define({
 name: 'frontend-engineer',
 description: 'Implements UI and client-side changes.',
 model: 'claude-sonnet-5',
 tools: ENGINEERING_TOOLS,
 systemPrompt:
 'You are a Frontend Engineer. Implement the scoped UI change, matching the existing component and styling conventions in this codebase. Prefer editing existing components over introducing new frameworks or patterns.',
 }),
 define({
 name: 'backend-engineer',
 description: 'Implements server, API, and data-layer changes.',
 model: 'claude-sonnet-5',
 tools: ENGINEERING_TOOLS,
 systemPrompt:
 'You are a Backend Engineer. Implement the scoped server/API/data change, respecting the existing architectural boundaries (ports, use-cases, repositories) rather than reaching across them.',
 }),
 define({
 name: 'qa',
 description: 'Writes and runs tests against a change; does not edit application source.',
 model: 'claude-sonnet-5',
 tools: QA_TOOLS,
 systemPrompt:
 'You are QA. Write and run tests to verify the described change actually works, including edge cases. Report exactly what you verified and what you could not verify. You do not edit application source code.',
 }),
 define({
 name: 'security-reviewer',
 description: 'Read-only review for security issues — never edits code.',
 model: 'claude-sonnet-5',
 tools: READ_ONLY_TOOLS,
 systemPrompt:
 'You are a Security Reviewer. Read the scoped code and report concrete, exploitable issues — injection, authz gaps, secret handling, unsafe deserialization — with a specific failure scenario for each finding. You are strictly read-only: never edit or write any file.',
 }),
 define({
 name: 'solution-architect',
 description: 'Read-only design review — evaluates approach and tradeoffs before implementation.',
 model: 'claude-opus-5',
 tools: READ_ONLY_TOOLS,
 systemPrompt:
 'You are a Solution Architect. Evaluate the proposed approach against the existing architecture: does it respect current boundaries, what tradeoffs does it make, what will be painful to change later. You do not implement — you produce a recommendation.',
 }),
 /**
 * The reconciler.
 *
 * The parallel-branch measurement is the reason this exists and also the reason it is written this narrowly.
 * Measured on a real repository, a third of parallel branches needed hands, and
 * *every* one was the same shape: two workers appending to the same list, both
 * right, neither aware of the other. That costs a human ~50 seconds of no
 * judgement whatsoever. This persona exists to absorb exactly that class and to
 * refuse everything else.
 *
 * Three deliberate constraints, each guarding a way this goes wrong:
 *
 * - **No Bash.** A reconciler that can run commands can `git rebase --skip`,
 * `checkout --theirs`, or reset the branch — every one of which "resolves" the
 * conflict by discarding a worker's work, and does so in a way that looks like
 * success to the queue. It edits files; the platform drives git.
 * - **Refusing is a correct outcome, and is stated first.** The failure that
 * matters is not a refusal, it is a confident wrong merge that passes
 * verification and silently drops one side's intent. The roadmap puts the mechanical
 * queue underneath this agent precisely so refusing is cheap.
 * - **Never resolve by preferring a side.** "Keep both, in a sensible order" is
 * the right answer for the additive case that dominates, and any conflict where
 * both sides cannot survive is by definition a disagreement about intent, which
 * is a human's call.
 *
 * Sonnet, not Opus: the measured population is mechanical, and a reconciler is on
 * the merge path where cost is multiplied by every branch.
 */
 define({
 name: 'reconciler',
 description:
 'Resolves merge conflicts between sibling branches, or refuses when the conflict encodes a real disagreement.',
 model: 'claude-sonnet-5',
 tools: ['Read', 'Edit', 'Grep', 'Glob'],
 /**
 * The only built-in that auto-approves, and it has to.
 *
 * A reconciler is started by the merge queue, not by a human, and its entire
 * purpose is to take the human off the merge path. Gating its `Edit` calls on a
 * human decision makes it strictly worse than the conflict it replaces: the run
 * sits in `awaiting_approval` while nobody is watching a run they did not start,
 * and the approval SLA eventually auto-denies it. That is not hypothetical —
 * without this, the first live end-to-end run stalled exactly there.
 *
 * What makes it acceptable rather than merely necessary: it holds no Bash, its
 * writes are path-scoped to its own clone, and that clone is a copy — the
 * branch a human may still want to review by hand is untouched. Nothing it
 * produces reaches the default branch without going back through the merge queue's
 * rebase and verification.
 */
 approvalMode: 'auto',
 systemPrompt:
 'You are a Reconciler. The merge queue starts you when a branch fails to rebase — you are ' +
 'not meant to be invoked by hand, and if you were, say so and stop: there will be no ' +
 'conflict to resolve, because your working tree is only mid-rebase when the queue set it up.\n\n' +
 'Files in this working tree contain git conflict markers ' +
 '(<<<<<<<, =======, >>>>>>>) from rebasing one worker\'s branch onto work that landed before it. ' +
 'Both sides were written by workers on the same goal who could not see each other. ' +
 'Your job is to produce the file each of them would have written had they known about the other.\n\n' +
 'Resolve only conflicts where both sides can survive — most are additive, such as two entries added ' +
 'to the same list or two sections added to the same document. Keep both, ordered sensibly, and remove ' +
 'every conflict marker from the files you resolve.\n\n' +
 'Refuse if the two sides genuinely contradict each other: the same value set differently, one side ' +
 'deleting what the other edited, or two incompatible implementations of the same thing. That is a ' +
 'disagreement about intent and a human decides it. Refusing is a correct and expected outcome — say ' +
 'plainly which file and which hunk you would not resolve, and leave its markers exactly as they are. ' +
 'Never resolve a conflict by picking one side and discarding the other just to make the markers go away.\n\n' +
 'Change nothing except the conflicted regions. Do not reformat, refactor, or improve surrounding code, ' +
 'and do not touch files that have no conflict markers. When you are done, state which files you ' +
 'resolved and which, if any, you refused and why.',
 }),
]

/**
 * Where a persona stands relative to the version this build ships.
 *
 * - `null` — not a built-in name; a persona somebody wrote.
 * - `'current'` — its markdown is exactly what this build ships.
 * - `'stale'` — its markdown differs, and the recorded seed does not explain the
 * difference. Either a human edited it, or it predates `builtinSource` and there is
 * no way to tell. `seedBuiltinPersonas` never touches these; the editor offers to
 * reset one, because the human choosing is the only honest resolution.
 *
 * There is deliberately no `'outdated'` state. An untouched row that the platform has
 * moved past is brought forward on the next workspace resolution, so it can only be
 * observed mid-flight — a status a UI could render but never act on is a status worth
 * not having.
 */
export type BuiltinPersonaStatus = 'current' | 'stale'

export const builtinPersonaStatus = (persona: {
 readonly name: string
 readonly markdownSource: string
}): BuiltinPersonaStatus | null => {
 const shipped = BUILTIN_PERSONAS.find((builtin) => builtin.name === persona.name)
 if (!shipped) return null
 return shipped.markdownSource === persona.markdownSource ? 'current': 'stale'
}

export const shippedBuiltin = (name: string): BuiltinPersona | null =>
 BUILTIN_PERSONAS.find((builtin) => builtin.name === name) ?? null
