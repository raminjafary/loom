import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Belt-and-braces companion to the ESLint boundary rule (PLAN.md §4a).
 * ESLint can be disabled inline; this cannot be, and it fails CI loudly.
 */

const ROOT = new URL('..', import.meta.url).pathname

const collectTs = (dir: string): string[] => {
  let out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue
      out = out.concat(collectTs(full))
    } else if (entry.endsWith('.ts') || entry.endsWith('.vue')) {
      out.push(full)
    }
  }
  return out
}

const importedModules = (source: string): string[] => {
  const specifiers: string[] = []
  const patterns = [
    /import\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) specifiers.push(specifier)
    }
  }
  return specifiers
}

const INFRA = [
  'drizzle-orm',
  'postgres',
  'pg',
  'ioredis',
  'bullmq',
  'fastify',
  '@fastify/',
  '@orpc/',
  'better-auth',
  'vue',
  'pinia',
  'vite',
]

const isInfra = (specifier: string): boolean =>
  INFRA.some((infra) => specifier === infra || specifier.startsWith(`${infra}/`) || specifier.startsWith(infra) && infra.endsWith('/'))

const isRelative = (specifier: string): boolean => specifier.startsWith('.')
const isNodeBuiltin = (specifier: string): boolean => specifier.startsWith('node:')

describe('architectural boundaries', () => {
  it('domain has zero dependencies — no infrastructure, no sibling packages', () => {
    const violations: string[] = []
    for (const file of collectTs(join(ROOT, 'packages/domain/src'))) {
      for (const specifier of importedModules(readFileSync(file, 'utf8'))) {
        if (isRelative(specifier) || isNodeBuiltin(specifier)) continue
        if (file.endsWith('.test.ts') && specifier === 'vitest') continue
        violations.push(`${file.replace(ROOT, '')} imports ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('application depends only on @loom/domain and its own ports', () => {
    const violations: string[] = []
    for (const file of collectTs(join(ROOT, 'packages/application/src'))) {
      for (const specifier of importedModules(readFileSync(file, 'utf8'))) {
        if (isRelative(specifier) || isNodeBuiltin(specifier)) continue
        if (specifier === '@loom/domain') continue
        if (file.endsWith('.test.ts') && specifier === 'vitest') continue
        violations.push(`${file.replace(ROOT, '')} imports ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('no persistence type crosses the contract boundary', () => {
    const violations: string[] = []
    for (const file of collectTs(join(ROOT, 'packages/api-contract/src'))) {
      for (const specifier of importedModules(readFileSync(file, 'utf8'))) {
        if (specifier === '@loom/db' || specifier.startsWith('drizzle-orm')) {
          violations.push(`${file.replace(ROOT, '')} imports ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('flags infrastructure leaking into inner layers', () => {
    // Guards the guard: if isInfra() stops matching, the checks above silently pass.
    expect(isInfra('drizzle-orm')).toBe(true)
    expect(isInfra('@orpc/server')).toBe(true)
    expect(isInfra('@loom/domain')).toBe(false)
  })
})
