import type { AgentPersonaId, CapabilityId, WorkspaceId } from './ids.js'

/**
 * The capability registry.
 *
 * **This settles a contradiction the plan carries.** The roadmap lists skills attachment
 * under Phase 1, while the own phasing note puts MCP *and* skills behind this
 * registry in Phase 2. The registry reading wins, for a reason that only became
 * visible once `settingSources: []` landed: with filesystem settings off, a skill
 * sitting in the run's clone is content the agent itself can write, and attaching
 * it would hand the material under review a say in how the run behaves. So skills
 * are **provisioned from the registry into the run**, never discovered from the
 * clone — which is exactly the "a registry that provisions skills into a run".
 *
 * The registry is workspace-owned and human-curated. That is the whole security
 * story: a capability is a thing an operator added deliberately, not a thing a
 * repository can introduce.
 */

export type CapabilityKind = 'mcp' | 'skill'

export type McpTransport = 'stdio' | 'sse' | 'http'

export interface Capability {
  readonly id: CapabilityId
  readonly workspaceId: WorkspaceId
  readonly kind: CapabilityKind
  readonly name: string
  readonly description: string
  /** MCP only. */
  readonly transport: McpTransport | null
  readonly command: string | null
  readonly args: string[]
  readonly url: string | null
  /**
   * MCP only, and the point of the "**pinned tool-list hash**". An MCP server is
   * a live process that decides for itself what tools it exposes; without a pin,
   * a server that was reviewed offering three read-only tools can start offering a
   * fourth that writes, and nothing would notice. Null until first observed.
   */
  readonly toolListHash: string | null
  /** Skill only: the SKILL.md source, held here rather than on any run's disk. */
  readonly content: string | null
  /**
   * Hosts a persona holding this may reach through the egress proxy.
   *
   * **The capability is the grant, and the tool is only the means.** A persona reaches
   * the open web because an operator attached something that says so — not because its
   * tool list happens to contain `WebFetch`, and not because a deployment-wide env var
   * opened the host for every run in the workspace. That is what makes "off by default"
   * a statement about an agent rather than about a deployment.
   */
  readonly egressHosts: string[]
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** One attachment, with the per-attachment scopes. */
export interface PersonaCapability {
  readonly id: string
  readonly workspaceId: WorkspaceId
  readonly personaId: AgentPersonaId
  readonly capabilityId: CapabilityId
  /** Narrows what the persona may use from this capability; empty means everything it offers. */
  readonly allowedTools: string[]
}

/**
 * What actually travels to the Runner on a run. Deliberately *not* the registry
 * row: no ids, no timestamps, and — for a skill — the content itself, because the
 * Runner has to write it somewhere the SDK will find it and must not have to call
 * back to the server to do so mid-start.
 */
export type CapabilitySpec =
  | {
      readonly kind: 'mcp'
      readonly name: string
      readonly transport: McpTransport
      readonly command: string | null
      readonly args: string[]
      readonly url: string | null
      readonly toolListHash: string | null
      readonly allowedTools: string[]
      /**
       * Hosts a run holding this capability may reach through the egress proxy.
       *
       * **The capability is the grant; the tool is only the means.** A persona reaches
       * the open web because an operator attached something that says so — not because
       * its tool list happens to contain `WebFetch`, and not because a deployment-wide
       * env var opened the host for every run in the workspace. That distinction is what
       * makes "off by default" true per persona rather than per deployment.
       *
       * Snapshotted onto the run like the rest of this spec, and attenuated with it: a
       * child may hold no capability its parent does not, so it can reach no host its
       * parent could not.
       */
      readonly egressHosts: string[]
    }
  | {
      readonly kind: 'skill'
      readonly name: string
      readonly content: string
      /** See the mcp variant: a skill may be a pure grant, with no tools of its own. */
      readonly egressHosts: string[]
    }

/**
 * The canonical form a tool list is hashed over. Sorted and deduplicated so that
 * a server reordering its listing — which MCP does not promise not to do — is not
 * mistaken for a server changing what it offers.
 *
 * The digest itself is computed in the adapter layer, where `node:crypto` lives;
 * domain stays dependency-free and owns only what "the same tool list" means.
 */
export const canonicalToolList = (tools: readonly string[]): string =>
  [...new Set(tools)].sort().join('\n')

export type ToolListVerdict =
  | { readonly ok: true; readonly firstObservation: boolean }
  | { readonly ok: false; readonly reason: string }

/**
 * Compares an MCP server's live tool list against what was pinned when a human
 * reviewed it.
 *
 * A first observation is accepted and recorded — there is nothing to compare
 * against yet, and refusing would make a server impossible to adopt. Every
 * observation after that must match, and a mismatch is a refusal rather than a
 * prompt: the human who approved this server approved a specific set of tools,
 * and a server that changed them has not been reviewed in its current form.
 */
export const verifyToolListHash = (
  pinned: string | null,
  observed: string,
): ToolListVerdict => {
  if (pinned === null) return { ok: true, firstObservation: true }
  if (pinned === observed) return { ok: true, firstObservation: false }
  return {
    ok: false,
    reason:
      'This MCP server is offering a different set of tools than the one that was ' +
      'reviewed. Re-review it and re-pin before using it again.',
  }
}

/**
 * The attenuation rule applied to capabilities: "a child run can never request
 * tools, model tier, budget, or path scope exceeding its parent's."
 *
 * Capabilities are the sharpest instance of it. A `tools: []` Planner has no
 * filesystem or shell of its own, but an MCP server is a route to both — so
 * without this, the trust boundary that makes a Planner safe could be walked
 * around by attaching a capability to its child.
 */
export const attenuateChildCapabilities = (
  parent: readonly CapabilitySpec[],
  child: readonly CapabilitySpec[],
): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  const parentNames = new Set(parent.map((capability) => capability.name))
  const escalated = child.filter((capability) => !parentNames.has(capability.name))
  if (escalated.length > 0) {
    return {
      ok: false,
      reason: `Child run may not use capabilities its parent lacks: ${escalated
        .map((capability) => capability.name)
        .join(', ')}`,
    }
  }

  // A parent's narrowed tool list must narrow the child's too, or the scope on the
  // parent's attachment would be advisory.
  for (const childCapability of child) {
    if (childCapability.kind !== 'mcp') continue
    const parentCapability = parent.find(
      (candidate) => candidate.name === childCapability.name && candidate.kind === 'mcp',
    )
    if (!parentCapability || parentCapability.kind !== 'mcp') continue
    if (parentCapability.allowedTools.length === 0) continue

    const allowed = new Set(parentCapability.allowedTools)
    const wider =
      childCapability.allowedTools.length === 0
        ? ['(all tools)']
        : childCapability.allowedTools.filter((tool) => !allowed.has(tool))
    if (wider.length > 0) {
      return {
        ok: false,
        reason: `Child run's scope on ${childCapability.name} exceeds its parent's: ${wider.join(', ')}`,
      }
    }
  }

  return { ok: true }
}
