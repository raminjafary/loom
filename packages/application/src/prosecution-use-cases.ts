import {
  agentRunActor,
  asAgentRunId,
  summariseProsecution,
  type AgentRun,
  type AgentRunId,
  type ProsecutionObservation,
  type WorkspaceId,
} from '@loom/domain'
import type { AgentDeps } from './agent-use-cases.js'

/**
 * The prosecutor pass, as a platform action.
 *
 * Two entry points and both of them are deliberately powerless. `startProsecutor` is
 * best-effort in every direction — it can never fail the run it is about, because the run is
 * already over and its branch is intact. `recordProsecution` writes a row nothing on the
 * merge path reads.
 *
 * See `prosecution.ts` in the domain for why "evidence, never a verdict" is the whole design
 * rather than a caveat, and `tools/architecture.test.ts` for the check that keeps it true.
 */

const PROSECUTOR_PERSONA_NAME = 'prosecutor'

/**
 * The task the prosecutor is given.
 *
 * It names the branch and the base rather than pasting a diff, because the prosecutor has the
 * clone: a diff in a prompt is a snapshot that stops being true the moment anything moves, and
 * it costs context that the run can read for itself at the exact moment it needs it. What the
 * task does carry is the one thing it cannot derive — what the repository's own checks already
 * said, so it does not spend its run re-discovering a failure a person has already been told
 * about.
 */
export const renderProsecutorTask = (input: {
  readonly branchName: string
  readonly baseBranch: string
  readonly task: string | null
  readonly verdict: string | null
}): string =>
  [
    `Another agent has changed this repository on the branch \`${input.branchName}\`, off ` +
      `\`${input.baseBranch}\`. Your clone is that branch.`,
    input.task === null
      ? 'What it was asked to do was not recorded.'
      : `What it was asked to do: ${input.task}`,
    /**
     * The instruction not to re-run the repository's checks is unconditional, and that is a
     * correction rather than a simplification: a prosecutor is started when the run ends,
     * which is when the verification is *enqueued*, so the verdict is usually not known yet.
     * Making the instruction conditional on it meant the common case got no instruction at
     * all — and re-running the standing suite is the one thing this pass must not spend its
     * run on.
     */
    input.verdict === null
      ? "The repository's own checks are running against this branch or have already run, and " +
        'their verdict is not yours to produce. Do not run them.'
      : `The repository's own checks said: ${input.verdict}. That verdict stands whatever you ` +
        'find. Do not run them again.',
    `Read the diff first — \`git diff ${input.baseBranch}...HEAD\` — and write the tests that ` +
      'diff makes worth writing. Run them. Then call report_prosecution once with what you ran ' +
      'and what you saw, and stop.',
  ].join('\n\n')

/**
 * Starts a prosecutor over a finished run's branch.
 *
 * Called beside the verification enqueue and **never awaited into the run's terminal
 * transition**, for the reason that one is not: a run whose completion waited on a second run
 * would report finishing minutes after it finished.
 *
 * Every reason to do nothing is a silent one, and that is the correct trade for a pass that
 * holds no authority: no prosecutor persona in the workspace, no branch, a workspace at its
 * concurrency limit. A missing prosecution is a piece of evidence nobody gathered, not a run
 * that went wrong — and the one thing it must never do is make a finished run look failed.
 */
