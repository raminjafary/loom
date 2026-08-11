import { describe, expect, it } from 'vitest'
import {
 findModelPrice,
 isPricedModel,
 modelTierRank,
 parseUsage,
 SELECTABLE_MODELS,
 usageCostUsd,
} from './model-pricing.js'

describe('findModelPrice', => {
 it('matches a bare model id', => {
 expect(findModelPrice('claude-opus-5')?.inputPerMTok).toBe(5)
 })

 it('matches a dated variant by prefix', => {
 expect(findModelPrice('claude-haiku-4-5-20251001')?.inputPerMTok).toBe(1)
 })

 it('returns null for an unknown model rather than guessing a price', => {
 expect(findModelPrice('some-open-weight-model')).toBeNull
 })
})

describe('usageCostUsd', => {
 it('prices input and output at their own rates', => {
 // 1M input at $3 + 1M output at $15 for sonnet.
 expect(
 usageCostUsd('claude-sonnet-5', {
 inputTokens: 1_000_000,
 outputTokens: 1_000_000,
 cacheReadTokens: 0,
 cacheWriteTokens: 0,
 }),
).toBeCloseTo(18)
 })

 it('discounts cache reads and surcharges cache writes', => {
 // Cache reads are a tenth of input, writes 1.25x — an agent loop re-reads a
 // large cached prefix every turn, so treating reads as full-price input
 // would overstate spend enough to trip a budget cap unfairly.
 expect(
 usageCostUsd('claude-sonnet-5', {
 inputTokens: 0,
 outputTokens: 0,
 cacheReadTokens: 1_000_000,
 cacheWriteTokens: 0,
 }),
).toBeCloseTo(0.3)
 expect(
 usageCostUsd('claude-sonnet-5', {
 inputTokens: 0,
 outputTokens: 0,
 cacheReadTokens: 0,
 cacheWriteTokens: 1_000_000,
 }),
).toBeCloseTo(3.75)
 })

 it('returns null for an unpriced model instead of a free-looking zero', => {
 expect(
 usageCostUsd('mystery-model', {
 inputTokens: 1_000_000,
 outputTokens: 0,
 cacheReadTokens: 0,
 cacheWriteTokens: 0,
 }),
).toBeNull
 })
})

describe('parseUsage', => {
 it('reads a Messages API usage block', => {
 expect(
 parseUsage({
 usage: {
 input_tokens: 12,
 output_tokens: 34,
 cache_read_input_tokens: 56,
 cache_creation_input_tokens: 78,
 },
 }),
).toEqual({ inputTokens: 12, outputTokens: 34, cacheReadTokens: 56, cacheWriteTokens: 78 })
 })

 it('counts missing or non-numeric fields as zero rather than throwing', => {
 // The proxy meters a live provider response; a renamed field must not break
 // the request it is proxying.
 expect(parseUsage({ usage: { input_tokens: 5, output_tokens: null } })).toEqual({
 inputTokens: 5,
 outputTokens: 0,
 cacheReadTokens: 0,
 cacheWriteTokens: 0,
 })
 })

 it('returns null when there is no usage block at all', => {
 expect(parseUsage({ type: 'error' })).toBeNull
 expect(parseUsage('not json')).toBeNull
 expect(parseUsage(null)).toBeNull
 })
})

describe('SELECTABLE_MODELS', => {
 /**
 * The rule that makes the picker safe rather than merely convenient: a model this
 * table cannot price cannot be metered, and a run that cannot be metered cannot
 * have its budget cap enforced.
 */
 it('offers only models that can be priced', => {
 for (const model of SELECTABLE_MODELS) {
 expect(findModelPrice(model.id)).not.toBeNull
 expect(isPricedModel(model.id)).toBe(true)
 }
 })

 it('agrees with the price table it advertises', => {
 for (const model of SELECTABLE_MODELS) {
 const price = findModelPrice(model.id)
 expect(price?.inputPerMTok).toBe(model.inputPerMTok)
 expect(price?.outputPerMTok).toBe(model.outputPerMTok)
 }
 })

 it('agrees with the tier ranking attenuation uses', => {
 for (const model of SELECTABLE_MODELS) {
 expect(modelTierRank(model.id)).toBe(model.tier)
 }
 })

 it('rejects a model nobody can price', => {
 expect(isPricedModel('gpt-imaginary')).toBe(false)
 expect(isPricedModel('')).toBe(false)
 })
})

