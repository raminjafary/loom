import { describe, expect, it } from 'vitest'
import { APPROVAL_MODES } from './approval-modes.js'
import { attenuateChildPersona } from './attenuation.js'
import { delegationDesign, delegationMatrix } from './delegation-design.js'
import type { PersonaSpec } from './agents.js'

const spec = (overrides: Partial<PersonaSpec> = {}): PersonaSpec => ({
  name: 'worker',
  systemPrompt: '',
  model: 'claude-haiku-4-5-20251001',
  tools: ['Read'],
  approvalMode: 'ask' as const,
  budgetCapUsd: null,
  ...overrides,
})

const planner = (overrides: Partial<PersonaSpec> = {}): PersonaSpec =>
  spec({
    name: 'planner',
    tools: ['Read', 'Grep', 'Glob'],
    planner: true,
    delegates: ['Read', 'Edit', 'Write'],
    model: 'claude-sonnet-5',
    ...overrides,
  })

describe('delegationDesign', () => {
  it('accepts a worker inside the envelope', () => {
    expect(delegationDesign(planner(), spec({ tools: ['Read', 'Edit'] })).refusals).toEqual([])
  })

  it('names the tools outside the envelope, and offers to widen it', () => {
    const design = delegationDesign(planner(), spec({ tools: ['Read', 'Bash'] }))
    expect(design.ok).toBe(false)
    expect(design.refusals[0]?.rule).toBe('tools')
    expect(design.refusals[0]?.widenEnvelopeWith).toEqual(['Bash'])
  })

  /**
   * The whole reason this exists beside the gate. The gate is
   * right to stop at the first refusal; a human fixing them one save at a time is
   * the failure the roadmap describes.
   */
  it('reports every reason at once, not the first', () => {
    const design = delegationDesign(
      planner({ budgetCapUsd: 1 }),
      spec({
        tools: ['Bash'],
        approvalMode: 'auto' as const,
        budgetCapUsd: null,
        model: 'claude-opus-5',
      }),
    )
    expect(design.refusals.map((refusal) => refusal.rule).sort()).toEqual([
      'autoApprove',
      'budget',
      'model',
      'tools',
    ])
  })

  it('offers no envelope widening for a refusal widening cannot fix', () => {
    const design = delegationDesign(planner(), spec({ approvalMode: 'auto' as const }))
    expect(design.refusals[0]?.widenEnvelopeWith).toBeUndefined()
  })

  it('explains a sub-planner refused for depth before it explains its tools', () => {
    const design = delegationDesign(planner(), planner({ name: 'sub' }), 0)
    expect(design.refusals[0]?.rule).toBe('depth')
  })

  /**
   * The interaction the last session paid a live run to discover: a planner on a
   * cheap model has a correct, empty roster, and nothing said so where the model was
   * chosen.
   */
  it('names the model tier, which is the refusal nobody expects', () => {
    const design = delegationDesign(
      planner({ model: 'claude-haiku-4-5-20251001' }),
      spec({ model: 'claude-sonnet-5' }),
    )
    expect(design.refusals[0]?.rule).toBe('model')
    expect(design.refusals[0]?.fix).toContain('claude-sonnet-5')
  })
})

/**
 * The guard that matters more than any single case above. Two implementations of one
 * rule drift, and a second opinion that could drift is worse than none because it
 * would be believed — so `ok` is asserted against the gate over every combination of
 * the five dimensions attenuation looks at, not over a table someone must remember to
 * extend.
 */
describe('it agrees with the gate that actually refuses a child start', () => {
  const TOOLS = [[], ['Read'], ['Read', 'Edit'], ['Bash']]
  const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'llama-local']
  const CAPS = [null, 0.5, 5]

  it('over every combination of tools, model, cap, approval mode and planner-ness', () => {
    let compared = 0
    for (const parentTools of TOOLS) {
      for (const childTools of TOOLS) {
        for (const parentModel of MODELS) {
          for (const childModel of MODELS) {
            for (const parentCap of CAPS) {
              for (const childCap of CAPS) {
                for (const parentMode of APPROVAL_MODES) {
                  for (const childMode of APPROVAL_MODES) {
                    for (const childIsPlanner of [false, true]) {
                      const parent: PersonaSpec = spec({
                        name: 'parent',
                        tools: ['Read', 'Grep', 'Glob'],
                        planner: true,
                        delegates: parentTools,
                        model: parentModel,
                        budgetCapUsd: parentCap,
                        approvalMode: parentMode,
                      })
                      const child: PersonaSpec = spec({
                        name: 'child',
                        tools: childTools,
                        model: childModel,
                        budgetCapUsd: childCap,
                        approvalMode: childMode,
                        ...(childIsPlanner ? { planner: true, delegates: childTools } : {}),
                      })
                      compared += 1
                      // `remainingDepth: 1` so the depth rule — which the gate does not
                      // model at all, because `startAgentRun` enforces it separately —
                      // never fires and the two are answering the same question.
                      expect(
                        delegationDesign(parent, child, 1).ok,
                        `parent ${JSON.stringify(parent)} child ${JSON.stringify(child)}`,
                      ).toBe(attenuateChildPersona(parent, child).ok)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(4_000)
  })
})

describe('delegationMatrix', () => {
  it('has a row for every planner against every persona, including itself', () => {
    const rows = delegationMatrix([planner(), spec({ name: 'swe' })], 1)
    expect(rows.map((row) => `${row.plannerName}->${row.workerName}`)).toEqual([
      'planner->planner',
      'planner->swe',
    ])
  })

  it('is empty when no persona is a planner, rather than inventing edges', () => {
    expect(delegationMatrix([spec({ name: 'a' }), spec({ name: 'b' })])).toEqual([])
  })
})
