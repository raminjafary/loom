import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Belt-and-braces companion to the ESLint boundary rule.
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

/**
 * The specifiers a file imports.
 *
 * **Anchored at the start of a line, deliberately.** Unanchored, the side-effect-import
 * pattern matches the word "import" inside any string: `label: 'dynamic import', provenance:
 * 'ambiguous'` in `subject-map.test.ts` read as importing `, provenance: `, and this test had
 * been failing on it — so the boundary guard was reporting a violation that did not exist and
 * could no longer tell anyone about one that did. A check that always fails guards nothing,
 * which is the same failure as a check that always passes and harder to notice.
 *
 * `export … from` is included because a re-export is an import with the dependency intact:
 * `index.ts` files here are almost entirely re-exports, and a package's public surface is
 * exactly where a vendor type would cross a port boundary.
 */
export const importedModules = (source: string): string[] => {
  const specifiers: string[] = []
  /**
   * Comments are stripped first, and the clause between `import` and `from` may hold only
   * what an import clause holds — identifiers, braces, commas, `*`, whitespace.
   *
   * Both restrictions are there because of a specific way this test lied. `[^'"]*?` spans
   * newlines, so `export interface Port {` matched an unrelated `from "…"` inside a doc
   * comment 200 lines further down (`ports.ts` — *"configured but you haven't subscribed"*),
   * and the guard reported `packages/application/src/ports.ts imports configured but you
   * haven`. A clause that cannot contain a colon or a bracket cannot reach across a
   * declaration, and a comment that no longer exists cannot supply the `from`.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const patterns = [
    /^\s*import\s+[\w${}*,\s]*?from\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /^\s*export\s+[\w${}*,\s]*?from\s*['"]([^'"]+)['"]/gm,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
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
  /**
   * The extractor, tested, because the rest of this file is only as good as it is — and it
   * spent an unknown number of sessions reporting a violation nobody had written.
   */
  describe('importedModules', () => {
    it('finds every form a dependency actually arrives in', () => {
      expect(
        importedModules(
          [
            "import { a } from 'drizzle-orm'",
            "import 'fastify'",
            "import type { B } from './local.js'",
            'import {',
            '  c,',
            "} from '@loom/domain'",
            "export * from './index.js'",
            "export { d } from 'vue'",
            "const e = require('ioredis')",
          ].join('\n'),
        ),
      ).toEqual([
        'drizzle-orm',
        './local.js',
        '@loom/domain',
        'fastify',
        './index.js',
        'vue',
        'ioredis',
      ])
    })

    it('does not read the word "import" inside a string as one', () => {
      expect(
        importedModules("  { label: 'dynamic import', provenance: 'ambiguous' },"),
      ).toEqual([])
    })
  })

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
