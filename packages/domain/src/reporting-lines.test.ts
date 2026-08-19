import { describe, expect, it } from 'vitest'
import { describeTeamRepositories } from './delegation-roster.js'
import {
  describeReportingLines,
  hasReportingLines,
  reportingLineProblems,
  reportsToPlanner,
  scopeToReportingLines,
  type ReportingLines,
} from './reporting-lines.js'

/**
 * The chain of command.
 *
 * Every test here is one of the three decisions the module documents: keyed by the worker
 * because a worker reports to at most one planner, a line only ever narrows, and it is a
 * tree rather than a graph.
 */

const member = (id: string) => id

describe('reportsToPlanner', () => {
  /**
   * Absence has to mean "no narrowing" rather than "nobody": no chain of command is every
   * team's current state, so an empty map must change nothing.
   */
  it('offers an unassigned worker to every planner', () => {
    expect(reportsToPlanner({}, 'swe', 'lead')).toBe(true)
    expect(reportsToPlanner({}, 'swe', 'other-lead')).toBe(true)
  })

  it('offers an assigned worker only to its own planner', () => {
    const lines: ReportingLines = { swe: 'lead' }
    expect(reportsToPlanner(lines, 'swe', 'lead')).toBe(true)
    expect(reportsToPlanner(lines, 'swe', 'other-lead')).toBe(false)
  })
})

describe('scopeToReportingLines', () => {
  const candidates = [{ id: 'swe' }, { id: 'qa' }, { id: 'sub-lead' }]

  it('leaves the roster alone when nothing is assigned', () => {
    expect(scopeToReportingLines(candidates, {}, 'lead')).toEqual(candidates)
  })

  it('narrows a roster to this planner’s own people, keeping the unassigned', () => {
    const scoped = scopeToReportingLines(
      candidates,
      { swe: 'lead', qa: 'other-lead' },
      'lead',
    )
    // `swe` is mine, `qa` is somebody else's, `sub-lead` is nobody's and so still offered.
    expect(scoped.map((entry) => entry.id)).toEqual(['swe', 'sub-lead'])
  })

  /**
   * The point of the whole feature: with every worker assigned to sub-planners, a root's
   * roster is the sub-planners. That is the corporation shape the corporation describes,
   * and it is not expressible by depth — which is reachability, and reachability is flat.
   */
  it('leaves a root with only its sub-planners when every worker is assigned below', () => {
    const scoped = scopeToReportingLines(
      [{ id: 'swe' }, { id: 'qa' }, { id: 'sub-lead' }],
      { swe: 'sub-lead', qa: 'sub-lead' },
      'root-lead',
    )
    expect(scoped.map((entry) => entry.id)).toEqual(['sub-lead'])
  })
})

describe('reportingLineProblems', () => {
  const team = {
    memberIds: [member('lead'), member('sub-lead'), member('swe'), member('qa')],
    plannerIds: [member('lead'), member('sub-lead')],
  }

  it('accepts a chain of command', () => {
    expect(
      reportingLineProblems({ ...team, lines: { swe: 'sub-lead', 'sub-lead': 'lead' } }),
    ).toEqual([])
  })

  it('refuses a line to somebody not on the team', () => {
    const problems = reportingLineProblems({ ...team, lines: { swe: 'stranger' } })
    expect(problems[0]).toContain('not on this team')
  })

  it('refuses a line from somebody not on the team', () => {
    const problems = reportingLineProblems({ ...team, lines: { stranger: 'lead' } })
    expect(problems[0]).toContain('not on this team')
  })

  /**
   * Only a planner is given a roster, so a line into a worker would be an assignment
   * nothing ever reads — a control the runtime ignores, which the roadmap forbids on this
   * canvas.
   */
  it('refuses reporting to a persona that is not a planner', () => {
    const problems = reportingLineProblems({ ...team, lines: { qa: 'swe' } })
    expect(problems[0]).toContain('not a planner')
  })

  it('refuses a persona reporting to itself', () => {
    const problems = reportingLineProblems({ ...team, lines: { 'sub-lead': 'sub-lead' } })
    expect(problems[0]).toContain('cannot report to itself')
  })

  /** A chain is legitimate; a loop makes "whose worker is this" depend on who asked first. */
  it('refuses a cycle between two planners', () => {
    const problems = reportingLineProblems({
      ...team,
      lines: { lead: 'sub-lead', 'sub-lead': 'lead' },
    })
    expect(problems.some((problem) => problem.includes('in a circle'))).toBe(true)
  })

  it('accepts a long chain rather than calling it a cycle', () => {
    expect(
      reportingLineProblems({
        memberIds: ['a', 'b', 'c', 'd'],
        plannerIds: ['a', 'b', 'c'],
        lines: { d: 'c', c: 'b', b: 'a' },
      }),
    ).toEqual([])
  })

  it('names personas rather than ids when it can', () => {
    const problems = reportingLineProblems({
      ...team,
      lines: { qa: 'swe' },
      nameOf: (id) => `persona-${id}`,
    })
    expect(problems[0]).toContain('persona-swe')
  })
})