export const startProsecutor = async (
  deps: AgentDeps,
  run: AgentRun,
  startAgentRun: (input: {
    workspaceId: WorkspaceId
    actor: ReturnType<typeof agentRunActor>
    threadId: AgentRun['threadId']
    repositoryId: AgentRun['repositoryId']
    personaId: string
    parentRunId: AgentRunId
    relation: 'prosecute'
    task: string
    prosecute: true
  }) => Promise<{ id: string }>,
): Promise<void> => {
  try {
    if (!run.branchName || !run.clonePath) return
    /**
     * A prosecutor does not prosecute a prosecutor, and nor does it prosecute the platform's
     * own second opinions. Without this the first prosecution would start a second run whose
     * branch would start a third — a loop whose only bound is the workspace's concurrency
     * limit, discovered when the bill arrives.
     */
    if (run.relation === 'prosecute' || run.relation === 'verify' || run.relation === 'screen') {
      return
    }

    const personas = await deps.personas.listByWorkspace(run.workspaceId)
    const prosecutor = personas.find((entry) => entry.name === PROSECUTOR_PERSONA_NAME)
    if (!prosecutor) return

    const repository = await deps.repositories.findById(run.workspaceId, run.repositoryId)
    if (!repository) return

    const [verification] = await deps.runVerifications.listByRuns(run.workspaceId, [run.id])
    const verdict =
      verification && verification.status !== 'pending'
        ? `${verification.status}${
            verification.checks.length > 0
              ? ` (${verification.checks.map((check) => `${check.name}: ${check.status}`).join(', ')})`
              : ''
          }`
        : null

    const started = await startAgentRun({
      workspaceId: run.workspaceId,
      // As the run under prosecution: `startAgentRun` only lets a run spawn children of
      // itself, and it is also what puts the prosecutor under the right branch of the tree.
      actor: agentRunActor(run.id),
      threadId: run.threadId,
      repositoryId: run.repositoryId,
      personaId: prosecutor.id,
      parentRunId: run.id,
      relation: 'prosecute',
      prosecute: true,
      task: renderProsecutorTask({
        branchName: run.branchName,
        baseBranch: repository.defaultBranch,
        task: run.task ?? null,
        verdict,
      }),
    })

    await deps.prosecutions.open({
      workspaceId: run.workspaceId,
      agentRunId: run.id,
      prosecutorRunId: asAgentRunId(started.id),
    })
  } catch {
    /**
     * Swallowed, like the verifier's own start. The run is over and its branch is intact; a
     * prosecutor that could not start is evidence nobody gathered.
     */
  }
}

export type RecordProsecutionResult =
  | { readonly ok: true; readonly outcome: string }
  | { readonly ok: false; readonly error: string }

/**
 * Records what a prosecutor reported.
 *
 * The frame arrives keyed by the *prosecutor's* run id, and the row is found from that rather
 * than from anything the frame asserts — the same rule every other channel here follows: a
 * submission that could name the run it is about is a submission that could name someone
 * else's.
 *
 * A refusal travels as a refusal (`ok: false`), which is what the tool inside the container
 * turns into a tool result the session can read and act on. That is the shape the design
 * channel had to be corrected to, after a refused design was reported to everything except
 * the model as a success.
 */
export const recordProsecution = async (
  deps: AgentDeps,
  input: {
    workspaceId: WorkspaceId
    agentRunId: AgentRunId
    observations: readonly ProsecutionObservation[]
    inconclusive: string | null
  },
): Promise<RecordProsecutionResult> => {
  const prosecution = await deps.prosecutions.findByProsecutorRun(
    input.workspaceId,
    input.agentRunId,
  )
  if (!prosecution) {
    return {
      ok: false,
      error:
        'this run is not prosecuting anything, so there is nothing to report against. A ' +
        'prosecution is opened by the platform when it starts a prosecutor.',
    }
  }

  const reported = await deps.prosecutions.report(input.workspaceId, prosecution.id, {
    status: input.inconclusive === null ? 'reported' : 'inconclusive',
    observations: input.observations,
    reason: input.inconclusive,
  })
  if (!reported) {
    return {
      ok: false,
      error:
        'this prosecution has already been reported, and a second report would overwrite ' +
        'evidence a person may already have read.',
    }
  }

  return {
    ok: true,
    outcome:
      `${summariseProsecution(reported)} Recorded as evidence beside the branch. It does not ` +
      "affect that branch's verdict, and nothing is blocked by it.",
  }
}
