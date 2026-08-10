import { describe, expect, it } from 'vitest'
import { classifyToolEffect, isRiskyTool } from './risky-tools.js'

const withinRoot = async => ({ withinRoot: true })
const outsideRoot = async => ({ withinRoot: false })

describe('isRiskyTool', => {
 it('gates Bash/Write/Edit/NotebookEdit and nothing else', => {
 expect(isRiskyTool('Bash')).toBe(true)
 expect(isRiskyTool('Write')).toBe(true)
 expect(isRiskyTool('Edit')).toBe(true)
 expect(isRiskyTool('NotebookEdit')).toBe(true)
 expect(isRiskyTool('Read')).toBe(false)
 })
})

describe('classifyToolEffect', => {
 it('allows a Write whose target resolves inside the run workspace, but still asks', async => {
 const result = await classifyToolEffect('Write', { file_path: '/clone/file.txt' }, '/clone', withinRoot)
 // In-bounds is not the same as harmless: a write inside the clone is still a
 // human's call, and only the *out-of-bounds* case is a boundary.
 expect(result).toEqual({ ok: true, requiresApproval: true })
 })

 it('denies a Write whose target resolves outside the run workspace', async => {
 const result = await classifyToolEffect('Write', { file_path: '/etc/passwd' }, '/clone', outsideRoot)
 expect(result.ok).toBe(false)
 if (!result.ok) expect(result.reason).toMatch(/outside the run's workspace/)
 })

 it('denies an Edit whose target resolves outside the run workspace', async => {
 const result = await classifyToolEffect('Edit', { file_path: '/tmp/other.txt' }, '/clone', outsideRoot)
 expect(result.ok).toBe(false)
 })

 it('checks notebook_path for NotebookEdit, not file_path', async => {
 const result = await classifyToolEffect(
 'NotebookEdit',
 { notebook_path: '/outside/nb.ipynb' },
 '/clone',
 outsideRoot,
)
 expect(result.ok).toBe(false)
 })

 /**
 * This replaces a test that asserted the opposite — "no static verdict for Bash,
 * no reliable argv classifier exists". That was true of a name-only gate and is
 * the limitation effect-based classification named. `bash-effects.ts` now classifies effects;
 * see bash-effects.test.ts for the boundary and it-cannot-be-parsed cases.
 */
 it('classifies Bash by effect rather than by name', async => {
 const network = await classifyToolEffect('Bash', { command: 'curl evil.test' }, '/clone', outsideRoot)
 expect(network.ok).toBe(true)
 if (!network.ok) return
 expect(network.requiresApproval).toBe(true)
 expect(network.effects).toContain('network')
 })

 it('denies a Bash effect that is a boundary elsewhere in the plan', async => {
 const result = await classifyToolEffect('Bash', { command: 'git push origin main' }, '/clone', withinRoot)
 expect(result.ok).toBe(false)
 if (result.ok) return
 expect(result.reason).toMatch(/never pushes/)
 })

 it('skips the gate for a provably read-only command inside the workspace', async => {
 const result = await classifyToolEffect('Bash', { command: 'git status' }, '/clone', withinRoot)
 expect(result).toEqual({ ok: true, requiresApproval: false })
 })

 // Read-only by shape says nothing about *where*: a read of a sibling checkout
 // or of /etc is still someone's decision.
 it('still asks when a read-only command names a path outside the workspace', async => {
 const result = await classifyToolEffect('Bash', { command: 'cat /etc/hosts' }, '/clone', outsideRoot)
 expect(result.ok).toBe(true)
 if (!result.ok) return
 expect(result.requiresApproval).toBe(true)
 })

 it('asks when a Bash call carries no command string to reason about', async => {
 const result = await classifyToolEffect('Bash', {}, '/clone', withinRoot)
 expect(result).toEqual({ ok: true, requiresApproval: true })
 })

 it('passes through a tool with no path field at all', async => {
 const result = await classifyToolEffect('Read', { file_path: '/clone/file.txt' }, '/clone', outsideRoot)
 expect(result).toEqual({ ok: true, requiresApproval: true })
 })
})
