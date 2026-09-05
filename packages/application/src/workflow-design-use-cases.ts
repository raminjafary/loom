import {
  describeEscalations,
  designEscalations,
  ForbiddenError,
  MAX_DESIGN_DESCRIPTION_CHARS,
  MAX_DESIGN_NAME_CHARS,
  MAX_DESIGN_RATIONALE_CHARS,
  MAX_DESIGNS_PER_RUN,
  NotFoundError,
  renderDesignerBrief,
  summarizeWorkflowShape,
  ValidationError,
  delegationDesign,
  type Actor,
  type AgentPersona,
  type AgentRun,
  type AgentPersonaId,
  type AgentRunId,
  type PersonaSpec,
  type RepositoryId,
  type ThreadId,
  type WorkflowDesignId,
  type WorkflowDesignRecord,
  type WorkflowDesignStatus,
  type WorkflowVersionRecord,
  type WorkspaceId,
} from '@loom/domain'
import { resolveCapabilities, startAgentRun, type AgentDeps } from './agent-use-cases.js'
import {
  describeWorkflowVersion,
  MAX_WORKFLOWS_LISTED,
  validateWorkflowGraph,
  workflowDigest,
} from './workflow-use-cases.js'

/**
 * Asking for a harness, and deciding about the one that comes back.
 *
 * The manual path — a person drawing a graph through the contract — stays exactly as it was, and
 * this does not replace it: it replaces the *editor that was never built*. A shape is a
 * configuration a measurement cites, so an edit is a new version, and the version is drawn by
 * asking rather than by filling in a form.
 *
 * Three things this layer decides, none of which the domain can:
 *
 * - **Which personas the designer may name**, which is a question about this workspace's roster
 *   and this designer's own envelope. The rule is `delegationDesign`, unchanged, because drawing
 *   a step that runs a persona is delegating to it a version at a time.
 * - **What a designer is told before it draws** — the roster with what each persona holds, the
 *   harnesses this workspace already has, and the vocabulary. A designer that finds out at
 *   submission submits four times, and every round trip is a paid run.
 * - **When a proposal becomes a version**, which is when a person says so and never before.
 */

/** How many proposals a list returns. Bounded here, so no caller invents a number. */
export const MAX_DESIGNS_LISTED = 20

const requireHuman = (actor: Actor, what: string): void => {
  if (actor.kind !== 'user') throw new ForbiddenError(`Only a person may ${what}.`)
}

const actorUserId = (actor: Actor): string | null =>
  actor.kind === 'user' ? (actor.userId as string) : null

/**
 * A stored persona as the attenuation rules read it.
 *
 * Capabilities resolved, because the rule that most needs to be visible to a designer is the
 * one about them: an MCP server is a route to a shell, so a persona carrying one is a persona a
 * designer without it may not name.
 */
const specOf = async (
  deps: AgentDeps,
  workspaceId: WorkspaceId,
  persona: AgentPersona,
): Promise<PersonaSpec> => ({
  name: persona.name,
  systemPrompt: '',
  model: persona.model,
  tools: persona.tools,
  approvalMode: persona.harnessApprovalMode,
  budgetCapUsd: persona.harnessBudgetCapUsd,
  planner: persona.harnessPlanner,
  delegates: persona.harnessDelegates,
  envelope: persona.envelope,
  capabilities: await resolveCapabilities(deps, workspaceId, persona.id),
})

/**
 * Starts a designer, with the brief it draws from.
 *
 * Human-only, and for the reason opening an execution is: this authorizes a run to spend, and a
 * run that could start a designer would be a run arranging for its own configuration to change.
 *
 * The brief is assembled here and dispatched as the run's task, the way a proposer's record and a
 * verifier's blinded options are: what a designer is *told* is the whole of the mechanism, and a
 * session that assembled its own would be a session choosing what it knows.
 */
