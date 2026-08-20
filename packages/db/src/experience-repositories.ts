import {
  asAgentPersonaId,
  asAgentRunId,
  asPersonaLessonId,
  asRepositoryId,
  asWorkspaceId,
  type ExperienceLesson,
  type LessonKind,
} from '@loom/domain'
import type { ExperienceRepositoryPort } from '@loom/application'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Database } from './client.js'
import { agentRun, personaLesson, personaLessonCitation } from './schema.js'

type LessonRow = typeof personaLesson.$inferSelect

const toLesson = (row: LessonRow): ExperienceLesson => ({
  id: asPersonaLessonId(row.id),
  workspaceId: asWorkspaceId(row.workspaceId),
  personaId: asAgentPersonaId(row.personaId),
  repositoryId: asRepositoryId(row.repositoryId),
  authoredByRunId: row.authoredByRunId === null ? null : asAgentRunId(row.authoredByRunId),
  key: row.key,
  kind: row.kind as LessonKind,
  title: row.title,
  body: row.body,
  paths: row.paths,
  createdAt: row.createdAt,
  invalidatedAt: row.invalidatedAt,
  invalidatedReason: row.invalidatedReason,
})

/**
 * Distilled experience, stored.
 *
 * Its own file rather than another thousand lines in `agent-repositories.ts`, for the
 * reason the screens got one: the tables here are read by exactly two paths — a run's
 * opening and a human's panel — and keeping them together is what makes "which code can
 * write a persona's memory" a question with a one-file answer.
 */
