import { createHash } from 'node:crypto'
import {
  BARRIER_PASSED,
  canonicalWorkflow,
  describeWorkflowCost,
  ForbiddenError,
  isRunNode,
  laneSources,
  nextWorkflowActions,
  NotFoundError,
  parseWorkflowAnswer,
  parseWorkflowGraph,
  userActor,
  ValidationError,
  workflowMayStart,
  asUserId,
  systemActor,
  type Actor,
  type AgentPersona,
  type AgentRunId,
  type RepositoryId,
  type ThreadId,
  type WorkflowGraph,
  type WorkflowId,
  type WorkflowNode,
  type WorkflowRecord,
  type WorkflowRunId,
  type WorkflowRunRecord,
  type WorkflowStepRunRecord,
  type WorkflowVersionRecord,
  type WorkspaceId,
} from '@loom/domain'
import { startAgentRun, type AgentDeps } from './agent-use-cases.js'

/**
 * Authoring and running a drawn workflow.
 *
 * Everything here is a thin layer over two things that already decided the hard parts:
 * `parseWorkflowGraph` says what a shape may be, and `nextWorkflowActions` says what may run
 * next. What is left for this file is the three questions those two cannot answer because they
 * are questions about *this* deployment — whether the personas a shape names exist, whether the
 * person asking is allowed to spend, and what a step's run actually cost.
 */

/**
 * The digest a version is identified by.
 *
 * Domain owns what "the same workflow" means and this hashes it, the way the capability
 * registry hashes a canonical tool list. Keeping `createHash` on this side is what lets the
 * domain package stay free of `node:` imports for the browser that also parses it.
 */
export const workflowDigest = (graph: WorkflowGraph): string =>
  createHash('sha256').update(canonicalWorkflow(graph)).digest('hex')

const requireHuman = (actor: Actor, what: string): void => {
  if (actor.kind !== 'user') {
    throw new ForbiddenError(`Only a person may ${what}.`)
  }
}

const actorUserId = (actor: Actor): string | null =>
  actor.kind === 'user' ? (actor.userId as string) : null

/**
 * Validates a drawn shape all the way down, including the parts only a *deployment* can check.
 *
 * Three passes, and the order is the useful one: the vocabulary, then the lane arithmetic the
 * executor depends on, then whether the personas it names are personas this workspace has. A
 * graph that fails the third is a graph somebody drew against another workspace's roster, and
 * finding that out at drawing time rather than at the fourth step of an execution is the whole
 * point of validating a harness before running it.
 */
export const validateWorkflowGraph = (
  value: unknown,
  personas: readonly AgentPersona[],
): { readonly ok: true; readonly graph: WorkflowGraph } | { readonly ok: false; readonly reason: string } => {
  const parsed = parseWorkflowGraph(value)
  if (!parsed.ok) return parsed

  const lanes = laneSources(parsed.graph)
  if (!lanes.ok) return { ok: false, reason: lanes.reason }

  const known = new Set(personas.map((persona) => persona.name))
  for (const node of parsed.graph.nodes) {
    if (!isRunNode(node)) continue
    if (!known.has(node.persona)) {
      return {
        ok: false,
        reason: `"${node.id}" runs the persona "${node.persona}", which this workspace does not have.`,
      }
    }
  }
  return { ok: true, graph: parsed.graph }
}

export const createWorkflow = async (
  deps: AgentDeps,
  input: {
    workspaceId: WorkspaceId
    actor: Actor
    name: string
    description: string | null
    graph: unknown
  },
): Promise<{ workflow: WorkflowRecord; version: WorkflowVersionRecord }> => {
  requireHuman(input.actor, 'draw a workflow')
  const name = input.name.trim()
  if (name.length === 0) throw new ValidationError('A workflow needs a name.')

  const personas = await deps.personas.listByWorkspace(input.workspaceId)
  const verdict = validateWorkflowGraph(input.graph, personas)
  if (!verdict.ok) throw new ValidationError(verdict.reason)

  return deps.workflows.create({
    workspaceId: input.workspaceId,
    name,
    description: input.description,
    createdByUserId: actorUserId(input.actor),
    graph: verdict.graph,
    digest: workflowDigest(verdict.graph),
  })
}