export const startWorkflowDesigner = async (
  deps: AgentDeps,
  input: {
    workspaceId: WorkspaceId
    actor: Actor
    personaId: AgentPersonaId
    threadId: ThreadId
    repositoryId: RepositoryId
    ask: string
  },
): Promise<{ run: AgentRun; brief: string }> => {
  requireHuman(input.actor, 'ask for a harness')
  const ask = input.ask.trim()
  if (ask.length === 0) throw new ValidationError('Say what the harness is for.')

  const designer = await deps.personas.findById(input.workspaceId, input.personaId)
  if (!designer) throw new NotFoundError('AgentPersona')
  const designerSpec = await specOf(deps, input.workspaceId, designer)

  const candidates = await deps.personas.listByWorkspace(input.workspaceId)
  const available: { name: string; description: string; model: string; tools: readonly string[] }[] = []
  const refused: { name: string; why: string }[] = []
  for (const candidate of candidates) {
    const spec = await specOf(deps, input.workspaceId, candidate)
    const design = delegationDesign(
      designerSpec,
      spec,
      Math.max(0, deps.limits.maxDelegationDepth - 1),
    )
    if (design.ok) {
      available.push({
        name: candidate.name,
        description: candidate.description,
        model: candidate.model,
        tools: candidate.tools,
      })
      continue
    }
    refused.push({
      name: candidate.name,
      why: design.refusals.map((refusal) => refusal.detail).join(' '),
    })
  }

  /**
   * What this workspace already has, as one line each.
   *
   * Whole graphs would be the obvious thing to hand over and the wrong one: six shapes is most
   * of a context window, and the question a designer is answering here is "does one of these
   * already do it", which a summary answers.
   */
  const workflows = await deps.workflows.listWorkflows(input.workspaceId, MAX_WORKFLOWS_LISTED)
  const existing: { name: string; version: number; shape: string }[] = []
  for (const workflow of workflows) {
    const version = await deps.workflows.latestVersion(input.workspaceId, workflow.id)
    if (!version) continue
    existing.push({
      name: workflow.name,
      version: version.version,
      shape: summarizeWorkflowShape(version.graph),
    })
  }

  const brief = renderDesignerBrief({
    ask,
    designerName: designer.name,
    available,
    refused,
    existing,
  })

  const run = await startAgentRun(deps, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    threadId: input.threadId,
    repositoryId: input.repositoryId,
    personaId: designer.id,
    relation: 'design',
    task: brief,
    /**
     * What makes this run a designer, and therefore what gives it the design tool at all — the
     * same gating a workflow step's answer schema is. Carrying the ask rather than a flag lets
     * the tool's own description name what was asked for, which is the one thing a model most
     * reliably drifts from over a long session.
     */
    designWorkflow: { ask },
  })
  return { run, brief }
}

/**
 * Records what a designer drew, as a proposal.
 *
 * Every refusal here comes back as a *tool result* rather than an exception, on the discipline
 * every model-facing channel in this platform keeps: "that node fans over a field that is not a
 * list" is something the session can act on, and it has the rest of its run in which to act.
 *
 * The run is the authority for who is proposing. Nothing about the designer comes from the
 * payload — not the persona, not the envelope, not which workflow this is a version of — because
 * a value in a tool call is model output, and the one thing this must not let a session do is
 * describe its own permissions.
 */
