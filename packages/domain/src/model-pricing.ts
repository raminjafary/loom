/**
 * Cost metering inputs. Pure domain data and arithmetic so the
 * egress proxy, which is where metering actually happens, shares one price table with
 * anything else that needs to reason about spend.
 *
 * Prices are USD per million tokens, from the verified mid-2026 list.
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
 * Capability tier, ascending. Separate from price because they are separate questions: price is
 * what a call costs, tier is how much capability a run is allowed to reach for —
 * and the attenuation rule is about the latter. They happen to correlate today.
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

 const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value: 0)
 const u = usage as Record<string, unknown>
 return {
 inputTokens: num(u.input_tokens),
 outputTokens: num(u.output_tokens),
 cacheReadTokens: num(u.cache_read_input_tokens),
 cacheWriteTokens: num(u.cache_creation_input_tokens),
 }
}

/**
 * The models a human may pick for a run.
 *
 * The cost model names model choice as *the* cost swing factor — "Cursor's 8x swing came from
 * worker model choice, so it must be visible, not buried in config" — and until now
 * it was buried in config: the only way to run `swe` on Opus instead of Haiku was to
 * edit the persona, which changed it for everyone and every future run.
 *
 * The list is exactly the models this table can price, and that is a rule rather than
 * a coincidence: an unpriced model cannot be metered, and a run that cannot be metered
 * cannot have its budget cap enforced. So an unknown id is refused at run
 * start rather than discovered when the cap silently fails to bite.
 */
export interface SelectableModel {
 readonly id: string
 readonly label: string
 /** Ascending capability, from `modelTierRank`. */
 readonly tier: number
 readonly inputPerMTok: number
 readonly outputPerMTok: number
}

export const SELECTABLE_MODELS: readonly SelectableModel[] = [
 { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', tier: 1, inputPerMTok: 1, outputPerMTok: 5 },
 { id: 'claude-sonnet-5', label: 'Sonnet 5', tier: 2, inputPerMTok: 3, outputPerMTok: 15 },
 { id: 'claude-opus-5', label: 'Opus 5', tier: 3, inputPerMTok: 5, outputPerMTok: 25 },
 { id: 'claude-fable-5', label: 'Fable 5', tier: 4, inputPerMTok: 10, outputPerMTok: 50 },
]

/** Whether spend on this model can actually be metered, which is what makes it usable. */
export const isPricedModel = (model: string): boolean => findModelPrice(model) !== null