/**
 * Draws a new version of an existing workflow.
 *
 * Never an edit. The previous version keeps its rows, its digest and every execution that ran
 * against it, which is what makes a shape something a measurement can refer to months later.
 */
export const redrawWorkflow = async (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId; actor: Actor; workflowId: WorkflowId; graph: unknown },
): Promise<WorkflowVersionRecord> => {
  requireHuman(input.actor, 'redraw a workflow')
  const existing = await deps.workflows.findById(input.workspaceId, input.workflowId)
  if (!existing) throw new NotFoundError('Workflow')

  const personas = await deps.personas.listByWorkspace(input.workspaceId)
  const verdict = validateWorkflowGraph(input.graph, personas)
  if (!verdict.ok) throw new ValidationError(verdict.reason)

  const version = await deps.workflows.addVersion({
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    createdByUserId: actorUserId(input.actor),
    graph: verdict.graph,
    digest: workflowDigest(verdict.graph),
  })
  if (!version) throw new NotFoundError('Workflow')
  return version
}

/** The cost ceiling a person reads before starting one, from the personas the shape names. */
export const describeWorkflowVersion = (
  graph: WorkflowGraph,
  personas: readonly AgentPersona[],
): string => {
  const capOf = new Map(personas.map((persona) => [persona.name, persona.harnessBudgetCapUsd]))
  return describeWorkflowCost(
    graph,
    graph.nodes.map((node) => ({
      id: node.id,
      budgetCapUsd: isRunNode(node) ? (capOf.get(node.persona) ?? null) : 0,
    })),
  )
}

/**
 * Opens an execution.
 *
 * Human-only, and for the reason a campaign is: this authorizes spend against a cap, and the
 * executor then deals every step *as this person*. A run that could open a workflow would be a
 * run granting itself a budget and a shape to spend it on.
 */
export const startWorkflowRun = async (
  deps: AgentDeps,
  input: {
    workspaceId: WorkspaceId
    actor: Actor
    workflowId: WorkflowId
    repositoryId: RepositoryId
    threadId: ThreadId
    input: string
    capUsd: number | null
  },
): Promise<{ run: WorkflowRunRecord; detail: string }> => {
  requireHuman(input.actor, 'start a workflow')
  const task = input.input.trim()
  if (task.length === 0) throw new ValidationError('A workflow run needs something to run on.')

  const version = await deps.workflows.latestVersion(input.workspaceId, input.workflowId)
  if (!version) throw new NotFoundError('Workflow')

  /**
   * Re-validated at start rather than trusted from the version row. The shape was checked when
   * it was drawn, and a persona it names can have been deleted since — the failure that would
   * otherwise surface as a step nobody can deal, halfway through a paid execution.
   */
  const personas = await deps.personas.listByWorkspace(input.workspaceId)
  const verdict = validateWorkflowGraph(version.graph, personas)
  if (!verdict.ok) throw new ValidationError(verdict.reason)

  const run = await deps.workflows.openRun({
    workspaceId: input.workspaceId,
    workflowVersionId: version.id,
    repositoryId: input.repositoryId,
    threadId: input.threadId,
    input: task,
    capUsd: input.capUsd,
    startedByUserId: actorUserId(input.actor),
  })
  return { run, detail: describeWorkflowVersion(version.graph, personas) }
}

/** How many workflows and executions a list returns. Bounded here, so no caller invents one. */
export const MAX_WORKFLOWS_LISTED = 50
export const MAX_WORKFLOW_RUNS_LISTED = 20

/**
 * One execution, step by step, with the graph beside it.
 *
 * The steps are rows rather than a tree, and the graph travels with them: a workflow is a DAG,
 * so the edges are what makes the rows readable, and a tree would have to name one predecessor
 * "the parent" and assert something false about which answers a step actually had.
 */
