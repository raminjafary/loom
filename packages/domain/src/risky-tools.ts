/**
 * Phase 1 starting point only. Effect-based classification is explicit that a hardcoded
 * tool-name list is not a real security boundary — `Bash` subsumes every
 * risky category, so this either over-gates (approval fatigue) or under-gates
 * (a disallowed effect inside an allowed tool). The real fix is
 * effect-based classification enforced at the sandbox, with exact-argv
 * approval cards — that lands with full container/microVM sandboxing, not
 * here. This function exists so Phase 1 has *a* gate at all, not a finished one.
 */
const RISKY_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit'])

export const isRiskyTool = (toolName: string): boolean => RISKY_TOOLS.has(toolName)

const PATH_FIELD_BY_TOOL: Readonly<Record<string, string>> = {
 Write: 'file_path',
 Edit: 'file_path',
 NotebookEdit: 'notebook_path',
}

export type ToolEffectVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Path-scoped write enforcement: for the tools that declare
 * a target path, deny anything resolving outside the run's clone. This is
 * NOT the full effect-based fix the plan describes — network egress is
 * untouched, and `Bash` has no reliable static argv classifier, so it stays
 * gated exactly as before, by name only. `resolvePath` does the actual
 * symlink-safe resolution (fs access lives in apps/runner, not here).
 */
export const classifyToolEffect = async (
 toolName: string,
 input: Readonly<Record<string, unknown>>,
 clonePath: string,
 resolvePath: (path: string, root: string) => Promise<{ readonly withinRoot: boolean }>,
): Promise<ToolEffectVerdict> => {
 const field = PATH_FIELD_BY_TOOL[toolName]
 const rawPath = field ? input[field]: undefined
 if (typeof rawPath !== 'string') return { ok: true }

 const { withinRoot } = await resolvePath(rawPath, clonePath)
 if (!withinRoot) {
 return { ok: false, reason: `${toolName} target resolves outside the run's workspace: ${rawPath}` }
 }
 return { ok: true }
}
