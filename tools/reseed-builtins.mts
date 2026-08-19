/**
 * Converges a workspace's built-in persona rows back onto their shipped definitions
 * (`packages/domain/src/builtin-personas.ts`).
 *
 *   npx tsx tools/reseed-builtins.mts            # show the drift, change nothing
 *   npx tsx tools/reseed-builtins.mts --apply    # write it
 *
 * **Why this has to exist.** `seedBuiltinPersonas` inserts by name and never upserts,
 * and that is deliberate: these are real, editable `agent_persona` rows, and an
 * operator who has tuned the `swe` prompt must not have it reverted every time the
 * server restarts. The cost of that choice is that a built-in created before a field
 * existed keeps its old value *forever*, with nothing anywhere reporting the drift.
 *
 * That is not hypothetical. A dev workspace seeded before `DEFAULT_BUDGET_CAP_USD`
 * landed still had `null` caps months later, and a handoff read those rows, concluded
 * the shipped seed was uncapped, and recorded it as the top priority to fix. The seed
 * had been correct the whole time. A diff against the source is the thing that was
 * missing.
 *
 * Deliberately not a server procedure and not automatic. Reverting an operator's
 * edits is exactly what the seed refuses to do silently, so this is a tool a human
 * runs, printing what it would change before it changes anything. Personas that are
 * not built-ins are never touched.
 */
import { loadConfig } from '../apps/server/src/config.js'
import { createDatabase, ensureWorkspace, personaRepository } from '../packages/db/src/index.js'
import { BUILTIN_PERSONAS, asAgentPersonaId, asWorkspaceId } from '../packages/domain/src/index.js'

const apply = process.argv.includes('--apply')

// Same shape as the other tools in here: the real `DATABASE_URL` from the
// environment (or config.ts's dev default), and a throwaway auth secret, because
// this touches the database directly and never stands up the server.
const config = loadConfig({
  ...process.env,
  BETTER_AUTH_SECRET: 'reseed-tool-secret-at-least-32-characters-long',
} as NodeJS.ProcessEnv)
const { db, close } = createDatabase(config.DATABASE_URL)

/** Only the fields the seed owns. `id`, `workspace_id` and timestamps are never touched. */
const shippedFields = (persona: (typeof BUILTIN_PERSONAS)[number]) => ({
  description: persona.description,
  markdownSource: persona.markdownSource,
  model: persona.model,
  tools: persona.tools,
  harnessEffort: persona.harnessEffort,
  harnessMaxTurns: persona.harnessMaxTurns,
  harnessApprovalMode: persona.harnessApprovalMode,
  harnessPlanner: persona.harnessPlanner,
  harnessDelegates: persona.harnessDelegates,
  harnessBudgetCapUsd: persona.harnessBudgetCapUsd,
  /**
   * The ceiling, which is `null` on every shipped built-in — and sending it matters
   * precisely because of that: an operator who granted a built-in an envelope by hand has
   * made it a persona the platform no longer ships, and reseeding is the act that says
   * "take the shipped one". Omitting the field would leave the grant standing on a
   * persona whose prompt had just been replaced underneath it.
   */
  envelope: persona.envelope,
})

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

try {
  // The existing workspace, not a new one: `ensureWorkspace` returns the row when the
  // slug is already there, and these are the defaults `app.ts` resolves against.
  const { id } = await ensureWorkspace(db, 'dev', 'Dev Workspace')
  const workspaceId = asWorkspaceId(id)
  const personas = personaRepository(db)
  const existing = await personas.listByWorkspace(workspaceId)
  const byName = new Map(existing.map((row) => [row.name, row]))

  let drifted = 0
  let missing = 0

  for (const persona of BUILTIN_PERSONAS) {
    const row = byName.get(persona.name)
    if (!row) {
      // Left to the seed rather than inserted here: it runs on the next auth
      // resolution and already knows how to create one correctly.
      missing += 1
      console.log(`${persona.name}: absent — the server will seed it on next login`)
      continue
    }

    const shipped = shippedFields(persona)
    const changed = Object.entries(shipped).filter(
      ([field, value]) => !same(value, (row as unknown as Record<string, unknown>)[field]),
    )
    if (changed.length === 0) continue

    drifted += 1
    console.log(`\n${persona.name}`)
    for (const [field, value] of changed) {
      const current = (row as unknown as Record<string, unknown>)[field]
      // Prompts are long; report that they differ rather than printing both.
      const render = (v: unknown) =>
        field === 'markdownSource' ? `<${String(v).length} chars>` : JSON.stringify(v)
      console.log(`  ${field}: ${render(current)} -> ${render(value)}`)
    }

    if (apply) await personas.update(workspaceId, asAgentPersonaId(row.id), shipped)
  }

  if (drifted === 0 && missing === 0) {
    console.log('Every built-in matches its shipped definition.')
  } else if (apply) {
    console.log(`\nApplied to ${drifted} persona(s).`)
  } else {
    console.log(`\n${drifted} persona(s) differ. Re-run with --apply to write them.`)
  }
} finally {
  await close()
}