export const readWorkflowRun = async (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId; runId: WorkflowRunId },
): Promise<{
  run: WorkflowRunRecord
  workflowName: string
  version: WorkflowVersionRecord
  spentUsd: number
  steps: WorkflowStepRunRecord[]
} | null> => {
  const run = await deps.workflows.findRun(input.workspaceId, input.runId)
  if (!run) return null
  const version = await deps.workflows.findVersion(input.workspaceId, run.workflowVersionId)
  if (!version) return null
  const workflow = await deps.workflows.findById(input.workspaceId, version.workflowId)
  return {
    run,
    workflowName: workflow?.name ?? 'a workflow that has been deleted',
    version,
    spentUsd: await deps.workflows.spentOnRun(input.workspaceId, input.runId),
    steps: await deps.workflows.stepsForRun(input.workspaceId, input.runId),
  }
}

export const cancelWorkflowRun = async (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId; actor: Actor; runId: WorkflowRunId },
): Promise<WorkflowRunRecord> => {
  requireHuman(input.actor, 'stop a workflow')
  const closed = await deps.workflows.closeRun(input.workspaceId, input.runId, {
    status: 'cancelled',
    reason: 'A person stopped it.',
  })
  if (!closed) throw new NotFoundError('Workflow run')
  return closed
}

/**
 * What one step answered, recorded when the step's own tool call arrives.
 *
 * Validated here against the schema its node declared, so a model that answered the wrong shape
 * is told *in the tool result* and can answer again. A schema checked later, when the sweep
 * settles the step, would turn every mis-shaped answer into a refusal the model never saw and
 * could not have fixed.
 *
 * The step is resolved **from the run**, never from the payload: a node id in a tool call is
 * model output, and a step that could name which step it was would be a step that could answer
 * for another one.
 */
export const recordWorkflowAnswer = async (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId; agentRunId: AgentRunId; answer: unknown },
): Promise<{ ok: true; outcome: string } | { ok: false; error: string }> => {
  const step = await deps.workflows.findStepByRun(input.workspaceId, input.agentRunId)
  if (!step) return { ok: false, error: 'This run is not a step of any workflow.' }
  if (step.status !== 'running') {
    return { ok: false, error: 'This step is already settled, so its answer cannot change.' }
  }

  const node = await nodeOf(deps, input.workspaceId, step)
  if (!node || !isRunNode(node)) {
    return { ok: false, error: 'The shape this step belongs to no longer has a node for it.' }
  }
  const schema = node.kind === 'router' ? ROUTER_ANSWER : (node.kind === 'step' || node.kind === 'fan' || node.kind === 'verifier' ? node.answer : null)

  const parsed = parseWorkflowAnswer(schema, input.answer)
  if (!parsed.ok) return { ok: false, error: parsed.reason }

  await deps.workflows.recordStepAnswer(input.workspaceId, step.id, parsed.answer)
  return { ok: true, outcome: 'Answer recorded. Finish up; the workflow moves on when this run ends.' }
}

/** A router's answer is one field and the vocabulary is its own choices, so it declares nothing. */
const ROUTER_ANSWER = { fields: [{ kind: 'text' as const, name: 'choice' }] }

const nodeOf = async (
  deps: AgentDeps,
  workspaceId: WorkspaceId,
  step: WorkflowStepRunRecord,
): Promise<WorkflowNode | null> => {
  const run = await deps.workflows.findRun(workspaceId, step.workflowRunId)
  if (!run) return null
  const version = await deps.workflows.findVersion(workspaceId, run.workflowVersionId)
  return version?.graph.nodes.find((node) => node.id === step.nodeId) ?? null
}

/**
 * The executor's tick.
 *
 * Best-effort throughout, like every sweep here: an execution that cannot be advanced is left
 * running rather than closed, because a workflow closed by an error would report a partial
 * result as if a cap had been reached.
 */
export const advanceWorkflowQueue = async (
  deps: AgentDeps,
  options: { stepStuckMs: number; maxStartsPerTick: number },
): Promise<void> => {
  const running = await deps.workflows.listRunningWorkflowRuns().catch(() => [])
  let budget = options.maxStartsPerTick
  for (const { workspaceId, runId } of running) {
    if (budget <= 0) return
    try {
      budget -= await advanceWorkflowRun(deps, workspaceId, runId, {
        stepStuckMs: options.stepStuckMs,
        maxStarts: Math.max(0, budget),
      })
    } catch {
      // Left running on purpose: the next tick tries again.
    }
  }
}

