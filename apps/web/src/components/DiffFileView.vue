<script setup lang="ts">
import { splitHunk, type DiffFile, type DiffLine } from '@loom/client-core'
import { computed, ref } from 'vue'

/**
 * One file of a branch diff.
 *
 * The review surface is where a human decides whether an agent's work is any good, so it
 * has to read like a diff and not like a paragraph. Three things the previous `<pre>`
 * could not do, each of which made review harder rather than merely uglier:
 *
 * - **Line numbers per side.** Without them "which line is this" is unanswerable, and a
 *   reviewer cannot map a change back to the file.
 * - **No wrapping.** The old view set `white-space: pre-wrap`, so long lines folded and
 *   the columns stopped lining up — the one property a diff depends on. Here the code
 *   scrolls horizontally instead.
 * - **Structure.** A file header with its own +/− counts, collapsible per file, so a
 *   twenty-file branch is navigable rather than one wall.
 *
 * Every value rendered is plain text through interpolation, never `v-html`: a
 * diff is agent-produced content quoting repository content, and both are untrusted.
 */

const props = defineProps<{ file: DiffFile; split: boolean }>()

const open = ref(true)

const rows = computed(() => props.file.hunks.map((hunk) => ({ hunk, split: splitHunk(hunk) })))

const STATUS_LABEL: Record<DiffFile['status'], string> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  modified: 'modified',
}

const sign = (line: DiffLine | null): string =>
  line === null ? '' : line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
</script>

<template>
  <article class="file" :class="{ collapsed: !open }">
    <header @click="open = !open">
      <span class="chevron" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      <span class="path" :title="props.file.path">{{ props.file.path }}</span>
      <span class="status" :class="props.file.status">{{ STATUS_LABEL[props.file.status] }}</span>
      <span v-if="props.file.additions > 0" class="adds">+{{ props.file.additions }}</span>
      <span v-if="props.file.deletions > 0" class="dels">−{{ props.file.deletions }}</span>
    </header>

    <template v-if="open">
      <p v-if="props.file.binary" class="binary">Binary file — no textual diff.</p>
      <p v-else-if="props.file.hunks.length === 0" class="binary">No content changes.</p>

      <!-- Side by side: a removal and its replacement are one edit, shown as one row. -->
      <table v-else-if="props.split" class="code split">
        <tbody v-for="(group, gi) in rows" :key="gi">
          <tr class="hunk">
            <td colspan="4">@@ {{ group.hunk.oldStart }} · {{ group.hunk.context }}</td>
          </tr>
          <tr v-for="(row, ri) in group.split" :key="ri">
            <td class="num">{{ row.left?.oldNumber ?? '' }}</td>
            <td class="line" :class="row.left?.kind ?? 'blank'">
              <span class="sign">{{ sign(row.left) }}</span>{{ row.left?.text ?? '' }}
            </td>
            <td class="num">{{ row.right?.newNumber ?? '' }}</td>
            <td class="line" :class="row.right?.kind ?? 'blank'">
              <span class="sign">{{ sign(row.right) }}</span>{{ row.right?.text ?? '' }}
            </td>
          </tr>
        </tbody>
      </table>

      <table v-else class="code">
        <tbody v-for="(group, gi) in rows" :key="gi">
          <tr class="hunk">
            <td colspan="3">@@ {{ group.hunk.oldStart }} · {{ group.hunk.context }}</td>
          </tr>
          <tr v-for="(line, li) in group.hunk.lines" :key="li">
            <td class="num">{{ line.oldNumber ?? '' }}</td>
            <td class="num">{{ line.newNumber ?? '' }}</td>
            <td class="line" :class="line.kind">
              <span class="sign">{{ sign(line) }}</span>{{ line.text }}
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </article>
</template>

<style scoped>
.file {
  border: 1px solid var(--border);
  border-radius: 0.4rem;
  overflow: hidden;
  margin-bottom: 0.5rem;
  background: var(--surface);
}

header {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.35rem 0.5rem;
  background: var(--surface-hover);
  cursor: pointer;
  font-size: 0.78rem;
}

.chevron {
  color: var(--text-faint);
  width: 0.7rem;
}

.path {
  flex: 1 1 auto;
  min-width: 0;
  font-family: ui-monospace, monospace;
  white-space: nowrap;
  overflow: hidden;
  /* The tail of a path identifies the file; the leading directories rarely do. */
  direction: rtl;
  text-align: left;
}

.status {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}

.status.added {
  color: #4ac07a;
}

.status.deleted {
  color: #d4736a;
}

.adds {
  color: #4ac07a;
  font-variant-numeric: tabular-nums;
}

.dels {
  color: #d4736a;
  font-variant-numeric: tabular-nums;
}

.binary {
  margin: 0;
  padding: 0.5rem;
  font-size: 0.75rem;
  color: var(--text-faint);
}

/*
  A table, not a <pre>: line numbers have to stay in their own column while the code
  column scrolls, and the code column must never wrap — wrapping is what broke the old
  view, because a diff's meaning is carried by its columns lining up.
*/
.code {
  width: 100%;
  border-collapse: collapse;
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  display: block;
  overflow-x: auto;
  max-height: 28rem;
}

.num {
  width: 1%;
  padding: 0 0.4rem;
  text-align: right;
  color: var(--text-faint);
  user-select: none;
  font-variant-numeric: tabular-nums;
  border-right: 1px solid var(--border);
  vertical-align: top;
}

.line {
  padding: 0 0.5rem;
  white-space: pre;
  vertical-align: top;
}

.split .line {
  width: 50%;
}

.sign {
  display: inline-block;
  width: 0.75rem;
  color: var(--text-faint);
  user-select: none;
}

.line.add {
  background: rgba(74, 192, 122, 0.13);
}

.line.del {
  background: rgba(212, 115, 106, 0.13);
}

.line.blank {
  background: rgba(127, 127, 127, 0.06);
}

.hunk td {
  padding: 0.2rem 0.5rem;
  background: var(--surface-hover);
  color: var(--text-faint);
  font-size: 0.7rem;
  white-space: pre;
}
</style>
