/**
 * The Runner's outbound frame queue — backpressure and disconnect handling
 *.
 *
 * Its own module, injected with plain functions rather than a `ws` instance, so
 * the mechanism can be tested without a socket. The two problems it solves are
 * genuinely different:
 *
 * - **Too fast.** An agent loop can produce events faster than a socket drains
 * them (a `Bash` call dumping a megabyte, a model streaming several turns a
 * second). `ws` buffers without limit, so the failure mode is the Runner's own
 * memory, with heartbeats stuck behind the backlog. `awaitCapacity` makes the
 * producer wait instead.
 * - **Not connected.** A frame sent while the socket is down is gone. The ones
 * worth keeping are held and replayed in order on reconnect.
 */

export interface SendQueueOptions<Frame> {
 isOpen: boolean
 /** Unsent bytes still buffered by the transport. */
 bufferedAmount: number
 write(frame: Frame): void
 /**
 * Whether a frame is worth holding through a disconnect. A late frame can be
 * worse than a dropped one — a heartbeat replayed after the fact vouches for
 * liveness at a moment that has passed — so this is a decision the caller owns.
 */
 shouldHold(frame: Frame): boolean
 highWaterBytes: number
 outboxLimit: number
 log(message: string): void
 /** Injectable so a test does not wait in real time. */
 sleep?(ms: number): Promise<void>
 /** Aborts a pending capacity wait — the Runner's shutdown flag. */
 isStopped?: boolean
}

export interface SendQueue<Frame> {
 send(frame: Frame): void
 /** Replays everything held, in order. Call once the connection is usable again. */
 flush: void
 /**
 * Resolves when the transport's backlog is below the high-water mark. Awaited by
 * whoever produces frames — that await is the backpressure, because an
 * unresolved promise stops the agent loop being pumped.
 */
 awaitCapacity: Promise<void>
 heldCount: number
 droppedCount: number
}

const DRAIN_POLL_MS = 25

export const createSendQueue = <Frame>(options: SendQueueOptions<Frame>): SendQueue<Frame> => {
 const held: Frame[] = []
 let dropped = 0
 const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
 const stopped = options.isStopped ?? ( => false)

 return {
 send(frame) {
 if (options.isOpen) {
 options.write(frame)
 return
 }
 if (!options.shouldHold(frame)) return
 if (held.length >= options.outboxLimit) {
 dropped += 1
 return
 }
 held.push(frame)
 },

 flush {
 if (held.length === 0 && dropped === 0) return
 const frames = held.splice(0, held.length)
 if (frames.length > 0) options.log(`flushing ${frames.length} frame(s) held while disconnected`)
 for (const frame of frames) options.write(frame)
 if (dropped > 0) {
 // Said out loud rather than left as a silent hole: a thread missing events
 // makes an agent look like it did less than it did.
 options.log(
 `WARNING: ${dropped} frame(s) were dropped while disconnected (outbox limit ${options.outboxLimit})`,
)
 dropped = 0
 }
 },

 async awaitCapacity {
 // Returns immediately when the socket is down: `send` holds those frames, and
 // blocking here would stall the agent loop for the whole disconnect instead of
 // letting it finish into the outbox.
 if (!options.isOpen) return
 if (options.bufferedAmount <= options.highWaterBytes) return

 options.log(
 `send buffer above ${options.highWaterBytes} bytes — pausing the agent loop until it drains`,
)
 while (options.isOpen && options.bufferedAmount > options.highWaterBytes && !stopped) {
 await sleep(DRAIN_POLL_MS)
 }
 },

 heldCount: => held.length,
 droppedCount: => dropped,
 }
}