const advanceWorkflowRun = async (
  deps: AgentDeps,
  workspaceId: WorkspaceId,
  runId: WorkflowRunId,
  options: { stepStuckMs: number; maxStarts: number },
): Promise<number> => {
  const run = await deps.workflows.findRun(workspaceId, runId)
  if (!run || run.status !== 'running') return 0
  const version = await deps.workflows.findVersion(workspaceId, run.workflowVersionId)
  if (!version) {
    await deps.workflows.closeRun(workspaceId, runId, {
      status: 'failed',
      reason: 'the shape this execution was opened against no longer exists',
    })
    return 0
  }

  // 1. Settle what has finished, with what it cost.
  await settleFinishedSteps(deps, workspaceId, runId, options.stepStuckMs)

  const steps = await deps.workflows.stepsForRun(workspaceId, runId)
  const plan = nextWorkflowActions({ graph: version.graph, steps, input: run.input })

  // 2. Barriers and skipped paths cost nothing, so they are written before the cap is consulted.
  for (const entry of [...plan.collect, ...plan.skip]) {
    const claimed = await deps.workflows.claimStep({
      workspaceId,
      workflowRunId: runId,
      nodeId: entry.nodeId,
      pass: entry.pass,
      itemIndex: entry.itemIndex,
      item: null,
    })
    if (!claimed) continue
    await deps.workflows.finishStep(workspaceId, claimed.id, {
      status: entry.reason === BARRIER_PASSED ? 'answered' : 'skipped',
      answer: entry.reason === BARRIER_PASSED ? {} : null,
      reason: entry.reason,
      costUsd: null,
    })
  }

  // 3. Start what the cap still allows.
  const personas = await deps.personas.listByWorkspace(workspaceId)
  const personaByName = new Map(personas.map((persona) => [persona.name, persona]))
  const nodeById = new Map(version.graph.nodes.map((node) => [node.id, node]))
  let started = 0

  for (const entry of plan.deal) {
    if (started >= options.maxStarts) break
    const spent = await deps.workflows.spentOnRun(workspaceId, runId)
    const permitted = workflowMayStart({ capUsd: run.capUsd, spentUsd: spent })
    if (!permitted.ok) {
      await deps.workflows.closeRun(workspaceId, runId, {
        status: 'halted',
        reason: permitted.reason,
      })
      return started
    }

    const persona = personaByName.get(entry.persona)
    const claimed = await deps.workflows.claimStep({
      workspaceId,
      workflowRunId: runId,
      nodeId: entry.nodeId,
      pass: entry.pass,
      itemIndex: entry.itemIndex,
      item: entry.item,
    })
    if (!claimed) continue

    if (!persona) {
      await deps.workflows.finishStep(workspaceId, claimed.id, {
        status: 'refused',
        answer: null,
        reason: `the persona "${entry.persona}" no longer exists in this workspace`,
        costUsd: null,
      })
      continue
    }

    started += 1
    try {
      const node = nodeById.get(entry.nodeId)
      const agentRun = await startAgentRun(deps, {
        workspaceId,
        /**
         * As the person who started it — the campaign's precedent and the merge queue's before
         * it. The human authorized these runs, with a cap, when they opened the execution.
         */
        actor:
          run.startedByUserId === null ? systemActor() : userActor(asUserId(run.startedByUserId)),
        threadId: run.threadId,
        repositoryId: run.repositoryId,
        personaId: persona.id,
        relation: 'workflow',
        task: entry.task,
        ...(node !== undefined && answerFieldsOf(node).length > 0
          ? { answerWorkflow: { fields: answerFieldsOf(node) } }
          : {}),
      })
      await deps.workflows.attachStepRun(workspaceId, claimed.id, agentRun.id)
    } catch {
      /**
       * Released rather than refused — "we have not tried yet" is not an answer.
       *
       * Only reached when no run could be created at all (a disconnected Runner, a paused
       * workspace). A *dispatch* failure does not come back here: `startAgentRun` records that
       * run as failed and returns it, and the next tick settles the step as a refusal naming
       * the run — which is the better outcome, because there is then something in the thread
       * for a person to look at.
       */
      await deps.workflows.releaseStep(workspaceId, claimed.id)
      started -= 1
    }
  }

  // 4. Close when nothing is running and nothing more can be dealt.
  const after = await deps.workflows.stepsForRun(workspaceId, runId)
  const settled = nextWorkflowActions({ graph: version.graph, steps: after, input: run.input })
  if (settled.done) {
    await deps.workflows.closeRun(workspaceId, runId, {
      status: settled.failure === null ? 'finished' : 'failed',
      reason: settled.failure,
    })
  }
  return started
}

