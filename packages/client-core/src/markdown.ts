/**
 * Markdown for untrusted text.
 *
 * Models write markdown — fenced code, lists, tables — and rendering it as one flat
 * paragraph loses the structure the model used to make itself readable. The usual fix
 * is a library that emits an HTML string, and that is exactly what the no-`v-html` rule forbids: no
 * agent-authored text may reach `v-html`, because a single missed sanitizer turns a
 * model's output into script running in an operator's session.
 *
 * So this produces *tokens*, never HTML. A view walks them and creates real elements
 * with text interpolation, which is a guarantee that holds by construction rather than
 * by a sanitizer being correct. Deliberately a subset: what agents actually emit.
 */

export type Inline =
 | { readonly kind: 'text'; readonly text: string }
 | { readonly kind: 'code'; readonly text: string }
 | { readonly kind: 'strong'; readonly children: Inline[] }
 | { readonly kind: 'em'; readonly children: Inline[] }
 | { readonly kind: 'link'; readonly href: string; readonly children: Inline[] }

export type Block =
 | { readonly kind: 'paragraph'; readonly inlines: Inline[] }
 | { readonly kind: 'heading'; readonly level: number; readonly inlines: Inline[] }
 | { readonly kind: 'code'; readonly language: string | null; readonly text: string }
 | { readonly kind: 'list'; readonly ordered: boolean; readonly start: number; readonly items: Block[][] }
 | { readonly kind: 'quote'; readonly blocks: Block[] }
 | { readonly kind: 'table'; readonly header: Inline[][]; readonly rows: Inline[][][] }
 | { readonly kind: 'rule' }

/**
 * Only schemes a link can safely carry. `javascript:` is the one that matters, but an
 * allowlist is the only version of this check that stays correct as schemes are added.
 */
const SAFE_SCHEME = /^(https?:\/\/|mailto:)/i

const safeHref = (href: string): string | null => (SAFE_SCHEME.test(href.trim) ? href.trim: null)

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\w]/.test(char)

export const parseInline = (text: string): Inline[] => {
 const out: Inline[] = []
 let buffer = ''

 const flush = => {
 if (buffer.length > 0) {
 out.push({ kind: 'text', text: buffer })
 buffer = ''
 }
 }

 let i = 0
 while (i < text.length) {
 const char = text[i] as string

 if (char === '\\' && i + 1 < text.length) {
 buffer += text[i + 1]
 i += 2
 continue
 }

 if (char === '`') {
 const fence = /^`+/.exec(text.slice(i))?.[0] ?? '`'
 const close = text.indexOf(fence, i + fence.length)
 if (close !== -1) {
 flush
 out.push({ kind: 'code', text: text.slice(i + fence.length, close).trim })
 i = close + fence.length
 continue
 }
 }

 if (char === '[') {
 const match = /^\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(text.slice(i))
 const href = match ? safeHref(match[2] ?? ''): null
 if (match && href) {
 flush
 out.push({ kind: 'link', href, children: parseInline(match[1] ?? '') })
 i += match[0].length
 continue
 }
 }

 if (char === '*' || char === '_') {
 // `_` only opens emphasis at a word boundary: agent prose is full of
 // snake_case identifiers, and italicising the middle of `read_notes`
 // corrupts the one kind of text that has to stay literal.
 const boundaryOk = char === '*' || !isWordChar(text[i - 1])
 const doubled = text.startsWith(char + char, i)
 const marker = doubled ? char + char: char
 if (boundaryOk) {
 const close = text.indexOf(marker, i + marker.length)
 const inner = close === -1 ? '': text.slice(i + marker.length, close)
 const closesAtBoundary = char === '*' || !isWordChar(text[close + marker.length])
 if (close !== -1 && inner.length > 0 && !/^\s|\s$/.test(inner) && closesAtBoundary) {
 flush
 out.push({ kind: doubled ? 'strong': 'em', children: parseInline(inner) })
 i = close + marker.length
 continue
 }
 }
 }

 buffer += char
 i += 1
 }

 flush
 return out
}

