/**
 * Phase 1 starting point only. Effect-based classification is explicit that a hardcoded
 * tool-name list is not a real security boundary — `Bash` subsumes every
 * risky category, so this either over-gates (approval fatigue) or under-gates
 * (a disallowed effect inside an allowed tool). The real fix is
 * effect-based classification enforced at the sandbox, with exact-argv
 * approval cards — that lands with the Phase 3 sandbox hardening work, not
 * here. This function exists so Phase 1 has *a* gate at all, not a finished one.
 */
const RISKY_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit'])

export const isRiskyTool = (toolName: string): boolean => RISKY_TOOLS.has(toolName)
