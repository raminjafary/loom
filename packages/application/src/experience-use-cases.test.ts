import {
  MAX_LESSONS_PER_RUN,
  UNTRUSTED_EXPERIENCE_OPEN,
  asAgentPersonaId,
  asAgentRunId,
  asPersonaLessonId,
  asRepositoryId,
  asWorkspaceId,
  type AgentPersonaId,
  type AgentRunId,
  type Envelope,
  type ExperienceLesson,
  type PersonaLessonId,
  type RepositoryId,
} from '@loom/domain'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ExperienceRepositoryPort } from './agent-ports.js'
import {
  buildExperienceContext,
  invalidateExperienceForMerge,
  listPersonaExperience,
  recordExperience,
  retireLesson,
  type ExperienceDeps,
} from './experience-use-cases.js'

const workspaceId = asWorkspaceId('w1')
const personaId = asAgentPersonaId('p1')
const repositoryId = asRepositoryId('r1')
const otherRepositoryId = asRepositoryId('r2')
const runId = asAgentRunId('run1')

const envelope: Envelope = {
  tools: ['Read'],
  model: null,
  budgetCapUsd: null,
  capabilities: [],
  subagentDepth: null,
  approvalMode: null,
}

/**
 * An in-memory `ExperienceRepositoryPort`, reproducing the one behaviour the real one is
 * careful about: writing a key that is already live supersedes rather than updates, so the
 * old row is still there with a stamp on it.
 */
class FakeExperience implements ExperienceRepositoryPort {
  lessons: ExperienceLesson[] = []
  outcomes: Record<string, { decided: number; merged: number; discarded: number; failed: number }> = {}
  citations: { lessonId: string; agentRunId: string }[] = []
  private seq = 0

  async record(input: Parameters<ExperienceRepositoryPort['record']>[0]) {
    let superseded = 0
    for (const lesson of input.lessons) {
      const live = this.lessons.find(
        (entry) =>
          entry.personaId === input.personaId &&
          entry.repositoryId === input.repositoryId &&
          entry.key === lesson.key &&
          entry.invalidatedAt === null,
      )
      if (live) {
        superseded += 1
        this.lessons = this.lessons.map((entry) =>
          entry.id === live.id
            ? { ...entry, invalidatedAt: new Date('2026-08-02T00:00:00Z'), invalidatedReason: 'superseded by a later run' }
            : entry,
        )
      }
      this.seq += 1
      this.lessons.push({
        id: asPersonaLessonId(`lesson-${this.seq}`),
        workspaceId: input.workspaceId,
        personaId: input.personaId,
        repositoryId: input.repositoryId,
        authoredByRunId: input.authoredByRunId,
        key: lesson.key,
        kind: lesson.kind,
        title: lesson.title,
        body: lesson.body,
        paths: lesson.paths,
        createdAt: new Date(`2026-08-0${Math.min(9, this.seq)}T00:00:00Z`),
        invalidatedAt: null,
        invalidatedReason: null,
      })
    }
    return { written: input.lessons.length, superseded }
  }

  async listForScope(
    _w: typeof workspaceId,
    persona: AgentPersonaId,
    repository: RepositoryId,
    options?: { includeInvalidated?: boolean },
  ) {
    return this.lessons.filter(
      (lesson) =>
        lesson.personaId === persona &&
        lesson.repositoryId === repository &&
        (options?.includeInvalidated === true || lesson.invalidatedAt === null),
    )
  }

  async listForRepository(_w: typeof workspaceId, repository: RepositoryId) {
    return this.lessons.filter(
      (lesson) => lesson.repositoryId === repository && lesson.invalidatedAt === null,
    )
  }

  async listForPersona(
    _w: typeof workspaceId,
    persona: AgentPersonaId,
    options?: { includeInvalidated?: boolean },
  ) {
    return this.lessons.filter(
      (lesson) =>
        lesson.personaId === persona &&
        (options?.includeInvalidated === true || lesson.invalidatedAt === null),
    )
  }

  async countWrittenByRun(_w: typeof workspaceId, agentRunId: AgentRunId) {
    return this.lessons.filter((lesson) => lesson.authoredByRunId === agentRunId).length
  }

