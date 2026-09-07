import { describe, expect, it, vi } from 'vitest'
import { bridgeMcpServer, bridgedToolName } from './mcp-bridge.js'
import { createPlannerTool, PLANNER_SERVER_NAME, PLANNER_TOOL_NAME } from './planner-tool.js'
import { createQuestionTool, ASK_HUMAN_TOOL_NAME } from './question-tool.js'
import {
  createWorkflowAnswerTool,
  SUBMIT_WORKFLOW_ANSWER_TOOL_NAME,
} from './workflow-answer-tool.js'
import { createDesignTool, SUBMIT_WORKFLOW_DESIGN_TOOL_NAME } from './design-tool.js'

/**
 * The channels, read off the servers that hold them.
 *
 * These are the real channel modules rather than a stub of one, because the property under test
 * is *parity*: the name a model calls a channel by has to be the same name on both backends. It
 * is not a cosmetic property — the server matches on these names when it reads a run's messages
 * back, and a live driver asserts on the head of the tool-call line. A bridge that renamed
 * `submit_workflow_answer` would leave every one of those true on one backend and false on the
 * other, and nothing would fail until a workflow step answered into the void.
 */

describe('bridgeMcpServer', () => {
  it('offers a channel under the exact name the platform already exports for it', async () => {
    const planner = await bridgeMcpServer(createPlannerTool().server as never)
    const question = await bridgeMcpServer(
      createQuestionTool({ askHuman: async () => ({ answer: 'yes' }) }).server as never,
    )
    const workflow = await bridgeMcpServer(
      createWorkflowAnswerTool([{ kind: 'text', name: 'verdict' }], {
        submit: async () => ({ ok: true, outcome: 'recorded' }),
      }) as never,
    )
    const design = await bridgeMcpServer(
      createDesignTool('draw me one', { submit: async () => ({ ok: true, outcome: 'stored' }) }) as never,
    )

    expect(planner.tools.map((tool) => tool.name)).toContain(PLANNER_TOOL_NAME)
    expect(question.tools.map((tool) => tool.name)).toContain(ASK_HUMAN_TOOL_NAME)
    expect(workflow.tools.map((tool) => tool.name)).toContain(SUBMIT_WORKFLOW_ANSWER_TOOL_NAME)
    expect(design.tools.map((tool) => tool.name)).toContain(SUBMIT_WORKFLOW_DESIGN_TOOL_NAME)
  })

  it('renders the arguments as a schema a function declaration can carry', async () => {
    const workflow = await bridgeMcpServer(
      createWorkflowAnswerTool([{ kind: 'list', name: 'sites' }], {
        submit: async () => ({ ok: true, outcome: 'recorded' }),
      }) as never,
    )
    const declared = workflow.tools.find((tool) => tool.name === SUBMIT_WORKFLOW_ANSWER_TOOL_NAME)
    const schema = declared?.parameters as Record<string, unknown>
    expect(schema.type).toBe('object')
    // The field the node declared, by name — this is the whole reason the channel is a tool.
    expect(Object.keys((schema.properties ?? {}) as object)).toContain('sites')
    // `$schema` is dropped: some servers speaking this protocol reject a declaration carrying it.
    expect(schema.$schema).toBeUndefined()
  })

  it('reaches the callback the Runner is holding, and brings its answer back', async () => {
    const submit = vi.fn(async () => ({ ok: true as const, outcome: 'Answer recorded.' }))
    const workflow = await bridgeMcpServer(
      createWorkflowAnswerTool([{ kind: 'text', name: 'verdict' }], { submit }) as never,
    )
    const answered = await workflow.call(SUBMIT_WORKFLOW_ANSWER_TOOL_NAME, { verdict: 'it holds' })
    expect(submit).toHaveBeenCalledWith({ verdict: 'it holds' })
    expect(answered.isError).toBe(false)
    expect(answered.text).toContain('Answer recorded')
  })

  /**
   * The refusal loop, which is the reason these channels are tools at all: a validator that
   * answers in its own words, as a tool result, in time for the model to fix what it sent. A
   * bridge that swallowed `isError` would turn every one of those into an apparent success.
   */
  it('carries a channel’s refusal back as an error the model can act on', async () => {
    const workflow = await bridgeMcpServer(
      createWorkflowAnswerTool([{ kind: 'text', name: 'verdict' }], {
        submit: async () => ({ ok: false as const, error: 'The answer has no "verdict".' }),
      }) as never,
    )
    const refused = await workflow.call(SUBMIT_WORKFLOW_ANSWER_TOOL_NAME, { verdict: 'x' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('no "verdict"')
  })

  it('refuses arguments the channel’s own schema rejects, rather than passing them through', async () => {
    const submit = vi.fn(async () => ({ ok: true as const, outcome: 'recorded' }))
    const workflow = await bridgeMcpServer(
      createWorkflowAnswerTool([{ kind: 'list', name: 'sites' }], { submit }) as never,
    )
    const wrong = await workflow.call(SUBMIT_WORKFLOW_ANSWER_TOOL_NAME, { sites: 'one and another' })
    expect(wrong.isError).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })

  it('names a tool nobody mounted as an error rather than throwing', async () => {
    const planner = await bridgeMcpServer(createPlannerTool().server as never)
    const nothing = await planner.call(bridgedToolName(PLANNER_SERVER_NAME, 'record_map'), {})
    expect(nothing.isError).toBe(true)
  })
})
