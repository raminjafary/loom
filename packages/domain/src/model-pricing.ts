/**
 * Cost metering inputs (PLAN.md §9). Pure domain data and arithmetic so the
 * egress proxy, which is where metering actually happens (§6 A6 — "metered at
 * the proxy rather than from model self-report"), shares one price table with
 * anything else that needs to reason about spend.
 *
 * Prices are USD per million tokens, from PLAN.md §8's verified mid-2026 list.
 * They are deliberately a hardcoded table rather than fetched: a wrong price
 * silently under-reports spend, and a table in version control is reviewable.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  readonly inputPerMTok: number
  /** USD per million output tokens. */
  readonly outputPerMTok: number
  /**
   * USD per million tokens read from the prompt cache. Anthropic bills cache
   * reads at a tenth of the input rate, and agent loops re-read a large cached
   * prefix on every turn — charging those at the full input rate overstates
   * spend enough to trip a budget cap on work that never cost that much.
   */
  readonly cacheReadPerMTok: number
  /** USD per million tokens written to the prompt cache (1.25x input). */
  readonly cacheWritePerMTok: number
}

const price = (inputPerMTok: number, outputPerMTok: number): ModelPrice => ({
  inputPerMTok,
  outputPerMTok,
  cacheReadPerMTok: inputPerMTok * 0.1,
  cacheWritePerMTok: inputPerMTok * 1.25,
})

/**
 * Keyed by model id prefix, longest match wins — provider ids carry date and
 * variant suffixes (`claude-haiku-4-5-20251001`) that must not each need their
 * own row.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5': price(10, 50),
  'claude-opus-5': price(5, 25),
  'claude-sonnet-5': price(3, 15),
  'claude-haiku-4-5': price(1, 5),
}

export const findModelPrice = (model: string): ModelPrice | null => {
  let best: { prefix: string; price: ModelPrice } | null = null
  for (const [prefix, value] of Object.entries(MODEL_PRICES)) {
    if (!model.startsWith(prefix)) continue
    if (best === null || prefix.length > best.prefix.length) best = { prefix, price: value }
  }
  return best?.price ?? null
}

/**
 * Capability tier, ascending (PLAN.md §8's model list, §9's Planner/Worker
 * tiering). Separate from price because they are separate questions: price is
 * what a call costs, tier is how much capability a run is allowed to reach for —
 * and §5's attenuation rule is about the latter. They happen to correlate today.
 *
 * Same longest-prefix matching as `MODEL_PRICES`, for the same reason: provider
 * ids carry date and variant suffixes.
 */
const MODEL_TIERS: Readonly<Record<string, number>> = {
  'claude-haiku-4-5': 1,
  'claude-sonnet-5': 2,
  'claude-opus-5': 3,
  'claude-fable-5': 4,
}

/** Null for a model this table does not rank — see attenuateChildPersona on why that is not "allowed". */
export const modelTierRank = (model: string): number | null => {
  let best: { prefix: string; rank: number } | null = null
  for (const [prefix, rank] of Object.entries(MODEL_TIERS)) {
    if (!model.startsWith(prefix)) continue
    if (best === null || prefix.length > best.prefix.length) best = { prefix, rank }
  }
  return best?.rank ?? null
}

export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/**
 * Returns null for an unpriced model rather than 0. A zero would read as "this
 * call was free" and let an unknown model spend without limit under a budget
 * cap; null forces the caller to decide what an unmeterable call means.
 */
export const usageCostUsd = (model: string, usage: TokenUsage): number | null => {
  const p = findModelPrice(model)
  if (!p) return null
  return (
    (usage.inputTokens * p.inputPerMTok +
      usage.outputTokens * p.outputPerMTok +
      usage.cacheReadTokens * p.cacheReadPerMTok +
      usage.cacheWriteTokens * p.cacheWritePerMTok) /
    1_000_000
  )
}

/**
 * Reads a `usage` block off a Messages API response body. Tolerant by design:
 * the proxy meters a live provider response, so an unexpected or renamed field
 * must degrade to "counted as zero for that field" rather than throw and break
 * the request it is proxying.
 */
export const parseUsage = (body: unknown): TokenUsage | null => {
  if (typeof body !== 'object' || body === null) return null
  const usage = (body as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return null

  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const u = usage as Record<string, unknown>
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  }
}