export const recordWorkflowDesign = async (
  deps: AgentDeps,
  input: {
    workspaceId: WorkspaceId
    agentRunId: AgentRunId
    name: string
    description: string | null
    rationale: string
    graph: unknown
  },
): Promise<{ ok: true; outcome: string } | { ok: false; error: string }> => {
  const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
  if (!run) return { ok: false, error: 'This run does not exist.' }
  if (run.relation !== 'design') {
    return { ok: false, error: 'This run was not started as a designer, so it cannot propose a harness.' }
  }

  const already = await deps.workflows.countDesignsByRun(input.workspaceId, run.id)
  if (already >= MAX_DESIGNS_PER_RUN) {
    return {
      ok: false,
      error:
        `This session has already proposed ${already} harnesses, which is the limit. A fourth ` +
        'would be filling a review queue rather than making a case — say which of the ones you ' +
        'sent you would pick and why, and stop.',
    }
  }

  const name = input.name.trim()
  if (name.length === 0) return { ok: false, error: 'A harness needs a name.' }
  if (name.length > MAX_DESIGN_NAME_CHARS) {
    return { ok: false, error: `A name may be at most ${MAX_DESIGN_NAME_CHARS} characters.` }
  }
  const rationale = input.rationale.trim()
  if (rationale.length === 0) {
    return {
      ok: false,
      error:
        'Say what this shape would make happen that one run of one agent would not. A person ' +
        'reads that beside the drawing and the ceiling; without it there is nothing to decide on.',
    }
  }
  if (rationale.length > MAX_DESIGN_RATIONALE_CHARS) {
    return {
      ok: false,
      error: `A rationale may be at most ${MAX_DESIGN_RATIONALE_CHARS} characters. Make the case, not the manual.`,
    }
  }
  const description = input.description === null ? null : input.description.trim().slice(0, MAX_DESIGN_DESCRIPTION_CHARS)

  const personas = await deps.personas.listByWorkspace(input.workspaceId)
  const verdict = validateWorkflowGraph(input.graph, personas)
  if (!verdict.ok) return { ok: false, error: verdict.reason }

  /**
   * The envelope is the designing *run's* snapshot, never the persona row it was started from.
   * A run is what it was launched as, so an envelope widened while this session was thinking
   * does not widen what it may name — the same rule every child start applies.
   */
  const specs: PersonaSpec[] = []
  for (const persona of personas) specs.push(await specOf(deps, input.workspaceId, persona))
  const escalations = designEscalations({
    designer: run.persona,
    graph: verdict.graph,
    personas: specs,
    remainingDepth: Math.max(0, deps.limits.maxDelegationDepth - 1),
  })
  if (escalations.length > 0) return { ok: false, error: describeEscalations(escalations) }

  /**
   * The name decides whether this is a new harness or a new version of one, and it is the only
   * honest way round: an id in a tool call is model output, and a workspace's workflow names are
   * unique, so the name a designer chose *is* the reference it meant to make.
   */
  const existing = (await deps.workflows.listWorkflows(input.workspaceId, MAX_WORKFLOWS_LISTED))
    .find((workflow) => workflow.name === name)
  const digest = workflowDigest(verdict.graph)

  if (existing !== undefined) {
    const current = await deps.workflows.latestVersion(input.workspaceId, existing.id)
    if (current?.digest === digest) {
      return {
        ok: false,
        error:
          `That is the shape "${name}" already has, node for node. A version identical to the ` +
          'one in use would cost a person a decision and change nothing — propose a different ' +
          'shape, or say that the harness already does the job.',
      }
    }
  }

  const proposal = await deps.workflows.proposeDesign({
    workspaceId: input.workspaceId,
    workflowId: existing?.id ?? null,
    name,
    description,
    rationale,
    graph: verdict.graph,
    digest,
    proposedByRunId: run.id,
    personaName: run.persona.name,
  })

  return {
    ok: true,
    outcome:
      (existing === undefined
        ? `Proposed as a new harness called "${name}".`
        : `Proposed as the next version of "${name}".`) +
      ' Nothing runs until a person approves it. What they will read beside the drawing:\n' +
      `${summarizeWorkflowShape(proposal.graph)}\n` +
      describeWorkflowVersion(proposal.graph, personas),
  }
}

/** Every proposal, newest first, each with the ceiling a person reads before approving it. */
export const listWorkflowDesigns = async (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId; status?: WorkflowDesignStatus },
): Promise<{ design: WorkflowDesignRecord; shape: string; detail: string }[]> => {
  const designs = await deps.workflows.listDesigns({
    workspaceId: input.workspaceId,
    ...(input.status === undefined ? {} : { status: input.status }),
    limit: MAX_DESIGNS_LISTED,
  })
  const personas = await deps.personas.listByWorkspace(input.workspaceId)
  return designs.map((design) => ({
    design,
    shape: summarizeWorkflowShape(design.graph),
    detail: describeWorkflowVersion(design.graph, personas),
  }))
}

