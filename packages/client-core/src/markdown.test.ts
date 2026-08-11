import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown, type Block, type Inline } from './markdown.js'

const text = (inlines: readonly Inline[]): string =>
  inlines
    .map((inline) =>
      inline.kind === 'text' || inline.kind === 'code' ? inline.text : text(inline.children),
    )
    .join('')

describe('parseInline', () => {
  it('reads code spans, bold, italic and links', () => {
    const parsed = parseInline('call `npm ci` then **stop** and _look_ at [docs](https://x.test)')
    expect(parsed.map((i) => i.kind)).toEqual([
      'text',
      'code',
      'text',
      'strong',
      'text',
      'em',
      'text',
      'link',
    ])
    expect(parsed.find((i) => i.kind === 'link')).toMatchObject({ href: 'https://x.test' })
  })

  /**
   * The check that matters most here: a link is a place a model can put a URL, and
   * an allowlist is the only version of this that stays correct.
   */
  it('refuses a javascript: link, leaving it as literal text', () => {
    const parsed = parseInline('[click](javascript:alert(1))')
    expect(parsed.every((i) => i.kind !== 'link')).toBe(true)
    expect(text(parsed)).toBe('[click](javascript:alert(1))')
  })

  it('leaves snake_case identifiers alone', () => {
    // Agent prose is full of these; italicising the middle of one corrupts the
    // one kind of text that has to stay literal.
    const parsed = parseInline('mcp__loom_notes__read_notes returned two notes')
    expect(parsed).toEqual([{ kind: 'text', text: 'mcp__loom_notes__read_notes returned two notes' }])
  })

  it('does not treat arithmetic or a lone asterisk as emphasis', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }])
    expect(text(parseInline('an unclosed *emphasis'))).toBe('an unclosed *emphasis')
  })

  it('honours a backslash escape', () => {
    expect(parseInline('literal \\*stars\\*')).toEqual([{ kind: 'text', text: 'literal *stars*' }])
  })

  it('keeps backticked content verbatim, including markdown inside it', () => {
    const parsed = parseInline('run `git commit -m "**not bold**"`')
    expect(parsed[1]).toEqual({ kind: 'code', text: 'git commit -m "**not bold**"' })
  })
})

describe('parseMarkdown', () => {
  it('keeps a fenced code block intact, with its language', () => {
    const blocks = parseMarkdown('Here:\n\n```ts\nconst x = 1\n\nconst y = 2\n```\n\nDone.')
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'code', 'paragraph'])
    const code = blocks[1] as Extract<Block, { kind: 'code' }>
    expect(code.language).toBe('ts')
    // Blank lines inside the fence are content, not block separators.
    expect(code.text).toBe('const x = 1\n\nconst y = 2')
  })

  it('treats an unterminated fence as a code block rather than swallowing the rest', () => {
    const blocks = parseMarkdown('```\nhalf a block')
    expect(blocks).toEqual([{ kind: 'code', language: null, text: 'half a block' }])
  })

  it('reads headings and rules', () => {
    const blocks = parseMarkdown('## Plan\n\n---\n')
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2 })
    expect(blocks[1]).toEqual({ kind: 'rule' })
  })

  it('reads a bullet list, and a hyphen bullet is not a horizontal rule', () => {
    const blocks = parseMarkdown('- one\n- two\n- three')
    const list = blocks[0] as Extract<Block, { kind: 'list' }>
    expect(list.kind).toBe('list')
    expect(list.ordered).toBe(false)
    expect(list.items).toHaveLength(3)
    expect(text((list.items[0]?.[0] as Extract<Block, { kind: 'paragraph' }>).inlines)).toBe('one')
  })

  it('keeps an ordered list ordered, from the number it starts at', () => {
    const blocks = parseMarkdown('3. third\n4. fourth')
    const list = blocks[0] as Extract<Block, { kind: 'list' }>
    expect(list.ordered).toBe(true)
    expect(list.start).toBe(3)
    expect(list.items).toHaveLength(2)
  })

  it('nests an indented sublist inside its parent item', () => {
    const blocks = parseMarkdown('- outer\n  - inner one\n  - inner two\n- second')
    const list = blocks[0] as Extract<Block, { kind: 'list' }>
    expect(list.items).toHaveLength(2)
    const nested = list.items[0]?.find((b) => b.kind === 'list') as
      | Extract<Block, { kind: 'list' }>
      | undefined
    expect(nested?.items).toHaveLength(2)
  })

  it('reads a pipe table', () => {
    const blocks = parseMarkdown('| shape | outcome |\n| --- | --- |\n| additive | merged |')
    const table = blocks[0] as Extract<Block, { kind: 'table' }>
    expect(table.kind).toBe('table')
    expect(table.header.map(text)).toEqual(['shape', 'outcome'])
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]?.map(text)).toEqual(['additive', 'merged'])
  })

  it('reads a blockquote as blocks, not as a string', () => {
    const blocks = parseMarkdown('> **note**\n> second line')
    const quote = blocks[0] as Extract<Block, { kind: 'quote' }>
    expect(quote.kind).toBe('quote')
    expect(quote.blocks[0]?.kind).toBe('paragraph')
  })

  it('joins wrapped lines into one paragraph and splits on a blank line', () => {
    const blocks = parseMarkdown('one\ntwo\n\nthree')
    expect(blocks).toHaveLength(2)
    expect(text((blocks[0] as Extract<Block, { kind: 'paragraph' }>).inlines)).toBe('one\ntwo')
  })

  it('returns nothing for empty input', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('   \n\n ')).toEqual([])
  })
})
