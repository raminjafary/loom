import { describe, expect, it } from 'vitest'
import type { Thread } from '@loom/api-contract'
import {
  areaLabelFromAnnouncement,
  buildThreadTrail,
  threadsByParentMessage,
} from './area-threads.js'

const thread = (over: Partial<Thread> & { id: string }): Thread => ({
  workspaceId: 'ws-1',
  channelId: 'ch-1',
  parentMessageId: null,
  isRoot: false,
  createdAt: new Date(2026, 0, 1),
  ...over,
})

const ROOT = thread({ id: 'root', isRoot: true })
const AREA = thread({ id: 'area-a', parentMessageId: 'msg-1' })

describe('threadsByParentMessage', () => {
  it('indexes a reply thread by the message it hangs off', () => {
    const byParent = threadsByParentMessage([ROOT, AREA])
    expect(byParent.get('msg-1')?.id).toBe('area-a')
  })

  it('ignores the root, which hangs off nothing', () => {
    expect(threadsByParentMessage([ROOT]).size).toBe(0)
  })

  it('keeps the older thread when a message somehow has two', () => {
    // Threads come back oldest-first, and the one the announcement described is the
    // older — a later duplicate must not silently take over the link.
    const second = thread({ id: 'area-b', parentMessageId: 'msg-1' })
    expect(threadsByParentMessage([AREA, second]).get('msg-1')?.id).toBe('area-a')
  })
})

describe('buildThreadTrail', () => {
  /**
   * The trail exists to get *out* of an area, so its absence on an ordinary channel
   * matters as much as its presence in a swarm: a one-step breadcrumb reading "you are
   * here" would appear on every channel that has never run one.
   */
  it('draws nothing when the active thread is the channel root', () => {
    expect(buildThreadTrail([ROOT, AREA], 'root', () => 'x')).toEqual([])
  })

  it('draws nothing when there is no active thread', () => {
    expect(buildThreadTrail([ROOT], null, () => 'x')).toEqual([])
  })

  it('names the area from its announcement, with the root as the way back', () => {
    const trail = buildThreadTrail([ROOT, AREA], 'area-a', (id) =>
      id === 'msg-1' ? 'The docs area' : null,
    )
    expect(trail).toEqual([
      { threadId: 'root', label: 'Channel', current: false },
      { threadId: 'area-a', label: 'The docs area', current: true },
    ])
  })

  it('still offers the way back when the announcement is off the loaded page', () => {
    // The failure that would otherwise strand a user inside an area: the first page of
    // a thread is the newest 50 messages, so the announcement is often not loaded.
    const trail = buildThreadTrail([ROOT, AREA], 'area-a', () => null)
    expect(trail.map((step) => step.label)).toEqual(['Channel', 'Area'])
    expect(trail[0]?.threadId).toBe('root')
  })
})

describe('areaLabelFromAnnouncement', () => {
  it('takes the subtask title from the platform announcement', () => {
    expect(
      areaLabelFromAnnouncement('The docs area → planner: delegated as its own area.'),
    ).toBe('The docs area')
  })

  it('falls back to the line, then to a generic label', () => {
    expect(areaLabelFromAnnouncement('no arrow here')).toBe('no arrow here')
    expect(areaLabelFromAnnouncement(null)).toBe('Area')
    expect(areaLabelFromAnnouncement('   ')).toBe('Area')
  })

  it('truncates, because this renders on one line in a header', () => {
    expect(areaLabelFromAnnouncement('x'.repeat(200)).length).toBe(60)
  })
})
