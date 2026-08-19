/**
 * The models a client may offer for a run.
 *
 * Duplicated from `@loom/domain`'s `SELECTABLE_MODELS` rather than imported, for the
 * reason the response-style enum is duplicated into the wire contract: a client
 * depends on the contract, never on the domain. The authority stays server-side —
 * `startAgentRun` refuses any model it cannot price, so a stale list here produces a
 * clear rejection rather than an unmetered run.
 */
export interface SelectableModel {
  readonly id: string
  readonly label: string
  /** USD per million input tokens. */
  readonly inputPerMTok: number
  /** USD per million output tokens. */
  readonly outputPerMTok: number
}

export const SELECTABLE_MODELS: readonly SelectableModel[] = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', inputPerMTok: 1, outputPerMTok: 5 },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', inputPerMTok: 3, outputPerMTok: 15 },
  { id: 'claude-opus-5', label: 'Opus 5', inputPerMTok: 5, outputPerMTok: 25 },
  { id: 'claude-fable-5', label: 'Fable 5', inputPerMTok: 10, outputPerMTok: 50 },
]

/** The priced entry a model id falls under, by longest matching prefix. */
export const findSelectableModel = (model: string): SelectableModel | null => {
  let best: SelectableModel | null = null
  for (const entry of SELECTABLE_MODELS) {
    if (!model.startsWith(entry.id)) continue
    if (best === null || entry.id.length > best.id.length) best = entry
  }
  return best
}
