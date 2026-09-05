import { describe, expect, it } from 'vitest'
import {
  nextWorkflowTrialArm,
  summarizeWorkflowTrial,
  tallyWorkflowTrial,
  type WorkflowTrialEntryOutcome,
} from './workflow-trial.js'

/**
 * The claim a drawn shape has to survive, and the arithmetic that settles it.
 *
 * What matters here is the unit: this is the one trial in the platform whose arms differ in how
 * many *runs* they take, so counting runs would compare the arms on how mergeable their smallest
 * branch was. The tests below hold the denominator down as hard as the verdicts.
 */

const entry = (over: Partial<WorkflowTrialEntryOutcome> = {}): WorkflowTrialEntryOutcome => ({
  arm: 'workflow',
  decided: true,
  merged: true,
  discarded: false,
  failed: false,
  verificationFailed: false,
  failingCheck: null,
  costUsd: 1,
  runs: 1,
  ...over,
})

const tasks = (arm: 'workflow' | 'planner', count: number, over: Partial<WorkflowTrialEntryOutcome> = {}) =>
  Array.from({ length: count }, () => entry({ arm, ...over }))

describe('nextWorkflowTrialArm', () => {
  it('sends the first task of a class to the planner, which is what the platform already does', () => {
    expect(nextWorkflowTrialArm({ workflow: 0, planner: 0 })).toBe('planner')
  })

  it('alternates from the counts rather than sampling', () => {
    expect(nextWorkflowTrialArm({ workflow: 0, planner: 1 })).toBe('workflow')
    expect(nextWorkflowTrialArm({ workflow: 1, planner: 1 })).toBe('planner')
    expect(nextWorkflowTrialArm({ workflow: 3, planner: 1 })).toBe('planner')
  })
})

describe('tallyWorkflowTrial', () => {
  /** The whole reason this trial does not reuse the per-run tally next door. */
  it('counts tasks, not runs — six branches from one task is one task', () => {
    const [workflow] = tallyWorkflowTrial([entry({ arm: 'workflow', runs: 6 })])
    expect(workflow?.decided).toBe(1)
    expect(workflow?.merged).toBe(1)
    expect(workflow?.runsTotal).toBe(6)
  })

  it('leaves an undecided task out of the denominator and its cost out of the total', () => {
    const [workflow] = tallyWorkflowTrial([
      entry({ decided: true, costUsd: 2 }),
      entry({ decided: false, merged: false, costUsd: 9 }),
    ])
    expect(workflow?.tasks).toBe(2)
    expect(workflow?.decided).toBe(1)
    expect(workflow?.costUsdTotal).toBe(2)
  })

  it('does not count a task both taken and discarded twice against itself', () => {
    const [workflow] = tallyWorkflowTrial([entry({ merged: true, discarded: true })])
    expect(workflow?.merged).toBe(1)
    expect(workflow?.discarded).toBe(0)
  })

  it('names the check that failed most often on the arm', () => {
    const [workflow] = tallyWorkflowTrial([
      entry({ verificationFailed: true, failingCheck: 'typecheck' }),
      entry({ verificationFailed: true, failingCheck: 'typecheck' }),
      entry({ verificationFailed: true, failingCheck: 'lint' }),
    ])
    expect(workflow?.failingCheck).toBe('typecheck')
    expect(workflow?.verificationFailed).toBe(3)
  })
})

describe('summarizeWorkflowTrial', () => {
  it('says how much of each side it still needs, rather than a verdict on two tasks', () => {
    const effect = summarizeWorkflowTrial([...tasks('workflow', 2), ...tasks('planner', 1)])
    expect(effect.verdict).toBe('undecided')
    expect(effect.detail).toContain('Still measuring')
    expect(effect.detail).toContain('2 decided task(s)')
  })

  it('says the harness earned it when the work it produced was taken more often', () => {
    const effect = summarizeWorkflowTrial([
      ...tasks('workflow', 5, { merged: true }),
      ...tasks('planner', 5, { merged: false, discarded: true }),
    ])
    expect(effect.verdict).toBe('harness')
    expect(effect.detail).toContain('taken 100% of the time against 0%')
  })

  /** The case a person most needs told: the shape is costing outcomes, not only money. */
  it('says so plainly when a planner did better', () => {
    const effect = summarizeWorkflowTrial([
      ...tasks('workflow', 5, { merged: false, discarded: true }),
      ...tasks('planner', 5, { merged: true }),
    ])
    expect(effect.verdict).toBe('planner')
    expect(effect.detail).toContain('costing outcomes')
  })

  /**
   * Level outcomes and level cost is *not* a result in the harness's favour: it is the thing
   * that costs more to draw, more to read and more to run.
   */
  it('refuses a level result rather than calling it a draw', () => {
    const effect = summarizeWorkflowTrial([
      ...tasks('workflow', 5, { merged: true, costUsd: 1 }),
      ...tasks('planner', 5, { merged: true, costUsd: 1 }),
    ])
    expect(effect.verdict).toBe('no-better')
    expect(effect.detail).toContain('does not need')
  })

  it('lets cost decide only where outcomes are level, and says which term decided', () => {
    const effect = summarizeWorkflowTrial([
      ...tasks('workflow', 5, { merged: true, costUsd: 0.5 }),
      ...tasks('planner', 5, { merged: true, costUsd: 2 }),
    ])
    expect(effect.verdict).toBe('harness')
    expect(effect.detail).toContain('paying for itself')
  })

  it('reports how much machinery each arm spent per task', () => {
    const effect = summarizeWorkflowTrial([
      ...tasks('workflow', 5, { runs: 6 }),
      ...tasks('planner', 5, { runs: 2 }),
    ])
    expect(effect.detail).toContain('6.0 run(s) per task against 2.0')
  })

  /** Two baselines averaged into one number is a caveat a reader cannot see from the figures. */
  it('says when the unaided arm was run by more than one persona', () => {
    const effect = summarizeWorkflowTrial(
      [...tasks('workflow', 5), ...tasks('planner', 5)],
      ['planner', 'area-planner'],
    )
    expect(effect.detail).toContain('2 different personas')
  })

  it('says nothing about the control when there was only one', () => {
    const effect = summarizeWorkflowTrial(
      [...tasks('workflow', 5), ...tasks('planner', 5)],
      ['planner'],
    )
    expect(effect.detail).not.toContain('different personas')
  })
})