  async recordCitations(input: { agentRunId: AgentRunId; lessonIds: readonly PersonaLessonId[] }) {
    for (const lessonId of input.lessonIds) {
      this.citations.push({ lessonId, agentRunId: input.agentRunId })
    }
  }

  async tallyLessonOutcomes() {
    return this.outcomes
  }

  async invalidate(_w: typeof workspaceId, lessonIds: readonly PersonaLessonId[], reason: string) {
    let count = 0
    this.lessons = this.lessons.map((lesson) => {
      if (!lessonIds.includes(lesson.id) || lesson.invalidatedAt !== null) return lesson
      count += 1
      return { ...lesson, invalidatedAt: new Date('2026-08-05T00:00:00Z'), invalidatedReason: reason }
    })
    return count
  }
}

const deps = (
  experience: FakeExperience,
  over: { envelope?: Envelope | null; personaName?: string } = {},
): ExperienceDeps =>
  ({
    experience,
    personas: {
      listByWorkspace: async () => [
        {
          id: personaId,
          name: over.personaName ?? 'Cartographer',
          envelope: over.envelope === undefined ? envelope : over.envelope,
        },
      ],
    },
    agentRuns: {
      findById: async () => ({
        id: runId,
        workspaceId,
        repositoryId,
        persona: { name: 'Cartographer' },
      }),
    },
    repositories: {
      listByWorkspace: async () => [
        { id: repositoryId, displayName: 'loom' },
        { id: otherRepositoryId, displayName: 'other' },
      ],
    },
  }) as unknown as ExperienceDeps

const distillation = (key: string, over: Record<string, unknown> = {}) => ({
  lessons: [
    {
      key,
      kind: 'convention',
      title: `About ${key}`,
      body: 'The reason it holds.',
      ...over,
    },
  ],
})

