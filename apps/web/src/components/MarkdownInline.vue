<script setup lang="ts">
import type { Inline } from '@loom/client-core'

/**
 * Inline markdown as real elements.
 *
 * Every leaf here is a text interpolation, so agent-authored text cannot become
 * markup no matter what it contains — the guarantee holds because there is no
 * `v-html` to get wrong, not because a sanitizer was correct.
 */
defineProps<{ inlines: readonly Inline[] }>
</script>

<template>
 <template v-for="(inline, index) in inlines":key="index">
 <code v-if="inline.kind === 'code'" class="code">{{ inline.text }}</code>
 <strong v-else-if="inline.kind === 'strong'"><MarkdownInline:inlines="inline.children" /></strong>
 <em v-else-if="inline.kind === 'em'"><MarkdownInline:inlines="inline.children" /></em>
 <a
 v-else-if="inline.kind === 'link'"
:href="inline.href"
 target="_blank"
 rel="noopener noreferrer nofollow"
 ><MarkdownInline:inlines="inline.children" /></a>
 <template v-else>{{ inline.text }}</template>
 </template>
</template>

<style scoped>
.code {
 padding: 0.05rem 0.3rem;
 border-radius: 0.25rem;
 background: var(--surface-hover);
 font-family: ui-monospace, monospace;
 font-size: 0.85em;
 overflow-wrap: anywhere;
}

a {
 color: var(--accent);
 overflow-wrap: anywhere;
}
</style>
