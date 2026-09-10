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

  /**
   * Every run-shaping field the container's start frame can carry is passed at the one call
   * site that builds it.
   *
   * A sandboxed designer shipped without `designWorkflow` for exactly this reason. The frame
   * builder in `sandbox.ts` read it, the container knew what to do with it, and the call in
   * `client.ts` simply did not pass it — so the run was handed the *planner* tool instead of
   * `submit_workflow_design` and asked a human why the tool its brief named did not exist.
   *
   * Nothing could have failed. Each field is an optional spread on both sides, so omitting one
   * is not a type error anywhere along the path, and no unit test reaches this call: it is the
   * seam between a Runner and a container. The symptom is a run that completes looking normal
   * with one channel silently absent — which is the same failure mode the frame builder's own
   * comment warns about, one layer up from where it was written.
   */
  it('every field the sandbox start frame carries is passed where the sandbox is started', () => {
    const sandbox = readFileSync(join(ROOT, 'apps/runner/src/sandbox.ts'), 'utf8')
    const client = readFileSync(join(ROOT, 'apps/runner/src/client.ts'), 'utf8')

    const frame = sandbox.slice(sandbox.indexOf('const sendStart = () => {'))
    const carried = [...frame.slice(0, frame.indexOf('cwd: WORK_DIR')).matchAll(/options\.(\w+) === undefined/g)]
      .map((match) => match[1] as string)
    // Guards the guard: an extraction that finds nothing would pass this test forever.
    expect(carried).toContain('designWorkflow')
    expect(carried.length).toBeGreaterThan(5)

    const call = client.slice(client.indexOf('await runAgentInSandbox(sandbox, {'))
    const passed = call.slice(0, call.indexOf('\n    })'))
    expect(carried.filter((field) => !passed.includes(`input.${field}`))).toEqual([])
  })

  it('flags infrastructure leaking into inner layers', () => {
    // Guards the guard: if isInfra() stops matching, the checks above silently pass.
    expect(isInfra('drizzle-orm')).toBe(true)
    expect(isInfra('@orpc/server')).toBe(true)
    expect(isInfra('@loom/domain')).toBe(false)
  })

  /**
   * Every design token a component reaches for is one the design system declares.
   *
   * `var(--panel, #16181d)` looks like a themed value and is not one: the token was never
   * declared, so every render took the literal — which had been written for the dark theme.
   * In light mode that put `#16161a` text on a `#16181d` background, a contrast ratio of
   * about 1.02, and the *selected* view tab was therefore unreadable in the default theme.
   * It shipped because in dark mode the accident looks correct, and because a component
   * test asserts the class is on the element rather than what colour it came out.
   *
   * Seven such tokens were in use when this check was written, and two of the fallbacks
   * disagreed with each other about which theme they were for — the same `--line` was
   * `#2a2a2a` in one component and `#e2e5ea` in another. A fallback is a reasonable thing
   * to write; a fallback that is the only value that ever applies is a hard-coded colour
   * wearing a token's name.
   */
  it('every CSS variable a component uses is declared by the design system', () => {
    const declared = (text: string) =>
      new Set([...text.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1] as string))
    const system = declared(readFileSync(join(ROOT, 'apps/web/src/styles.css'), 'utf8'))
    // Guards the guard: an empty set would make every component pass.
    expect(system.size).toBeGreaterThan(10)

    const components = join(ROOT, 'apps/web/src/components')
    const undeclared: string[] = []
    for (const file of readdirSync(components).filter((name) => name.endsWith('.vue'))) {
      const text = readFileSync(join(components, file), 'utf8')
      const local = declared(text)
      for (const match of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
        const token = match[1] as string
        if (!system.has(token) && !local.has(token)) undeclared.push(`${file}: ${token}`)
      }
    }
    expect(undeclared).toEqual([])
  })
})