export const experienceRepository = (db: Database): ExperienceRepositoryPort => ({
  async record(input) {
    const keys = input.lessons.map((lesson) => lesson.key)
    if (keys.length === 0) return { written: 0, superseded: 0 }

    return db.transaction(async (tx) => {
      /**
       * Supersede first, insert second, in one transaction.
       *
       * The order is forced by the partial unique index on the live key: inserting first
       * would collide with the row it is replacing. In one transaction because the window
       * between the two is a window in which the persona remembers nothing about that key,
       * and a concurrent run's opening would be assembled from it.
       */
      const superseded = await tx
        .update(personaLesson)
        .set({ invalidatedAt: new Date(), invalidatedReason: 'superseded by a later run' })
        .where(
          and(
            eq(personaLesson.workspaceId, input.workspaceId),
            eq(personaLesson.personaId, input.personaId),
            eq(personaLesson.repositoryId, input.repositoryId),
            inArray(personaLesson.key, keys),
            isNull(personaLesson.invalidatedAt),
          ),
        )
        .returning({ id: personaLesson.id })

      const written = await tx
        .insert(personaLesson)
        .values(
          input.lessons.map((lesson) => ({
            workspaceId: input.workspaceId,
            personaId: input.personaId,
            repositoryId: input.repositoryId,
            authoredByRunId: input.authoredByRunId,
            key: lesson.key,
            kind: lesson.kind,
            title: lesson.title,
            body: lesson.body,
            paths: lesson.paths,
          })),
        )
        .returning({ id: personaLesson.id })

      return { written: written.length, superseded: superseded.length }
    })
  },

  async listForScope(workspaceId, personaId, repositoryId, options) {
    const rows = await db
      .select()
      .from(personaLesson)
      .where(
        and(
          eq(personaLesson.workspaceId, workspaceId),
          eq(personaLesson.personaId, personaId),
          eq(personaLesson.repositoryId, repositoryId),
          options?.includeInvalidated === true ? undefined : isNull(personaLesson.invalidatedAt),
        ),
      )
      .orderBy(desc(personaLesson.createdAt))
    return rows.map(toLesson)
  },

  async listForRepository(workspaceId, repositoryId) {
    const rows = await db
      .select()
      .from(personaLesson)
      .where(
        and(
          eq(personaLesson.workspaceId, workspaceId),
          eq(personaLesson.repositoryId, repositoryId),
          isNull(personaLesson.invalidatedAt),
        ),
      )
    return rows.map(toLesson)
  },

  async listForPersona(workspaceId, personaId, options) {
    const rows = await db
      .select()
      .from(personaLesson)
      .where(
        and(
          eq(personaLesson.workspaceId, workspaceId),
          eq(personaLesson.personaId, personaId),
          options?.includeInvalidated === true ? undefined : isNull(personaLesson.invalidatedAt),
        ),
      )
      .orderBy(desc(personaLesson.createdAt))
    return rows.map(toLesson)
  },

  async countWrittenByRun(workspaceId, agentRunId) {
    /**
     * Counts superseded rows too, and that is the quota being a quota: a run that wrote
     * three lessons and replaced one of them has still written three. Counting only what is
     * live would make "supersede your own lesson" a way to buy another slot.
     */
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(personaLesson)
      .where(
        and(
          eq(personaLesson.workspaceId, workspaceId),
          eq(personaLesson.authoredByRunId, agentRunId),
        ),
      )
    return row?.count ?? 0
  },

  async recordCitations(input) {
    if (input.lessonIds.length === 0) return
    await db
      .insert(personaLessonCitation)
      .values(
        input.lessonIds.map((lessonId) => ({
          workspaceId: input.workspaceId,
          lessonId,
          agentRunId: input.agentRunId,
        })),
      )
      .onConflictDoNothing({
        target: [personaLessonCitation.lessonId, personaLessonCitation.agentRunId],
      })
  },

  async tallyLessonOutcomes(workspaceId, personaId, repositoryId) {
    /**
     * Joined against the run at read time, exactly as `tallyNodeOutcomes` is: a disposition
     * is set long after the citation was written, and copying it onto the citation row would
     * be a second write that can be missed.
     */
    const rows = await db
      .select({
        lessonId: personaLessonCitation.lessonId,
        decided: sql<number>`count(*) filter (where ${agentRun.branchDisposition} is not null or ${agentRun.status} = 'failed')::int`,
        merged: sql<number>`count(*) filter (where ${agentRun.branchDisposition} in ('merged', 'pushed'))::int`,
        discarded: sql<number>`count(*) filter (where ${agentRun.branchDisposition} = 'discarded')::int`,
        failed: sql<number>`count(*) filter (where ${agentRun.status} = 'failed')::int`,
      })
      .from(personaLessonCitation)
      .innerJoin(personaLesson, eq(personaLesson.id, personaLessonCitation.lessonId))
      .innerJoin(agentRun, eq(agentRun.id, personaLessonCitation.agentRunId))
      .where(
        and(
          eq(personaLessonCitation.workspaceId, workspaceId),
          eq(personaLesson.personaId, personaId),
          eq(personaLesson.repositoryId, repositoryId),
        ),
      )
      .groupBy(personaLessonCitation.lessonId)

    const byLesson: Record<
      string,
      { decided: number; merged: number; discarded: number; failed: number }
    > = {}
    for (const row of rows) {
      byLesson[row.lessonId] = {
        decided: row.decided,
        merged: row.merged,
        discarded: row.discarded,
        failed: row.failed,
      }
    }
    return byLesson
  },

  async invalidate(workspaceId, lessonIds, reason) {
    if (lessonIds.length === 0) return 0
    const rows = await db
      .update(personaLesson)
      .set({ invalidatedAt: new Date(), invalidatedReason: reason })
      .where(
        and(
          eq(personaLesson.workspaceId, workspaceId),
          inArray(personaLesson.id, lessonIds as unknown as string[]),
          /**
           * Never re-stamps one already retired. Moving an invalidation time forward loses
           * the answer to "when did we stop believing this", which is the question
           * bi-temporality exists to answer.
           */
          isNull(personaLesson.invalidatedAt),
        ),
      )
      .returning({ id: personaLesson.id })
    return rows.length
  },
})