/**
 * Approves a proposal, which is what writes the version.
 *
 * Re-validated at approval rather than trusted from the row, for the reason an execution
 * re-validates at start: the shape was checked when it was drawn, and a persona it names can
 * have been deleted since. A proposal that named a persona who left is refused here with that
 * sentence rather than becoming a version whose fourth step nobody can deal.
 *
 * Settled *before* the version is written, and that order is deliberate. Two people clicking
 * approve at once would otherwise write two versions of one proposal; claiming first means the
 * second click is told the proposal is already decided and writes nothing. The residual risk is
 * the mirror of `claimStep`'s: a failure between the two leaves a proposal marked approved whose
 * version was never written, which is visible — the harness's version number did not move.
 */
export const approveWorkflowDesign = async (
  deps: AgentDeps,
  input: { workspaceId: WorkspaceId; actor: Actor; designId: WorkflowDesignId },
): Promise<{ design: WorkflowDesignRecord; version: WorkflowVersionRecord; detail: string }> => {
  requireHuman(input.actor, 'approve a harness')
  const design = await deps.workflows.findDesign(input.workspaceId, input.designId)
  if (!design) throw new NotFoundError('Workflow design')
  if (design.status !== 'proposed') {
    throw new ValidationError(`This proposal was already ${design.status}.`)
  }

  const personas = await deps.personas.listByWorkspace(input.workspaceId)
  const verdict = validateWorkflowGraph(design.graph, personas)
  if (!verdict.ok) {
    throw new ValidationError(
      `This shape is no longer runnable in this workspace: ${verdict.reason} Decline it and ask again.`,
    )
  }

  const claimed = await deps.workflows.decideDesign(input.workspaceId, input.designId, {
    status: 'approved',
    decidedByUserId: actorUserId(input.actor),
    note: null,
  })
  if (!claimed) throw new ValidationError('This proposal was decided by somebody else just now.')

  const digest = workflowDigest(verdict.graph)
  if (design.workflowId !== null) {
    const version = await deps.workflows.addVersion({
      workspaceId: input.workspaceId,
      workflowId: design.workflowId,
      createdByUserId: actorUserId(input.actor),
      graph: verdict.graph,
      digest,
    })
    if (!version) throw new NotFoundError('Workflow')
    return {
      design: claimed,
      version,
      detail: `Drawn as version ${version.version} of "${design.name}".`,
    }
  }

  /**
   * A name taken since the proposal was made is refused rather than merged into whatever now
   * holds it: two people can arrive at "code review" from opposite directions, and quietly
   * versioning somebody else's harness with this graph would be the one outcome nobody asked
   * for.
   */
  const taken = (await deps.workflows.listWorkflows(input.workspaceId, MAX_WORKFLOWS_LISTED)).some(
    (workflow) => workflow.name === design.name,
  )
  if (taken) {
    throw new ValidationError(
      `A harness called "${design.name}" was drawn while this proposal was waiting. Approving ` +
        'this one would silently become a version of that one — decline it and ask for a redraw ' +
        'against what is there now.',
    )
  }

  const created = await deps.workflows.create({
    workspaceId: input.workspaceId,
    name: design.name,
    description: design.description,
    createdByUserId: actorUserId(input.actor),
    graph: verdict.graph,
    digest,
  })
  return {
    design: claimed,
    version: created.version,
    detail: `Drawn as version 1 of "${design.name}".`,
  }
}

/**
 * Declines one, with the reason.
 *
 * The reason is not decoration: a declined proposal with what was wrong with it is the record a
 * later designer can be shown, which is the difference between asking again and asking again
 * for the same thing.
 */
export const declineWorkflowDesign = async (
  deps: AgentDeps,
  input: {
    workspaceId: WorkspaceId
    actor: Actor
    designId: WorkflowDesignId
    note: string | null
  },
): Promise<WorkflowDesignRecord> => {
  requireHuman(input.actor, 'decline a harness')
  const decided = await deps.workflows.decideDesign(input.workspaceId, input.designId, {
    status: 'declined',
    decidedByUserId: actorUserId(input.actor),
    note: input.note === null ? null : input.note.trim().slice(0, MAX_DESIGN_RATIONALE_CHARS),
  })
  if (!decided) {
    const existing = await deps.workflows.findDesign(input.workspaceId, input.designId)
    if (!existing) throw new NotFoundError('Workflow design')
    throw new ValidationError(`This proposal was already ${existing.status}.`)
  }
  return decided
}
