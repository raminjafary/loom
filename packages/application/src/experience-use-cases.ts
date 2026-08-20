import {
  MAX_EXPERIENCE_CONTEXT_CHARS,
  MAX_LESSONS_IN_CONTEXT,
  MAX_LESSONS_PER_RUN,
  NotFoundError,
  ValidationError,
  maySelfModify,
  parseDistillation,
  renderExperienceForPrompt,
  selectExperienceForContext,
  selectStaleLessonIds,
  type AgentPersonaId,
  type AgentRunId,
  type ExperienceLesson,
  type PersonaLessonId,
  type RepositoryId,
  type WorkspaceId,
} from '@loom/domain'
import type {
  AgentRunRepositoryPort,
  ExperienceRepositoryPort,
  PersonaRepositoryPort,
  RepositoryRepositoryPort,
} from './agent-ports.js'

/**
 * Distilled experience — the write, the read, and the two ways a lesson stops being shown.
 *
 * Its own file for the reason mastery has one: these are the only callers that may write
 * into a persona's durable memory, and a small file is what makes "one poisoned run could
 * write a lesson every future run reads" auditable rather than merely worried about.
 * `recordExperience` is the single function here that accepts model-authored content.
 *
 * **What gates the write is the envelope, and the reason is that this is tier 5.**
 * Continuity mode lists five self-modification tiers and durable memory is the fifth; the
 * envelope is named there as the prerequisite for all of them, and `maySelfModify`'s rule
 * is that its absence is a refusal rather than the absence of one. So a persona a human has
 * never let rewrite itself cannot write memory either — which is the honest reading, because
 * a lesson changes what every future run of this persona is told just as a prompt edit does.
 * It changes it inside a fence and only for one repository, which is why it needs no ceiling
 * of its own beyond the ones the domain sets for everybody.
 *
 * The Runner refuses it too, by never offering the tool. The duplication is the same one
 * tier 1 documents: the Runner decides what is offered, the server decides what is allowed.
 */

export interface ExperienceDeps {
  readonly experience: ExperienceRepositoryPort
  readonly personas: PersonaRepositoryPort
  readonly agentRuns: AgentRunRepositoryPort
  readonly repositories: RepositoryRepositoryPort
}

export type ExperienceWriteResult =
  | { readonly ok: true; readonly written: number; readonly superseded: number; readonly remaining: number }
  | { readonly ok: false; readonly reason: string }

/**
 * A run recording what it learned about the repository it is working in.
 *
 * Everything refusable is refused with a sentence the model is shown, and nothing here
 * throws for a refusal: a run told "you are at your quota" can act on that, and a run whose
 * write vanished learns that it has a memory it does not have.
 *
 * The scope is taken from the **run**, never from the call. A run knows which repository it
 * is against and which persona it is; letting the tool name either would make "per persona
 * and per repository" a thing a model asserts rather than a thing the platform knows, and
 * the first lesson written into somebody else's scope is the whole of §5a's warning arriving.
 */
