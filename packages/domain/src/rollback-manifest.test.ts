import { describe, expect, it } from 'vitest'
import {
 compareToManifest,
 validateManifest,
 type ManifestCheck,
 type RollbackManifest,
} from './rollback-manifest.js'

/**
 * The previously-passing manifest.
 *
 * The tests that matter are about the ways a manifest stops being able to fail: a check that
 * quietly disappeared, an empty manifest that passes by construction, and a recovery judged on
 * "nothing fails now" — which a revert that deleted the checks would satisfy.
 */

const check = (name: string, status: 'passed' | 'failed' = 'passed'): ManifestCheck => ({
 name,
 status,
 detail: null,
})

const manifest = (checks: readonly ManifestCheck[]): RollbackManifest => ({
 commit: 'abcdef1234567890',
 recordedAt: new Date(0),
 checks,
})

describe('compareToManifest', => {
 it('holds when everything that passed passes again', => {
 const verdict = compareToManifest(manifest([check('suite'), check('boundary')]), [
 check('boundary'),
 check('suite'),
 ])
 expect(verdict.recovered).toBe(true)
 expect(verdict.regressions).toEqual([])
 expect(verdict.entries.map((entry) => entry.kind)).toEqual(['held', 'held'])
 })

 it('names the check that regressed, rather than reporting a count', => {
 const verdict = compareToManifest(manifest([check('suite'), check('boundary')]), [
 check('suite'),
 check('boundary', 'failed'),
 ])
 expect(verdict.recovered).toBe(false)
 expect(verdict.regressions.map((entry) => entry.name)).toEqual(['boundary'])
 expect(verdict.detail).toContain('boundary')
 })

 it('treats a check that no longer runs as a regression, and says it did not run', => {
 // The failure this repository has actually shipped: a modification that deletes the check
 // which would have caught it. A comparison over only the checks it was handed passes that.
 const verdict = compareToManifest(manifest([check('suite'), check('boundary')]), [
 check('suite'),
 ])
 expect(verdict.recovered).toBe(false)
 expect(verdict.regressions[0]).toMatchObject({ name: 'boundary', kind: 'missing', now: null })
 expect(verdict.detail).toContain('did not run')
 })

 it('does not count a check that was already failing as a regression', => {
 const verdict = compareToManifest(manifest([check('suite'), check('flaky', 'failed')]), [
 check('suite'),
 check('flaky', 'failed'),
 ])
 expect(verdict.recovered).toBe(true)
 expect(verdict.entries[1]?.kind).toBe('still-failing')
 // Said out loud, so a reader does not read "recovered" as "everything passes".
 expect(verdict.detail).toContain('already failing')
 })

 it('reports a check that started passing without calling it a recovery target', => {
 const verdict = compareToManifest(manifest([check('suite'), check('flaky', 'failed')]), [
 check('suite'),
 check('flaky'),
 ])
 expect(verdict.recovered).toBe(true)
 expect(verdict.entries[1]?.kind).toBe('fixed')
 expect(verdict.detail).toContain('now pass')
 })

 it('reports a check the manifest never held, so a drill cannot quietly grow its scope', => {
 const verdict = compareToManifest(manifest([check('suite')]), [check('suite'), check('extra')])
 expect(verdict.entries.map((entry) => entry.kind)).toEqual(['held', 'new'])
 expect(verdict.recovered).toBe(true)
 })

 it('is not satisfied by a recovery that deleted the checks', => {
 // "Nothing fails now" is the wrong question, and this is the case that separates them.
 const verdict = compareToManifest(manifest([check('suite'), check('boundary')]), [])
 expect(verdict.entries.every((entry) => entry.now !== 'failed')).toBe(true)
 expect(verdict.recovered).toBe(false)
 })

 it('orders its report deterministically, so two runs can be diffed', => {
 const recorded = manifest([check('b'), check('a')])
 const first = compareToManifest(recorded, [check('a'), check('b'), check('z'), check('y')])
 const second = compareToManifest(recorded, [check('y'), check('z'), check('b'), check('a')])
 expect(first.entries.map((entry) => entry.name)).toEqual(second.entries.map((entry) => entry.name))
 // The manifest's own order first, then anything new by name.
 expect(first.entries.map((entry) => entry.name)).toEqual(['b', 'a', 'y', 'z'])
 })

 it('names the commit the manifest was taken at, short', => {
 const verdict = compareToManifest(manifest([check('suite')]), [check('suite')])
 expect(verdict.detail).toContain('abcdef123456')
 })
})

describe('validateManifest', => {
 it('accepts a manifest with a commit and something that passed', => {
 expect(validateManifest({ commit: 'abc', checks: [check('suite')] })).toEqual({ ok: true })
 })

 it('refuses an empty one, which would make the drill pass by construction', => {
 const verdict = validateManifest({ commit: 'abc', checks: [] })
 expect(verdict).toMatchObject({ ok: false, rule: 'empty' })
 })

 it('refuses one where nothing passed — there is nothing to regress or restore', => {
 const verdict = validateManifest({ commit: 'abc', checks: [check('suite', 'failed')] })
 expect(verdict).toMatchObject({ ok: false, rule: 'nothing-passed' })
 })

 it('refuses two checks with one name, because a comparison would read the last', => {
 const verdict = validateManifest({ commit: 'abc', checks: [check('suite'), check('suite')] })
 expect(verdict).toMatchObject({ ok: false, rule: 'duplicate-name' })
 })

 it('refuses one with no commit, since the commit is what pins the recovering process', => {
 const verdict = validateManifest({ commit: ' ', checks: [check('suite')] })
 expect(verdict).toMatchObject({ ok: false, rule: 'no-commit' })
 })
})
