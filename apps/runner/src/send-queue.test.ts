import { describe, expect, it } from 'vitest'
import { createSendQueue } from './send-queue.js'

/**
 * Backpressure is one of the things that make apps/runner a real distributed component
 * rather than a happy-path script. Each test below is
 * one way an unbounded, drop-on-disconnect send path fails in production.
 */

interface Frame {
  type: string
  n?: number
}

const harness = (overrides: Partial<Parameters<typeof createSendQueue<Frame>>[0]> = {}) => {
  const written: Frame[] = []
  const logs: string[] = []
  let open = true
  let buffered = 0

  const queue = createSendQueue<Frame>({
    isOpen: () => open,
    bufferedAmount: () => buffered,
    write: (frame) => written.push(frame),
    shouldHold: (frame) => frame.type === 'agent_event',
    highWaterBytes: 100,
    outboxLimit: 3,
    log: (message) => logs.push(message),
    sleep: async () => {},
    ...overrides,
  })

  return {
    queue,
    written,
    logs,
    setOpen: (value: boolean) => {
      open = value
    },
    setBuffered: (value: number) => {
      buffered = value
    },
  }
}

describe('createSendQueue', () => {
  it('writes straight through while the socket is open', () => {
    const h = harness()
    h.queue.send({ type: 'agent_event', n: 1 })
    expect(h.written).toEqual([{ type: 'agent_event', n: 1 }])
    expect(h.queue.heldCount()).toBe(0)
  })

  it('holds run events across a disconnect and replays them in order', () => {
    const h = harness()
    h.setOpen(false)
    h.queue.send({ type: 'agent_event', n: 1 })
    h.queue.send({ type: 'agent_event', n: 2 })
    expect(h.written).toEqual([])
    expect(h.queue.heldCount()).toBe(2)

    h.setOpen(true)
    h.queue.flush()
    // Order matters: the server's (run, seq) index makes a replay harmless, but
    // out-of-order arrival would render an agent's steps in the wrong sequence.
    expect(h.written.map((f) => f.n)).toEqual([1, 2])
    expect(h.queue.heldCount()).toBe(0)
  })

  it('discards frames a late delivery would falsify', () => {
    const h = harness()
    h.setOpen(false)
    h.queue.send({ type: 'heartbeat' })
    h.queue.send({ type: 'check_path_result' })
    h.setOpen(true)
    h.queue.flush()
    // A heartbeat replayed after a reconnect would vouch for liveness at a moment
    // that has passed — worse than never having sent it.
    expect(h.written).toEqual([])
  })

  it('bounds the outbox and says how much it dropped', () => {
    const h = harness()
    h.setOpen(false)
    for (let n = 1; n <= 6; n += 1) h.queue.send({ type: 'agent_event', n })

    expect(h.queue.heldCount()).toBe(3)
    expect(h.queue.droppedCount()).toBe(3)

    h.setOpen(true)
    h.queue.flush()
    // The oldest three survive: a run's early events are what the later ones make
    // sense against.
    expect(h.written.map((f) => f.n)).toEqual([1, 2, 3])
    expect(h.logs.some((line) => /3 frame\(s\) were dropped/.test(line))).toBe(true)
  })

  it('does nothing on a flush with nothing held', () => {
    const h = harness()
    h.queue.flush()
    expect(h.logs).toEqual([])
  })

  it('returns from awaitCapacity immediately while below the high-water mark', async () => {
    const h = harness()
    h.setBuffered(50)
    await h.queue.awaitCapacity()
    expect(h.logs).toEqual([])
  })

  it('waits for a backlog to drain, and logs that it is doing so', async () => {
    const h = harness()
    h.setBuffered(500)

    let resolved = false
    const waiting = h.queue.awaitCapacity().then(() => {
      resolved = true
    })

    // Still above the mark, so the producer must still be waiting.
    await Promise.resolve()
    expect(resolved).toBe(false)

    h.setBuffered(10)
    await waiting
    expect(resolved).toBe(true)
    expect(h.logs.some((line) => /pausing the agent loop/.test(line))).toBe(true)
  })

  it('stops waiting when the socket goes away rather than blocking for the whole disconnect', async () => {
    const h = harness()
    h.setBuffered(500)
    const waiting = h.queue.awaitCapacity()
    h.setOpen(false)
    await expect(waiting).resolves.toBeUndefined()
  })

  it('stops waiting when the Runner is shutting down', async () => {
    let stopped = false
    const h = harness({ isStopped: () => stopped })
    h.setBuffered(500)
    const waiting = h.queue.awaitCapacity()
    stopped = true
    await expect(waiting).resolves.toBeUndefined()
  })
})