export const recordExperience = async (
  deps: ExperienceDeps,
  input: {
    workspaceId: WorkspaceId
    agentRunId: AgentRunId
    /** The tool's payload, unvalidated — `parseDistillation` is the one validator. */
    distillation: unknown
  },
): Promise<ExperienceWriteResult> => {
  const run = await deps.agentRuns.findById(input.workspaceId, input.agentRunId)
  if (!run) throw new NotFoundError('AgentRun')

  /**
   * By name, from the run's own snapshot — the resolution tier 1's write side uses, and the
   * same trade: a persona renamed or deleted since this run started resolves to nothing, and
   * the write is refused rather than landing on somebody else's memory.
   */
  const personas = await deps.personas.listByWorkspace(input.workspaceId)
  const persona = personas.find((entry) => entry.name === run.persona.name)
  if (!persona) {
    return {
      ok: false,
      reason:
        `There is no persona called "${run.persona.name}" in this workspace any more, so there ` +
        'is nothing to remember it. Carry on with your task.',
    }
  }
  if (!maySelfModify(persona.envelope ?? null)) {
    return {
      ok: false,
      reason:
        `${persona.name} has no envelope, so it may not keep durable memory. A human sets one ` +
        'on the persona; nothing an agent does can.',
    }
  }

  const [live, alreadyWrittenByRun] = await Promise.all([
    deps.experience.listForScope(input.workspaceId, persona.id, run.repositoryId),
    deps.experience.countWrittenByRun(input.workspaceId, input.agentRunId),
  ])

  const verdict = parseDistillation(input.distillation, {
    alreadyWrittenByRun,
    liveCount: live.length,
    liveKeys: live.map((lesson) => lesson.key),
  })
  if (!verdict.ok) return { ok: false, reason: verdict.reason }

  const written = await deps.experience.record({
    workspaceId: input.workspaceId,
    personaId: persona.id,
    repositoryId: run.repositoryId,
    authoredByRunId: input.agentRunId,
    lessons: verdict.lessons,
  })

  return {
    ok: true,
    written: written.written,
    superseded: written.superseded,
    /**
     * Returned so the model is told what it has left rather than discovering it by being
     * refused. A quota a caller can only find by hitting it is a quota that produces one
     * wasted tool call per run, every run.
     */
    remaining: Math.max(0, MAX_LESSONS_PER_RUN - (alreadyWrittenByRun + written.written)),
  }
}

/**
 * What a run is handed from its persona's memory of this repository.
 *
 * The map's `buildMapContext` and this are deliberately two functions rather than one
 * assembler, because they answer to different rules: a map is bounded by node kinds and
 * carries a trial arm, and memory is bounded by characters and has no arm. What they share
 * is the shape of the failure — a run shown a silently truncated set believes it has the
 * whole picture — and both of them report what they dropped.
 *
 * Citations are written for what was actually rendered, best-effort. A run whose citation
 * row failed is worse recorded, not broken, and failing a start over a bookkeeping row would
 * tie throughput to the least important write in the system.
 */
export const buildExperienceContext = async (
  deps: ExperienceDeps,
  input: {
    workspaceId: WorkspaceId
    personaId: AgentPersonaId
    repositoryId: RepositoryId | null
    agentRunId: AgentRunId
  },
): Promise<string> => {
  if (input.repositoryId === null) return ''

  const lessons = await deps.experience.listForScope(
    input.workspaceId,
    input.personaId,
    input.repositoryId,
  )
  if (lessons.length === 0) return ''

  const outcomes = await deps.experience.tallyLessonOutcomes(
    input.workspaceId,
    input.personaId,
    input.repositoryId,
  )
  const selected = selectExperienceForContext(
    lessons,
    outcomes,
    MAX_LESSONS_IN_CONTEXT,
    MAX_EXPERIENCE_CONTEXT_CHARS,
  )
  if (selected.lessons.length === 0) return ''

  try {
    await deps.experience.recordCitations({
      workspaceId: input.workspaceId,
      agentRunId: input.agentRunId,
      lessonIds: selected.lessons.map((lesson) => lesson.id),
    })
  } catch {
    // Deliberately swallowed — see above.
  }

  return renderExperienceForPrompt(selected.lessons, selected.elided)
}

/**
 * The merge queue retiring what it made wrong.
 *
 * Hooked where map invalidation is hooked and for the same reason: this is the one place
 * the platform learns that a file changed, and a memory that could only be corrected by
 * hand would be a memory that is wrong for as long as nobody looks at it.
 *
 * Across every persona holding a lesson about this repository, not only the one that merged.
 * A change made by one agent is a change under all of them, and scoping this to the author
 * would leave the other experts on that subsystem the only ones still being told the old
 * thing.
 */
export const invalidateExperienceForMerge = async (
  deps: ExperienceDeps,
  input: {
    workspaceId: WorkspaceId
    repositoryId: RepositoryId
    changedPaths: readonly string[]
    revision: string
  },
): Promise<{ invalidated: number }> => {
  if (input.changedPaths.length === 0) return { invalidated: 0 }

  const lessons = await deps.experience.listForRepository(input.workspaceId, input.repositoryId)
  const stale = selectStaleLessonIds(lessons, input.changedPaths)
  if (stale.length === 0) return { invalidated: 0 }

  const invalidated = await deps.experience.invalidate(
    input.workspaceId,
    stale as PersonaLessonId[],
    `changed at ${input.revision}`,
  )
  return { invalidated }
}

