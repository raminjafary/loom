import { asAgentRunId } from '@loom/domain'
import { describe, expect, it } from 'vitest'
import { inScopeRunIds } from './note-use-cases.js'

const id = (raw: string) => asAgentRunId(raw)
const node = (raw: string, parent: string | null) => ({
  id: id(raw),
  parentRunId: parent === null ? null : id(parent),
})

/**
 * The corporation: one root orchestrator, two sub-planners, two workers each.
 *
 *            root
 *          /      \
 *         A        B
 *       /   \    /   \
 *     wa1   wa2 wb1  wb2
 */
const CORPORATION = [
  node('root', null),
  node('A', 'root'),
  node('B', 'root'),
  node('wa1', 'A'),
  node('wa2', 'A'),
  node('wb1', 'B'),
  node('wb2', 'B'),
]

const scopeOf = (tree: typeof CORPORATION, runId: string) =>
  [...inScopeRunIds(tree, { id: id(runId) })].map(String).sort()

describe('inScopeRunIds', () => {
  /**
   * The measured behaviour, and the reason the rule includes siblings at all: The
   * parallel-branch measurement found peer coordination to be what prevents conflicts. In a
   * flat tree this rule must admit everything, or Phase 2 regresses.
   */
  it('changes nothing for a flat fan-out — every worker still sees every sibling', () => {
    const flat = [node('p', null), node('w1', 'p'), node('w2', 'p'), node('w3', 'p')]
    expect(scopeOf(flat, 'w1')).toEqual(['p', 'w1', 'w2', 'w3'])
  })

  it('hides another sub-planner subtree from a worker', () => {
    // The leak, and the whole point. wa1 coordinates with wa2, answers to A and root,
    // and never learns that B exists.
    expect(scopeOf(CORPORATION, 'wa1')).toEqual(['A', 'root', 'wa1', 'wa2'])
  })

  it('lets sub-planners see each other as peers, but not inside each other', () => {
    // A and B must coordinate — they are the two most likely to design the same
    // concept twice — but A has no business reading B's workers' notes.
    expect(scopeOf(CORPORATION, 'A')).toEqual(['A', 'B', 'root', 'wa1', 'wa2'])
  })

  it('gives the root the whole tree', () => {
    expect(scopeOf(CORPORATION, 'root')).toEqual(['A', 'B', 'root', 'wa1', 'wa2', 'wb1', 'wb2'])
  })

  it('reaches every descendant, not only the next generation', () => {
    const deep = [
      node('root', null),
      node('mid', 'root'),
      node('leaf', 'mid'),
      node('deeper', 'leaf'),
    ]
    expect(scopeOf(deep, 'root')).toEqual(['deeper', 'leaf', 'mid', 'root'])
  })

  it('walks the whole ancestor chain, not only the parent', () => {
    const deep = [node('root', null), node('mid', 'root'), node('leaf', 'mid')]
    expect(scopeOf(deep, 'leaf')).toContain('root')
  })

  it('terminates on a parent cycle rather than looping', () => {
    // A bad backfill, not a legitimate shape. The answer degrades; the request returns.
    const cyclic = [node('a', 'b'), node('b', 'a')]
    expect(scopeOf(cyclic, 'a').length).toBeGreaterThan(0)
  })

  it('returns the run itself when the tree does not contain it', () => {
    // A run whose ancestors were cascaded away still gets its own notes rather than
    // an empty ledger that would read as "nobody has written anything".
    expect(scopeOf([], 'orphan')).toEqual(['orphan'])
  })
})