/**
 * What a node's answer tool must accept.
 *
 * A router's is fixed rather than authored, because its vocabulary *is* its declared choices and
 * asking an author to also write a matching schema would be two places to change one thing.
 */
export const answerFieldsOf = (node: WorkflowNode): { kind: 'text' | 'flag' | 'list'; name: string }[] => {
  if (node.kind === 'router') return [{ kind: 'text', name: 'choice' }]
  if (node.kind === 'step' || node.kind === 'fan' || node.kind === 'verifier') {
    return (node.answer?.fields ?? []).map((field) => ({ kind: field.kind, name: field.name }))
  }
  return []
}

/**
 * Turns every step whose run has ended into an answer or a refusal, with the run's cost on it.
 *
 * A step is settled when its **run** is terminal rather than when its answer arrived, which is
 * the only ordering that lets the cap be summed from these rows: the answer comes mid-run and
 * the spend is only known at the end, so settling on the answer would record every step's cost
 * as null.
 */
const settleFinishedSteps = async (
  deps: AgentDeps,
  workspaceId: WorkspaceId,
  runId: WorkflowRunId,
  stuckMs: number,
): Promise<void> => {
  const now = Date.now()
  for (const step of await deps.workflows.stepsForRun(workspaceId, runId)) {
    if (step.status !== 'running') continue

    if (step.agentRunId === null) {
      const claimedAt = step.claimedAt?.getTime()
      if (claimedAt !== undefined && now - claimedAt > stuckMs) {
        await deps.workflows.finishStep(workspaceId, step.id, {
          status: 'refused',
          answer: null,
          reason: 'this step was claimed but never started a run',
          costUsd: null,
        })
      }
      continue
    }

    const agentRun = await deps.agentRuns.findById(workspaceId, step.agentRunId)
    if (!agentRun) {
      await deps.workflows.finishStep(workspaceId, step.id, {
        status: 'refused',
        answer: null,
        reason: 'the run this step was dealt to no longer exists',
        costUsd: null,
      })
      continue
    }
    if (agentRun.status !== 'completed' && agentRun.status !== 'failed' && agentRun.status !== 'cancelled') {
      const claimedAt = step.claimedAt?.getTime()
      if (claimedAt !== undefined && now - claimedAt > stuckMs) {
        await deps.workflows.finishStep(workspaceId, step.id, {
          status: 'refused',
          answer: null,
          reason: `this step did not finish within ${Math.round(stuckMs / 60_000)} min`,
          costUsd: agentRun.totalCostUsd,
        })
      }
      continue
    }

    /**
     * A run that ended without answering is a refusal even when the run itself "succeeded".
     * The step's contract is the shape it declared, and a step that produced prose where a
     * list belonged has not done the thing the graph below it is waiting for.
     */
    const answered = step.answer !== null
    await deps.workflows.finishStep(workspaceId, step.id, {
      status: answered ? 'answered' : 'refused',
      answer: step.answer,
      reason: answered
        ? null
        : agentRun.status === 'completed'
          ? 'the run ended without submitting an answer'
          : `the run ${agentRun.status}`,
      costUsd: agentRun.totalCostUsd,
    })
  }
}