describe('describeReportingLines', () => {
  it('says nothing when the team has no chain of command', () => {
    expect(
      describeReportingLines({
        lines: {},
        plannerPersonaId: 'lead',
        assignedNames: [],
        elsewhereNames: [],
      }),
    ).toBe('')
    expect(hasReportingLines({})).toBe(false)
  })

  it('names this planner’s own people', () => {
    const text = describeReportingLines({
      lines: { swe: 'lead' },
      plannerPersonaId: 'lead',
      assignedNames: ['swe'],
      elsewhereNames: [],
    })
    expect(text).toContain('swe')
    expect(text).toContain('report(s) to you')
  })

  /**
   * The half that is easy to leave out and matters most: a narrowed roster and a small
   * workspace read identically to a model, and a planner that believes the second reports
   * that the goal is impossible rather than delegating what it has.
   */
  it('says who is on the team but somebody else’s, and what to do about it', () => {
    const text = describeReportingLines({
      lines: { swe: 'lead', qa: 'other-lead' },
      plannerPersonaId: 'lead',
      assignedNames: ['swe'],
      elsewhereNames: ['qa'],
    })
    expect(text).toContain('qa')
    expect(text).toContain('report to another planner')
    expect(text).toContain('give that part to the planner they report to')
  })
})

/**
 * The cross-repository clause — what a planner is told when its
 * team works in more than one repository.
 *
 * Here rather than in its own file because it is the same kind of thing as a reporting line:
 * a fact about the team that only matters as a sentence in the roster, and one whose *silence*
 * is as load-bearing as its content.
 */
describe('describeTeamRepositories', () => {
  /**
   * The silence is the decision. A planner told "you may name a repository" when it has one
   * would spend a field on a choice it does not have — and a model handed an option uses it.
   */
  it('says nothing when the team works in one repository', () => {
    expect(describeTeamRepositories({ own: 'flight-api', others: [] })).toBe('')
    expect(describeTeamRepositories({ own: null, others: [] })).toBe('')
  })

  it('names the whole set, including the planner’s own', () => {
    const text = describeTeamRepositories({ own: 'flight-api', others: ['hotel-api', 'billing'] })
    expect(text).toContain('flight-api')
    expect(text).toContain('hotel-api')
    expect(text).toContain('billing')
  })

  /**
   * The rule that makes the field usable rather than decorative: a subtask in a different
   * repository cannot conflict with one in another, which is a stronger split than any area
   * boundary — and an unlisted name is refused rather than silently redirected.
   */
  it('tells the planner to split by repository first, and that a wrong name is refused', () => {
    const text = describeTeamRepositories({ own: 'flight-api', others: ['hotel-api'] })
    expect(text).toContain('Split by repository before you split by anything else')
    expect(text).toContain('refused')
    expect(text).toContain('`repository` field')
  })

  /** A planner with no repository of its own still gets a usable sentence. */
  it('handles a team whose planner has no repository', () => {
    const text = describeTeamRepositories({ own: null, others: ['hotel-api'] })
    expect(text).toContain('hotel-api')
    expect(text).not.toContain('null')
  })
})