describe('recordExperience — who may write, and what the model is told when it may not', () => {
  let store: FakeExperience
  beforeEach(() => {
    store = new FakeExperience()
  })

  it('records a lesson for a persona whose human granted an envelope', async () => {
    const result = await recordExperience(deps(store), {
      workspaceId,
      agentRunId: runId,
      distillation: distillation('seed-first'),
    })
    expect(result).toEqual({ ok: true, written: 1, superseded: 0, remaining: MAX_LESSONS_PER_RUN - 1 })
    expect(store.lessons).toHaveLength(1)
    expect(store.lessons[0]?.repositoryId).toBe(repositoryId)
  })

  it('refuses a persona with no envelope, and says who can change that', async () => {
    const result = await recordExperience(deps(store, { envelope: null }), {
      workspaceId,
      agentRunId: runId,
      distillation: distillation('seed-first'),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('no envelope')
    expect(store.lessons).toEqual([])
  })

  it('refuses when the persona the run is has since been renamed away', async () => {
    const result = await recordExperience(deps(store, { personaName: 'Someone Else' }), {
      workspaceId,
      agentRunId: runId,
      distillation: distillation('seed-first'),
    })
    expect(result.ok).toBe(false)
    expect(store.lessons).toEqual([])
  })

  it('supersedes rather than duplicates when a run reuses a key, and keeps the old row', async () => {
    await recordExperience(deps(store), {
      workspaceId,
      agentRunId: runId,
      distillation: distillation('seed-first'),
    })
    const second = await recordExperience(deps(store), {
      workspaceId,
      agentRunId: runId,
      distillation: distillation('seed-first', { kind: 'correction', title: 'Not so' }),
    })
    expect(second.ok === true && second.superseded).toBe(1)
    expect(store.lessons).toHaveLength(2)
    expect(store.lessons.filter((lesson) => lesson.invalidatedAt === null)).toHaveLength(1)
  })

  it('holds one run to its quota across separate calls', async () => {
    for (let index = 0; index < MAX_LESSONS_PER_RUN; index += 1) {
      const result = await recordExperience(deps(store), {
        workspaceId,
        agentRunId: runId,
        distillation: distillation(`lesson-${index}`),
      })
      expect(result.ok).toBe(true)
    }
    const overrun = await recordExperience(deps(store), {
      workspaceId,
      agentRunId: runId,
      distillation: distillation('one-too-many'),
    })
    expect(overrun.ok).toBe(false)
    expect(overrun.ok === false && overrun.reason).toContain('already recorded')
  })
})

describe('buildExperienceContext — what a run is handed, and what is written down about it', () => {
  it('renders the persona’s memory of this repository, fenced, and cites what it showed', async () => {
    const store = new FakeExperience()
    await recordExperience(deps(store), {
      workspaceId,
      agentRunId: runId,
      distillation: distillation('seed-first'),
    })

    const otherRun = asAgentRunId('run2')
    const context = await buildExperienceContext(deps(store), {
      workspaceId,
      personaId,
      repositoryId,
      agentRunId: otherRun,
    })

    expect(context).toContain(UNTRUSTED_EXPERIENCE_OPEN)
    expect(context).toContain('About seed-first')
    expect(store.citations).toEqual([{ lessonId: 'lesson-1', agentRunId: otherRun }])
  })

  it('hands over nothing — and cites nothing — for a repository this persona has never worked in', async () => {
    const store = new FakeExperience()
    await recordExperience(deps(store), {
      workspaceId,
      agentRunId: runId,
      distillation: distillation('seed-first'),
    })

    const context = await buildExperienceContext(deps(store), {
      workspaceId,
      personaId,
      repositoryId: otherRepositoryId,
      agentRunId: asAgentRunId('run3'),
    })
    expect(context).toBe('')
    expect(store.citations).toEqual([])
  })

  it('never shows a retired lesson', async () => {
    const store = new FakeExperience()
    await recordExperience(deps(store), {
      workspaceId,
      agentRunId: runId,
      distillation: distillation('seed-first'),
    })
    await store.invalidate(workspaceId, [asPersonaLessonId('lesson-1')], 'retired')

    expect(
      await buildExperienceContext(deps(store), {
        workspaceId,
        personaId,
        repositoryId,
        agentRunId: asAgentRunId('run4'),
      }),
    ).toBe('')
  })
})

describe('invalidateExperienceForMerge — the merge queue retires what it made wrong', () => {
  it('retires every persona’s lesson about the changed paths, as a write', async () => {
    const store = new FakeExperience()
    await recordExperience(deps(store), {
      workspaceId,
      agentRunId: runId,
      distillation: {
        lessons: [
          { key: 'about-runner', kind: 'hazard', title: 'Careful', body: 'It bites.', paths: ['apps/runner'] },
        ],
      },
    })

    const result = await invalidateExperienceForMerge(deps(store), {
      workspaceId,
      repositoryId,
      changedPaths: ['apps/runner/src/sandbox.ts'],
      revision: 'abc1234',
    })

    expect(result.invalidated).toBe(1)
    expect(store.lessons[0]?.invalidatedReason).toBe('changed at abc1234')
    expect(store.lessons).toHaveLength(1)
  })

  it('leaves a lesson about untouched paths alone', async () => {
    const store = new FakeExperience()
    await recordExperience(deps(store), {
      workspaceId,
      agentRunId: runId,
      distillation: {
        lessons: [
          { key: 'about-web', kind: 'hazard', title: 'Careful', body: 'It bites.', paths: ['apps/web'] },
        ],
      },
    })
    const result = await invalidateExperienceForMerge(deps(store), {
      workspaceId,
      repositoryId,
      changedPaths: ['apps/runner/src/sandbox.ts'],
      revision: 'abc1234',
    })
    expect(result.invalidated).toBe(0)
  })
})

describe('the human-facing half', () => {
  it('lists retired lessons too, named by the repository they belong to', async () => {
    const store = new FakeExperience()
    await recordExperience(deps(store), {
      workspaceId,
      agentRunId: runId,
      distillation: distillation('seed-first'),
    })
    await store.invalidate(workspaceId, [asPersonaLessonId('lesson-1')], 'retired by a human: wrong')

    const listing = await listPersonaExperience(deps(store), { workspaceId, personaId })
    expect(listing).toHaveLength(1)
    expect(listing[0]?.repositoryName).toBe('loom')
    expect(listing[0]?.invalidatedReason).toBe('retired by a human: wrong')
  })

  it('refuses to retire a lesson with no reason — the reason is the only record of why', async () => {
    const store = new FakeExperience()
    await expect(
      retireLesson(deps(store), {
        workspaceId,
        lessonId: asPersonaLessonId('lesson-1'),
        reason: '   ',
      }),
    ).rejects.toThrow()
  })
})