export interface LessonListing {
  readonly id: PersonaLessonId
  readonly repositoryId: RepositoryId
  /**
   * Resolved here rather than left to the client, because a lesson's scope is the thing a
   * reader most needs and a uuid does not say it. The same reason a persona's byline is
   * resolved server-side: a label that resolves to an id says less than none.
   */
  readonly repositoryName: string
  readonly authoredByRunId: AgentRunId | null
  readonly key: string
  readonly kind: ExperienceLesson['kind']
  readonly title: string
  readonly body: string
  readonly paths: string[]
  readonly createdAt: Date
  readonly invalidatedAt: Date | null
  readonly invalidatedReason: string | null
  /** What became of the runs that read it — the ranking, shown rather than only applied. */
  readonly outcomes: { readonly decided: number; readonly merged: number; readonly discarded: number }
}

/**
 * Everything a persona remembers, for a human to read.
 *
 * Invalidated lessons are included and marked, which is the opposite of what a prompt gets
 * and is the point of storing them: "this was true until commit abc" is often the most
 * useful sentence about a module, and a panel that hid it would leave a curation pass and an
 * operator looking at different memories.
 */
export const listPersonaExperience = async (
  deps: ExperienceDeps,
  input: { workspaceId: WorkspaceId; personaId: AgentPersonaId },
): Promise<LessonListing[]> => {
  const lessons = await deps.experience.listForPersona(input.workspaceId, input.personaId, {
    includeInvalidated: true,
  })
  if (lessons.length === 0) return []

  /**
   * One tally per repository the persona holds lessons about, not one per lesson. A persona
   * with forty lessons about one repository is one query, which is the ordinary case.
   */
  const scopes = [...new Set(lessons.map((lesson) => lesson.repositoryId))]
  const tallies: Record<string, Record<string, { decided: number; merged: number; discarded: number }>> = {}
  for (const repositoryId of scopes) {
    tallies[repositoryId] = await deps.experience.tallyLessonOutcomes(
      input.workspaceId,
      input.personaId,
      repositoryId as RepositoryId,
    )
  }

  const repositories = await deps.repositories.listByWorkspace(input.workspaceId)
  const nameOf = (repositoryId: RepositoryId): string =>
    repositories.find((repository) => repository.id === repositoryId)?.displayName ?? 'a repository that is gone'

  return lessons.map((lesson) => ({
    id: lesson.id,
    repositoryId: lesson.repositoryId,
    repositoryName: nameOf(lesson.repositoryId),
    authoredByRunId: lesson.authoredByRunId,
    key: lesson.key,
    kind: lesson.kind,
    title: lesson.title,
    body: lesson.body,
    paths: [...lesson.paths],
    createdAt: lesson.createdAt,
    invalidatedAt: lesson.invalidatedAt,
    invalidatedReason: lesson.invalidatedReason,
    outcomes: tallies[lesson.repositoryId]?.[lesson.id] ?? { decided: 0, merged: 0, discarded: 0 },
  }))
}

/**
 * A human retiring a lesson.
 *
 * The only deletion-shaped act in this feature, and it is still a write. Domain expertise
 * puts promotion of a distilled lesson into trusted knowledge in human hands; retirement is
 * the same act pointed the other way, and there is no agent-facing path to it — an agent
 * that could retire its own memory could retire the lesson that says what it did last time.
 */
export const retireLesson = async (
  deps: ExperienceDeps,
  input: { workspaceId: WorkspaceId; lessonId: PersonaLessonId; reason: string },
): Promise<{ invalidated: number }> => {
  const reason = input.reason.trim()
  if (reason.length === 0) {
    throw new ValidationError('A retired lesson needs a reason — it is the only record of why.')
  }
  const invalidated = await deps.experience.invalidate(
    input.workspaceId,
    [input.lessonId],
    `retired by a human: ${reason}`,
  )
  if (invalidated === 0) throw new NotFoundError('PersonaLesson')
  return { invalidated }
}
