import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalToolList } from '@loom/domain'
import type { WireCapabilitySpec } from '@loom/runner-protocol'

/**
 * Turns the registry's capability specs into the two things the Agent SDK
 * actually consumes: skill files on disk, and an `mcpServers` map.
 *
 * Skills are *written* rather than discovered. The registry exists so that what
 * a run can do is decided by the workspace, and `settingSources: []` already
 * established that the clone must not influence how a run behaves — a skill read
 * out of the repository under review would be exactly that influence, arriving
 * through a different door.
 */

/** Where the SDK looks for skills, relative to the run's HOME. */
const SKILLS_DIR = '.claude/skills'

export const provisionSkills = async (
 homePath: string,
 capabilities: readonly WireCapabilitySpec[],
): Promise<string[]> => {
 const skills = capabilities.filter((capability) => capability.kind === 'skill')
 const names: string[] = []

 for (const skill of skills) {
 if (skill.kind !== 'skill') continue
 // A capability name is workspace-unique and human-authored, but it still ends
 // up as a directory name here — so anything that could traverse is refused
 // rather than sanitized, the same rule `initRepository` applies.
 if (skill.name.includes('/') || skill.name.includes('..')) continue
 const dir = join(homePath, SKILLS_DIR, skill.name)
 await mkdir(dir, { recursive: true })
 await writeFile(join(dir, 'SKILL.md'), skill.content, 'utf8')
 names.push(skill.name)
 }

 return names
}

/** Mirrors the SDK's own discriminated union so the shapes stay checkable, not cast. */
export type McpServerEntry =
 | { readonly type: 'stdio'; readonly command: string; readonly args: string[] }
 | { readonly type: 'sse'; readonly url: string }
 | { readonly type: 'http'; readonly url: string }

/**
 * The SDK's `mcpServers` map. Paired with `strictMcpConfig: true` at the call
 * site, which is what stops the run's own clone contributing servers through a
 * `.mcp.json` — the same class of hole `settingSources: []` closed for settings,
 * and worth stating because the fix is one flag away from being forgotten.
 */
export const toMcpServers = (
 capabilities: readonly WireCapabilitySpec[],
): Record<string, McpServerEntry> => {
 const servers: Record<string, McpServerEntry> = {}

 for (const capability of capabilities) {
 if (capability.kind !== 'mcp') continue
 if (capability.transport === 'stdio') {
 if (!capability.command) continue
 servers[capability.name] = {
 type: 'stdio',
 command: capability.command,
 args: capability.args,
 }
 } else {
 if (!capability.url) continue
 servers[capability.name] =
 capability.transport === 'sse'
 ? { type: 'sse', url: capability.url }
: { type: 'http', url: capability.url }
 }
 }

 return servers
}

/**
 * The tools an MCP capability is allowed to contribute, as SDK tool names.
 *
 * An empty `allowedTools` means "everything this server offers", which is why
 * this returns null rather than an empty list — the two are opposite instructions
 * and collapsing them would silently disable every attached server.
 */
export const allowedMcpToolNames = (
 capabilities: readonly WireCapabilitySpec[],
): string[] | null => {
 const scoped = capabilities.filter(
 (capability) => capability.kind === 'mcp' && capability.allowedTools.length > 0,
)
 if (scoped.length === 0) return null

 return scoped.flatMap((capability) =>
 capability.kind === 'mcp'
 ? capability.allowedTools.map((tool) => `mcp__${capability.name}__${tool}`)
: [],
)
}

/** The digest the capability registry pins. Domain owns what "the same tool list" means; this hashes it. */
export const hashToolList = (tools: readonly string[]): string =>
 createHash('sha256').update(canonicalToolList(tools)).digest('hex')
