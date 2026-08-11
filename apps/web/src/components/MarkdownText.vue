<script setup lang="ts">
import type { Block } from '@loom/client-core'
import { ref } from 'vue'
import MarkdownInline from './MarkdownInline.vue'

/**
 * Block-level markdown, rendered from tokens rather than from an HTML string
 *. Recursive: a list item and a blockquote both hold blocks.
 */
defineProps<{ blocks: readonly Block[] }>

const copied = ref<string | null>(null)

const copy = async (text: string) => {
 try {
 await navigator.clipboard.writeText(text)
 copied.value = text
 setTimeout( => {
 if (copied.value === text) copied.value = null
 }, 1200)
 } catch {
 // A denied clipboard permission is not worth an error banner; the code is
 // selectable either way.
 }
}
</script>

<template>
 <template v-for="(block, index) in blocks":key="index">
 <pre v-if="block.kind === 'code'" class="code-block"><span class="code-head"
 ><span class="lang">{{ block.language ?? 'text' }}</span
 ><button type="button" @click="copy(block.text)">{{
 copied === block.text ? 'copied': 'copy'
 }}</button></span><code>{{ block.text }}</code></pre>

 <component
:is="`h${Math.min(block.level + 2, 6)}`"
 v-else-if="block.kind === 'heading'"
 class="heading"
 >
 <MarkdownInline:inlines="block.inlines" />
 </component>

 <ol v-else-if="block.kind === 'list' && block.ordered":start="block.start" class="list">
 <li v-for="(item, itemIndex) in block.items":key="itemIndex">
 <MarkdownText:blocks="item" />
 </li>
 </ol>

 <ul v-else-if="block.kind === 'list'" class="list">
 <li v-for="(item, itemIndex) in block.items":key="itemIndex">
 <MarkdownText:blocks="item" />
 </li>
 </ul>

 <blockquote v-else-if="block.kind === 'quote'" class="quote">
 <MarkdownText:blocks="block.blocks" />
 </blockquote>

 <div v-else-if="block.kind === 'table'" class="table-wrap">
 <table>
 <thead>
 <tr>
 <th v-for="(cell, cellIndex) in block.header":key="cellIndex">
 <MarkdownInline:inlines="cell" />
 </th>
 </tr>
 </thead>
 <tbody>
 <tr v-for="(row, rowIndex) in block.rows":key="rowIndex">
 <td v-for="(cell, cellIndex) in row":key="cellIndex">
 <MarkdownInline:inlines="cell" />
 </td>
 </tr>
 </tbody>
 </table>
 </div>

 <hr v-else-if="block.kind === 'rule'" class="rule" />

 <p v-else class="paragraph"><MarkdownInline:inlines="block.inlines" /></p>
 </template>
</template>

<style scoped>
.paragraph {
 margin: 0 0 0.5rem;
 line-height: 1.55;
 overflow-wrap: anywhere;
}

.paragraph:last-child {
 margin-bottom: 0;
}

.heading {
 margin: 0.6rem 0 0.35rem;
 font-size: 0.95rem;
 font-weight: 700;
}

.heading:first-child {
 margin-top: 0;
}

.code-block {
 position: relative;
 margin: 0 0 0.5rem;
 padding: 0;
 border: 1px solid var(--border);
 border-radius: 0.45rem;
 background: var(--surface);
 overflow: hidden;
}

.code-head {
 display: flex;
 align-items: center;
 justify-content: space-between;
 padding: 0.2rem 0.5rem;
 border-bottom: 1px solid var(--border);
 background: var(--surface-hover);
 font-family: ui-sans-serif, system-ui, sans-serif;
 font-size: 0.68rem;
 text-transform: uppercase;
 letter-spacing: 0.05em;
 color: var(--text-faint);
}

.code-head button {
 border: 0;
 background: none;
 color: var(--text-faint);
 font: inherit;
 text-transform: uppercase;
 cursor: pointer;
}

.code-head button:hover {
 color: var(--text);
}

.code-block code {
 display: block;
 padding: 0.5rem 0.6rem;
 /* Code is the one thing that must not wrap: a wrapped line changes what the
 code appears to say. It scrolls in its own box instead. */
 overflow-x: auto;
 font-family: ui-monospace, monospace;
 font-size: 0.8rem;
 line-height: 1.5;
 white-space: pre;
}

.list {
 margin: 0 0 0.5rem;
 padding-left: 1.25rem;
}

.list li {
 margin-bottom: 0.15rem;
}

.list li:deep(.paragraph) {
 margin-bottom: 0.15rem;
}

.quote {
 margin: 0 0 0.5rem;
 padding: 0.15rem 0 0.15rem 0.7rem;
 border-left: 3px solid var(--border);
 color: var(--text-muted);
}

.table-wrap {
 margin: 0 0 0.5rem;
 overflow-x: auto;
}

table {
 border-collapse: collapse;
 font-size: 0.83rem;
}

th,
td {
 padding: 0.25rem 0.55rem;
 border: 1px solid var(--border);
 text-align: left;
 vertical-align: top;
}

th {
 background: var(--surface-hover);
 font-weight: 600;
}

.rule {
 margin: 0.6rem 0;
 border: 0;
 border-top: 1px solid var(--border);
}
</style>
