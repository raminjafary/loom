/**
 * `@mention` starts a run — parses a leading `@persona-name`
 * out of a chat message. Framework-agnostic: no Vue/Pinia here, per the contract-first rule.
 */
export interface ParsedMention {
 readonly personaId: string
 readonly personaName: string
 readonly task: string
}

const MENTION_PATTERN = /^@([A-Za-z0-9_-]+)\b\s*([\s\S]*)$/

export const parseMention = (
 text: string,
 personas: readonly { id: string; name: string }[],
): ParsedMention | null => {
 const match = MENTION_PATTERN.exec(text.trim)
 if (!match) return null
 const [, name, rest] = match
 const persona = personas.find((p) => p.name === name)
 if (!persona) return null
 const task = rest && rest.trim.length > 0 ? rest.trim: text.trim
 return { personaId: persona.id, personaName: persona.name, task }
}
