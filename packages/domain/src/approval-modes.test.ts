import { describe, expect, it } from 'vitest'
import {
  APPROVAL_MODES,
  approvalModeAllows,
  approvalModeFromSnapshot,
  approvalModeRank,
  isApprovalMode,
  isWiderApprovalMode,
} from './approval-modes.js'

/**
 * The mode that replaced `harness.autoApprove`.
 *
 * Two properties carry the security weight: the ordering, because the attenuation
 * compares modes and a child may never hold a wider one; and what `accept-edits`
 * covers, because a middle that quietly included `Bash` would be `auto` under a
 * friendlier name.
 */

describe('the ordering', () => {
  it('goes narrowest to widest', () => {
    expect(APPROVAL_MODES).toEqual(['ask', 'accept-edits', 'auto'])
    expect(approvalModeRank('ask')).toBeLessThan(approvalModeRank('accept-edits'))
    expect(approvalModeRank('accept-edits')).toBeLessThan(approvalModeRank('auto'))
  })

  it('refuses every widening and permits every narrowing', () => {
    for (const child of APPROVAL_MODES) {
      for (const parent of APPROVAL_MODES) {
        expect(isWiderApprovalMode(child, parent)).toBe(
          approvalModeRank(child) > approvalModeRank(parent),
        )
      }
    }
  })

  it('lets a mode equal its parent, which is the ordinary case', () => {
    for (const mode of APPROVAL_MODES) expect(isWiderApprovalMode(mode, mode)).toBe(false)
  })

  /** The rule the boolean already had, now as one case of a general one. */
  it('still refuses auto under ask', () => {
    expect(isWiderApprovalMode('auto', 'ask')).toBe(true)
  })
})

describe('what each mode lets through', () => {
  const EDITS = ['Edit', 'Write', 'NotebookEdit']

  it('ask lets nothing through', () => {
    for (const tool of [...EDITS, 'Bash']) expect(approvalModeAllows('ask', tool)).toBe(false)
  })

  it('auto lets everything through', () => {
    for (const tool of [...EDITS, 'Bash']) expect(approvalModeAllows('auto', tool)).toBe(true)
  })

  it('accept-edits takes the file writes', () => {
    for (const tool of EDITS) expect(approvalModeAllows('accept-edits', tool)).toBe(true)
  })

  /**
   * The line that makes `accept-edits` a defensible middle rather than a smaller `auto`. A
   * shell can write a file too — and can also push, install, and read a credential — and
   * `classifyBashCommand` triages those without being sound (effect-based classification
   * says so itself), so "accept edits" must never mean "accept a shell that happens to
   * edit".
   */
  it('accept-edits never takes a shell', () => {
    expect(approvalModeAllows('accept-edits', 'Bash')).toBe(false)
  })

  it('accept-edits never takes a tool it has not heard of', () => {
    // A tool added later is unknown to this list, and unknown must mean "ask".
    expect(approvalModeAllows('accept-edits', 'SomeFutureTool')).toBe(false)
  })
})

describe('reading a stored snapshot', () => {
  it('prefers the mode when a run recorded one', () => {
    expect(approvalModeFromSnapshot({ approvalMode: 'accept-edits' })).toBe('accept-edits')
  })

  /**
   * A run that finished before this existed has only the boolean, and it must still
   * be readable — its cost, its diff and its transcript are all still wanted.
   */
  it('reads the boolean a completed run recorded', () => {
    expect(approvalModeFromSnapshot({ autoApprove: true })).toBe('auto')
    expect(approvalModeFromSnapshot({ autoApprove: false })).toBe('ask')
  })

  it('falls to the narrowest mode on anything it cannot read', () => {
    expect(approvalModeFromSnapshot({})).toBe('ask')
    expect(approvalModeFromSnapshot({ approvalMode: 'yolo' })).toBe('ask')
    expect(approvalModeFromSnapshot({ approvalMode: 7 })).toBe('ask')
  })

  it('lets the mode win when a snapshot carries both', () => {
    expect(approvalModeFromSnapshot({ approvalMode: 'ask', autoApprove: true })).toBe('ask')
  })
})

describe('isApprovalMode', () => {
  it('accepts exactly the three', () => {
    for (const mode of APPROVAL_MODES) expect(isApprovalMode(mode)).toBe(true)
    for (const value of ['', 'AUTO', 'accept_edits', null, 3, undefined]) {
      expect(isApprovalMode(value)).toBe(false)
    }
  })
})
