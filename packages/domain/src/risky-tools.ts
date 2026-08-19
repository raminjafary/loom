import {
  absolutePathArguments,
  classifyBashCommand,
  describeBashEffects,
} from './bash-effects.js'

/**
 * Which tools need a decision at all. Still a name list, and still not the
 * boundary — the sandbox is what actually bounds a run. What has changed since Phase 1 is
 * that `Bash` is no longer gated *only* by this name: `classifyToolEffect` below now
 * classifies the command's effects, so this set answers "could this tool ever matter", and
 * the classifier answers "does this call".
 */
const RISKY_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit'])

export const isRiskyTool = (toolName: string): boolean => RISKY_TOOLS.has(toolName)

const PATH_FIELD_BY_TOOL: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
}

export type ToolEffectVerdict =
  | {
      readonly ok: true
      /**
       * False only when the call was *proved* harmless. Everything unproven
       * still asks a human, so a gap in the classifier costs an extra approval
       * rather than an ungated effect.
       */
      readonly requiresApproval: boolean
      /** Shown on the approval card alongside the exact argv. */
      readonly effects?: string
    }
  | { readonly ok: false; readonly reason: string }

/**
 * Effect-based gating, in the two forms reachable without a
 * sandbox rewrite.
 *
 * **Path-scoped writes** (unchanged): a declared target resolving outside the
 * run's clone is denied outright, never asked about. It is a boundary.
 *
 * **Bash effects** (new): the command is classified into effects rather than
 * judged by the tool's name. Three outcomes, and which one applies is the whole
 * point —
 *
 * - Effects that are boundaries elsewhere in the plan (pushing, privilege
 *   escalation, credential reads) are *denied*, because arriving through a shell
 *   must not turn a boundary into a question.
 * - Provably read-only commands whose paths stay inside the workspace skip the
 *   gate. This is the approval-fatigue half of effect-based classification's complaint, and
 *   it is the only place this file reduces gating.
 * - Everything else gates as before, now carrying the effect names so the card
 *   shows more than a command string.
 *
 * `resolvePath` does the symlink-safe filesystem work; domain has no I/O.
 */
export const classifyToolEffect = async (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  clonePath: string,
  resolvePath: (path: string, root: string) => Promise<{ readonly withinRoot: boolean }>,
): Promise<ToolEffectVerdict> => {
  if (toolName === 'Bash') {
    const command = input.command
    // A Bash call with no command string is not something to reason about — it
    // gates, like anything else this cannot read.
    if (typeof command !== 'string') return { ok: true, requiresApproval: true }

    const classification = classifyBashCommand(command)
    if (classification.kind === 'deny') {
      return { ok: false, reason: classification.reason }
    }
    if (classification.kind === 'gate') {
      return {
        ok: true,
        requiresApproval: true,
        effects: describeBashEffects(classification.effects),
      }
    }

    // Read-only by shape — but "read-only" says nothing about *where*. A command
    // is only skippable if every absolute path it names is inside the run's own
    // workspace; reading /etc or a sibling checkout is still a human's call.
    for (const path of absolutePathArguments(command)) {
      const { withinRoot } = await resolvePath(path, clonePath)
      if (!withinRoot) {
        return {
          ok: true,
          requiresApproval: true,
          effects: `reads ${path}, which is outside the workspace`,
        }
      }
    }
    return { ok: true, requiresApproval: false }
  }

  const field = PATH_FIELD_BY_TOOL[toolName]
  const rawPath = field ? input[field] : undefined
  if (typeof rawPath !== 'string') return { ok: true, requiresApproval: true }

  const { withinRoot } = await resolvePath(rawPath, clonePath)
  if (!withinRoot) {
    return { ok: false, reason: `${toolName} target resolves outside the run's workspace: ${rawPath}` }
  }
  return { ok: true, requiresApproval: true }
}
