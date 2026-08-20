import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import {
  LESSON_KINDS,
  MAX_LESSONS_PER_RUN,
  MAX_LESSON_BODY_LENGTH,
  MAX_LESSON_KEY_LENGTH,
  MAX_LESSON_PATHS,
  MAX_LESSON_TITLE_LENGTH,
} from '@loom/domain'
import { z } from 'zod'

/**
 * Tier 5 of continuity mode, as a tool — a run leaves something behind for the next run
 * against this repository.
 *
 * **Offered only to a persona whose envelope permits it**, the same gate tier 1 and tier 2
 * carry and for the same reason: durable memory is the fifth self-modification tier, and an
 * absent envelope is a refusal rather than the absence of one. The server refuses the frame
 * as well, and the duplication is deliberate — the Runner decides what is offered, the
 * server decides what is allowed.
 *
 * **The description is the whole quality control, and its failure mode is a diary.** A model
 * handed somewhere durable to write will summarize its afternoon: what it did, which files
 * it touched, that the tests passed. That is the 10,134-entries-of-which-38-were-usable
 * failure by name, and no parser can spot it — a diary entry is well-formed. So the
 * description spends its length on the bar (something the *next* run would be wrong without)
 * and on the three facts a model reliably gets wrong about this operation: it is scoped to
 * this repository and not to the persona everywhere, there are three slots for a whole run,
 * and reusing a key replaces rather than appends.
 *
 * The two neighbours are named in the description on purpose, because "where does this go"
 * is the question a model gets wrong most often: a finding about *this task* is a note, and
 * a standing instruction that holds everywhere is a prompt revision.
 */

export const EXPERIENCE_SERVER_NAME = 'loom_experience'
export const RECORD_EXPERIENCE_TOOL_NAME = `mcp__${EXPERIENCE_SERVER_NAME}__record_experience`

export const EXPERIENCE_TOOL_NAMES = [RECORD_EXPERIENCE_TOOL_NAME] as const

export interface ExperienceToolCallbacks {
  readonly recordExperience: (distillation: {
    lessons: unknown[]
  }) => Promise<
    | { ok: true; written: number; superseded: number; remaining: number }
    | { ok: false; reason: string }
  >
}

const KIND_GUIDANCE =
  'convention: a rule this codebase follows that a newcomer would break. ' +
  'hazard: a place work goes wrong — the trap you fell into. ' +
  'procedure: how a task of this shape is actually carried out here, including the step ' +
  'that turns out to be mandatory. ' +
  'correction: something you previously recorded that turned out to be false — reuse the ' +
  'old key so it replaces it.'

export const createExperienceTool = (callbacks: ExperienceToolCallbacks) => {
  const recordExperience = tool(
    'record_experience',
    'Record what you learned about THIS REPOSITORY, for future runs of you against it. ' +
      'Worth calling once, near the end. The bar is high: something the next run would be ' +
      'wrong without, that it could not get by reading the code for a minute. ' +
      'Not a summary of this task, not what you did today, not that the tests passed — ' +
      'that is a diary, and it crowds out what is not. ' +
      `You have ${MAX_LESSONS_PER_RUN} slots for this whole run, and this persona keeps a ` +
      'bounded memory of this repository: when it is full, nothing is dropped for you — you ' +
      'replace something by reusing its key. ' +
      'A finding about the task in hand belongs in write_note, which your siblings read and ' +
      'which costs nobody future context. A standing instruction that holds in every ' +
      'repository belongs in revise_own_prompt. This is for the middle one: true here, ' +
      'durable, and worth carrying.',
    {
      lessons: z
        .array(
          z.object({
            key: z
              .string()
              .min(1)
              .max(MAX_LESSON_KEY_LENGTH)
              .describe(
                'A short lowercase slug naming the claim (dashes allowed). Reusing a key you ' +
                  'already recorded REPLACES that lesson — which is how you correct yourself ' +
                  'and how you make room in a full memory.',
              ),
            kind: z
              .enum(LESSON_KINDS as unknown as [string, ...string[]])
              .describe(KIND_GUIDANCE),
            title: z
              .string()
              .min(1)
              .max(MAX_LESSON_TITLE_LENGTH)
              .describe('One line. What is true, not what you were doing when you found it.'),
            body: z
              .string()
              .min(1)
              .max(MAX_LESSON_BODY_LENGTH)
              .describe(
                'The claim, and enough of why it holds that a later reader can tell whether ' +
                  'it still applies. A pointer, not a document.',
              ),
            paths: z
              .array(z.string().max(500))
              .max(MAX_LESSON_PATHS)
              .optional()
              .describe(
                'Repository-relative paths this is about. Naming them is what lets the ' +
                  'platform retire this lesson automatically when those files change — a ' +
                  'lesson with no paths can only ever be retired by a human.',
              ),
          }),
        )
        .min(1)
        .max(MAX_LESSONS_PER_RUN),
    },
    async (args) => {
      const result = await callbacks.recordExperience({ lessons: args.lessons })

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Not recorded: ${result.reason}` }],
          isError: true,
        }
      }

      const replaced =
        result.superseded > 0 ? `, replacing ${result.superseded} you had recorded before` : ''
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Recorded ${result.written} lesson(s)${replaced}. Future runs of this persona ` +
              `against this repository will be shown it, as data they must still verify. ` +
              `${result.remaining} slot(s) left this run. **Your own run is unchanged** — ` +
              'carry on with your task.',
          },
        ],
      }
    },
  )

  return createSdkMcpServer({
    name: EXPERIENCE_SERVER_NAME,
    version: '1.0.0',
    tools: [recordExperience],
  })
}
