/**
 * A persona crossing a real workspace boundary — two workspaces, two servers, one document.
 *
 *   docker compose up -d postgres valkey
 *   npx tsx tools/persona-share-check.mts
 *
 * Zero tokens: nothing here starts a run. What it settles is the part a unit test cannot,
 * because the whole claim is about a boundary the platform enforces with a `workspace_id` on
 * every row. Two servers are built over two seeded workspaces, each with its own principal, and
 * the bundle is carried between them the way an operator would carry it — as text.
 *
 * Six things only a live pass can settle:
 *
 * 1. The exported document is what the source workspace stores, byte for byte, and the digest
 *    over it matches.
 * 2. The adopting workspace ends up with the *same document*, so the personas are the same
 *    persona and not two hand-copies that will drift.
 * 3. The envelope survives — the ceiling a human set is the ceiling that arrives.
 * 4. **Nothing local travels.** A capability attached in the source workspace is not attached
 *    to the adopted persona: what arrives is narrower than what left, which is the property
 *    that makes adopting somebody else's persona bounded.
 * 5. The provenance sentence is on the row and on the wire, and says it is a claim.
 * 6. Every refusal an operator can actually hit is refused, over real HTTP: a name already in
 *    use, a truncated paste, a document whose persona does not fit its own envelope.
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { buildApp, devAuth } from '../apps/server/src/index.js'
import { loadConfig } from '../apps/server/src/config.js'
import { createDatabase, seedWorkspace } from '../packages/db/src/index.js'

const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'persona-share-secret-at-least-32-characters',
  WS_SUBSCRIPTION_SECRET: 'persona-share-subscription-secret-32-ch',
  SERVER_PORT: '0',
} as NodeJS.ProcessEnv)

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const DOCUMENT = [
  '---',
  'name: share-check-reviewer',
  'description: Checks work it did not do.',
  'model: claude-haiku-4-5-20251001',
  'tools: [Read, Grep]',
  'harness:',
  '  approvalMode: ask',
  '  budgetCapUsd: 0.5',
  'envelope:',
  '  tools: [Read, Grep, Glob]',
  '  budgetCapUsd: 1',
  '---',
  '',
  'You review work you did not do. Say what is wrong, not what is fine.',
].join('\n')

const main = async () => {
  const { db, close: closeDb } = createDatabase(config.DATABASE_URL)
  const source = await seedWorkspace(db, `share-source-${Date.now()}`)
  const target = await seedWorkspace(db, `share-target-${Date.now()}`)

  /** Two servers, because a principal belongs to one workspace — which is the boundary. */
  const serve = async (workspaceId: string, userId: string) => {
    const app = await buildApp(config, devAuth({ userId, workspaceId }))
    await app.fastify.listen({ port: 0, host: '127.0.0.1' })
    const address = app.fastify.server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const client: any = createORPCClient(
      new RPCLink({ url: `http://127.0.0.1:${address.port}/rpc` }),
    )
    return { app, client }
  }

  const theirs = await serve(source.id, 'share-source-user')
  const mine = await serve(target.id, 'share-target-user')

  console.log('— a persona is written in one workspace —')
  const written = await theirs.client.persona.create({ markdownSource: DOCUMENT })
  check('it was written', written.id !== undefined, written.name)
  /**
   * A capability attached to it, so "nothing local travels" is a claim with something to
   * travel. A skill rather than an MCP server: it needs no process to exist.
   */
  const skill = await theirs.client.capability.register({
    kind: 'skill',
    name: 'share-check-skill',
    description: 'Prefer small diffs.',
    content: 'Prefer small diffs.',
  })
  await theirs.client.capability.attach({ personaId: written.id, capabilityId: skill.id })
  const attachedThere = await theirs.client.capability.listAttachments()
  check(
    'with a capability attached to it in the source workspace',
    attachedThere.some((entry: any) => entry.personaId === written.id),
    `${attachedThere.length} attachment(s)`,
  )

  console.log('\n— exported as a bundle —')
  const exported = await theirs.client.persona.exportOne({ personaId: written.id })
  check('the bundle carries a digest', String(exported.digest).startsWith('sha256:'), exported.digest)
  const parsed = JSON.parse(exported.text) as { document: string; origin: { workspace: string } }
  check(
    'and the document is what the source workspace stores, byte for byte',
    parsed.document === written.markdownSource,
    `${parsed.document.length} vs ${String(written.markdownSource).length} chars`,
  )

  console.log('\n— adopted by the other workspace —')
  const adopted = await mine.client.persona.adopt({ bundleText: exported.text })
  check(
    'the adopted persona has the same document, so the two cannot drift apart',
    adopted.persona.markdownSource === written.markdownSource,
  )
  check(
    'the ceiling a human set is the ceiling that arrived',
    JSON.stringify(adopted.persona.envelope) === JSON.stringify(written.envelope),
    JSON.stringify(adopted.persona.envelope),
  )
  check(
    'the provenance is on the row, and says it is a claim',
    String(adopted.persona.adoptedFrom).includes('claimed to come from') &&
      String(adopted.persona.adoptedFrom).includes('Nothing signs a bundle'),
    String(adopted.persona.adoptedFrom).slice(0, 140),
  )
  check(
    'and the same sentence comes back to whoever adopted it, rather than only being stored',
    adopted.provenance === adopted.persona.adoptedFrom,
  )
  /**
   * The property that makes this bounded: a capability is a workspace-owned row an operator
   * attached deliberately, so it cannot arrive with a document. What lands is narrower.
   */
  const attachedHere = await mine.client.capability.listAttachments()
  check(
    'no capability travelled with it — what arrived is narrower than what left',
    attachedHere.filter((entry: any) => entry.personaId === adopted.persona.id).length === 0,
    `${attachedHere.length} attachment(s) in the adopting workspace`,
  )
  check(
    'and the capability itself did not either: it is a row its own workspace owns',
    (await mine.client.capability.list()).every((entry: any) => entry.name !== 'share-check-skill'),
  )
  const local = await mine.client.persona.list()
  check(
    'and it is an ordinary persona in the adopting workspace',
    local.some((persona: any) => persona.id === adopted.persona.id),
    `${local.length} persona(s)`,
  )

  console.log('\n— the refusals an operator can actually hit —')
  const twice = await mine.client.persona
    .adopt({ bundleText: exported.text })
    .then(() => null)
    .catch((error: unknown) => String((error as { message?: string }).message ?? error))
  check(
    'adopting it twice is refused, and says to rename rather than replace',
    twice !== null && twice.includes('another name'),
    twice ?? 'it was adopted twice',
  )
  const renamed = await mine.client.persona.adopt({
    bundleText: exported.text,
    as: 'share-check-reviewer-theirs',
  })
  check(
    'under another name it is adopted, and the document says the new name too',
    renamed.persona.name === 'share-check-reviewer-theirs' &&
      renamed.persona.markdownSource.includes('name: share-check-reviewer-theirs'),
    renamed.persona.name,
  )
  const truncated = await mine.client.persona
    .adopt({ bundleText: exported.text.slice(0, Math.floor(exported.text.length * 0.8)) })
    .then(() => null)
    .catch((error: unknown) => String((error as { message?: string }).message ?? error))
  check(
    'a truncated paste is refused, naming the likely cause rather than "invalid"',
    truncated !== null && (truncated.includes('truncated') || truncated.includes('not JSON')),
    truncated ?? 'a truncated bundle was accepted',
  )
  /**
   * Whole JSON whose *document* changed — the failure a truncated paste cannot reach, because
   * cutting JSON in half breaks the parse first. This is the one the digest exists for: an
   * editor that reflowed the text, or a copy that lost the last line of a prompt.
   */
  const reflowed = JSON.parse(exported.text) as Record<string, unknown>
  const mismatched = await mine.client.persona
    .adopt({
      bundleText: JSON.stringify({
        ...reflowed,
        document: `${String(reflowed.document)}\n(a line that arrived from nowhere)`,
      }),
      as: 'share-check-reflowed',
    })
    .then(() => null)
    .catch((error: unknown) => String((error as { message?: string }).message ?? error))
  check(
    'a document that changed while the digest did not is refused, and says re-export it',
    mismatched !== null && mismatched.includes('digest does not match'),
    mismatched ?? 'a changed document was adopted under its old digest',
  )

  /**
   * The check that matters most, because it is the one an import route is most likely to
   * skip: a document whose persona does not fit its own declared ceiling is refused here
   * exactly as it would be if somebody typed it in.
   */
  const overreaching = JSON.parse(exported.text) as Record<string, unknown>
  const widened = String(overreaching.document).replace('tools: [Read, Grep]', 'tools: [Read, Grep, Bash]')
  const refused = await mine.client.persona
    .adopt({
      bundleText: JSON.stringify({ ...overreaching, document: widened, digest: digestOf(widened) }),
      as: 'share-check-overreaching',
    })
    .then(() => null)
    .catch((error: unknown) => String((error as { message?: string }).message ?? error))
  check(
    'a document that does not fit its own envelope is refused on adoption, not stored',
    refused !== null,
    refused ?? 'a persona outside its envelope was adopted',
  )

  await theirs.app.close()
  await mine.app.close()
  await closeDb()
  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

const { createHash } = await import('node:crypto')
const digestOf = (document: string): string =>
  `sha256:${createHash('sha256').update(document).digest('hex')}`

await main()
