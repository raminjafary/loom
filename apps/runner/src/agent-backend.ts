import { runAgent, type RunAgentOptions } from './claude-agent-adapter.js'
import { runChatCompletionsAgent, usesChatCompletions } from './chat-completions-adapter.js'

/**
 * The execution port's one dispatch point.
 *
 * The port has been enforced since Phase 1 — the boundary guard fails a build that reaches
 * around it — and exactly one adapter had ever been driven through it, which made the
 * replaceability claim architectural rather than demonstrated. This file is the seam where a
 * second one becomes real, and it is deliberately three lines of logic: anything cleverer
 * would be a scheduler, and which backend runs a persona is not a scheduling decision.
 *
 * **The key is the persona's model id, not a flag on the call.** A prefix in the document
 * travels with every snapshot of it, so which backend a run used is readable from the row
 * months later — which is exactly the question a cross-model comparison asks, and exactly
 * what a dispatch-time flag would fail to answer.
 */
export const backendFor = (model: string): 'claude' | 'chat-completions' =>
  usesChatCompletions(model) ? 'chat-completions' : 'claude'

export const runAgentOnBackend = async (options: RunAgentOptions): Promise<void> =>
  backendFor(options.persona.model) === 'chat-completions'
    ? runChatCompletionsAgent(options)
    : runAgent(options)