const BULLET = /^([-*+])\s+(.*)$/
const ORDERED = /^(\d{1,9})[.)]\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE = /^(```|~~~)\s*([\w+-]*)\s*$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/

const splitRow = (line: string): string[] =>
 line
.trim
.replace(/^\|/, '')
.replace(/\|$/, '')
.split('|')
.map((cell) => cell.trim)

const indentOf = (line: string): number => (/^(\s*)/.exec(line)?.[1]?.length ?? 0)

export const parseMarkdown = (source: string): Block[] => {
 const lines = source.replace(/\r\n?/g, '\n').split('\n')
 const blocks: Block[] = []
 let i = 0

 const paragraph: string[] = []
 const flushParagraph = => {
 if (paragraph.length === 0) return
 blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join('\n')) })
 paragraph.length = 0
 }

 while (i < lines.length) {
 const line = lines[i] as string
 const trimmed = line.trim

 if (trimmed.length === 0) {
 flushParagraph
 i += 1
 continue
 }

 const fence = FENCE.exec(trimmed)
 if (fence) {
 flushParagraph
 const marker = fence[1] as string
 const body: string[] = []
 i += 1
 while (i < lines.length && (lines[i] as string).trim !== marker) {
 body.push(lines[i] as string)
 i += 1
 }
 // An unterminated fence is still a code block: a model that ran out of
 // budget mid-block should not have the rest of the message swallowed.
 i += 1
 blocks.push({ kind: 'code', language: fence[2] ? fence[2]: null, text: body.join('\n') })
 continue
 }

 const heading = HEADING.exec(trimmed)
 if (heading) {
 flushParagraph
 blocks.push({
 kind: 'heading',
 level: (heading[1] as string).length,
 inlines: parseInline(heading[2] ?? ''),
 })
 i += 1
 continue
 }

 if (RULE.test(line) && !BULLET.test(trimmed)) {
 flushParagraph
 blocks.push({ kind: 'rule' })
 i += 1
 continue
 }

 if (trimmed.startsWith('>')) {
 flushParagraph
 const quoted: string[] = []
 while (i < lines.length && (lines[i] as string).trim.startsWith('>')) {
 quoted.push((lines[i] as string).trim.replace(/^>\s?/, ''))
 i += 1
 }
 blocks.push({ kind: 'quote', blocks: parseMarkdown(quoted.join('\n')) })
 continue
 }

 if (trimmed.includes('|') && TABLE_DIVIDER.test(lines[i + 1] ?? '')) {
 flushParagraph
 const header = splitRow(trimmed).map(parseInline)
 i += 2
 const rows: Inline[][][] = []
 while (i < lines.length && (lines[i] as string).includes('|')) {
 rows.push(splitRow(lines[i] as string).map(parseInline))
 i += 1
 }
 blocks.push({ kind: 'table', header, rows })
 continue
 }

 const bullet = BULLET.exec(trimmed)
 const ordered = ORDERED.exec(trimmed)
 if (bullet || ordered) {
 flushParagraph
 const isOrdered = ordered !== null
 const start = isOrdered ? Number.parseInt(ordered?.[1] ?? '1', 10): 1
 const items: Block[][] = []
 const baseIndent = indentOf(line)

 while (i < lines.length) {
 const current = lines[i] as string
 const currentTrimmed = current.trim
 if (currentTrimmed.length === 0) {
 // A blank line ends the list unless the next line continues it.
 const next = lines[i + 1] ?? ''
 if (next.trim.length === 0 || indentOf(next) < baseIndent) break
 const nextIsItem = BULLET.test(next.trim) || ORDERED.test(next.trim)
 if (!nextIsItem && indentOf(next) <= baseIndent) break
 i += 1
 continue
 }
 if (indentOf(current) < baseIndent) break

 const itemMatch = isOrdered ? ORDERED.exec(currentTrimmed): BULLET.exec(currentTrimmed)
 if (indentOf(current) === baseIndent && !itemMatch) break

 if (itemMatch && indentOf(current) === baseIndent) {
 // The item's own text, plus anything indented under it — which is where
 // nested lists and continuation paragraphs live.
 const own = [itemMatch[2] ?? '']
 i += 1
 while (i < lines.length) {
 const child = lines[i] as string
 if (child.trim.length === 0) {
 const after = lines[i + 1] ?? ''
 if (indentOf(after) <= baseIndent || after.trim.length === 0) break
 own.push('')
 i += 1
 continue
 }
 if (indentOf(child) <= baseIndent) break
 own.push(child.slice(baseIndent + 2 > indentOf(child) ? indentOf(child): baseIndent + 2))
 i += 1
 }
 items.push(parseMarkdown(own.join('\n')))
 continue
 }

 break
 }

 blocks.push({ kind: 'list', ordered: isOrdered, start, items })
 continue
 }

 paragraph.push(trimmed)
 i += 1
 }

 flushParagraph
 return blocks
}

/** True when rendering as markdown would show anything a plain paragraph would not. */
export const hasMarkdownStructure = (blocks: readonly Block[]): boolean =>
 blocks.some((block) => block.kind !== 'paragraph') ||
 blocks.some((block) => block.kind === 'paragraph' && block.inlines.some((i) => i.kind !== 'text'))
