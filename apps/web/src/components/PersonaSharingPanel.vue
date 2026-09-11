<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentPersona } from '@loom/api-contract'

/**
 * Moving a persona between workspaces.
 *
 * The platform could already do this — export a persona as a bundle, adopt one back in with a
 * recorded claim about where it came from — and there was no way to reach either from the
 * browser, so a persona somebody had tuned could only travel by someone copying its markdown
 * out of the editor and losing the origin with it.
 *
 * **The bundle is text and it stays text.** Nothing is written anywhere and nothing is
 * published: where an operator puts it is their business, and a platform that offered to host
 * it would be a platform with a registry, which is not this phase.
 *
 * **An adoption is a claim, not a transfer.** The provenance sentence that will be stored on
 * the row is shown back after the adopt, so what a reader sees is the assertion they accepted
 * rather than a verified chain of custody — the bundle's digest says the document has not
 * changed since it was exported, and says nothing whatever about who wrote it.
 */
const props = defineProps<{
  personas: AgentPersona[]
  export: (personaId: string) => Promise<{ text: string; digest: string } | null>
  adopt: (input: {
    bundleText: string
    as: string | null
  }) => Promise<{ name: string | null; provenance: string; detail: string }>
}>()

const exportId = ref('')
const bundle = ref<{ text: string; digest: string } | null>(null)
const draft = ref('')
const as = ref('')
const provenance = ref<string | null>(null)
const notice = ref<string | null>(null)
const working = ref(false)

const sorted = computed(() => [...props.personas].sort((a, b) => a.name.localeCompare(b.name)))

const exportIt = async () => {
  if (exportId.value === '') return
  working.value = true
  bundle.value = null
  try {
    bundle.value = await props.export(exportId.value)
    notice.value = bundle.value === null ? 'That persona could not be exported.' : null
  } finally {
    working.value = false
  }
}

const adoptIt = async () => {
  if (draft.value.trim() === '') return
  working.value = true
  provenance.value = null
  try {
    const result = await props.adopt({
      bundleText: draft.value,
      as: as.value.trim() === '' ? null : as.value.trim(),
    })
    notice.value = result.detail
    provenance.value = result.provenance === '' ? null : result.provenance
    if (result.name !== null) {
      draft.value = ''
      as.value = ''
    }
  } finally {
    working.value = false
  }
}
</script>

<template>
  <section class="panel">
    <h3>Sharing</h3>
    <p class="lead">
      A persona travels as text. Nothing here publishes anything — where the bundle goes is
      yours to decide.
    </p>

    <div class="row">
      <label class="field">
        <span>Export</span>
        <select v-model="exportId" aria-label="Persona to export">
          <option value="">Choose a persona…</option>
          <option v-for="persona in sorted" :key="persona.id" :value="persona.id">
            {{ persona.name }}
          </option>
        </select>
      </label>
      <button type="button" :disabled="working || exportId === ''" @click="exportIt">
        Export
      </button>
    </div>

    <template v-if="bundle">
      <!--
        Selected on focus, because the only thing anyone does with this box is copy all of it.
        `readonly` rather than disabled: a disabled field cannot be selected either.
      -->
      <textarea
        class="bundle"
        readonly
        rows="8"
        aria-label="The exported bundle"
        :value="bundle.text"
        @focus="(event) => (event.target as HTMLTextAreaElement).select()"
      />
      <p class="digest">
        digest {{ bundle.digest.slice(0, 12) }} — it says the document has not changed since it
        was exported, and nothing about who wrote it.
      </p>
    </template>

    <hr />

    <label class="field">
      <span>Adopt a bundle</span>
      <textarea
        v-model="draft"
        rows="6"
        placeholder="Paste a bundle here"
        aria-label="Bundle to adopt"
      />
    </label>
    <div class="row">
      <label class="field">
        <span>Under the name</span>
        <input v-model="as" placeholder="its own" aria-label="Adopt under this name" />
      </label>
      <button type="button" :disabled="working || draft.trim() === ''" @click="adoptIt">
        Adopt
      </button>
    </div>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <!--
      The claim being accepted, shown back rather than summarised. A surface that rendered an
      import as "imported from X" would be asserting the transfer happened; what actually
      happened is that somebody pasted a document making that claim.
    -->
    <p v-if="provenance" class="provenance">{{ provenance }}</p>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--surface);
}

h3 {
  margin: 0;
  font-size: 0.85rem;
}

.lead {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--text-muted);
}

.row {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.field {
  display: flex;
  flex: 1;
  min-width: 12rem;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.72rem;
  color: var(--text-muted);
}

.bundle {
  width: 100%;
  font-family: ui-monospace, monospace;
  font-size: 0.72rem;
}

.digest,
.notice,
.provenance {
  margin: 0;
  font-size: 0.72rem;
  line-height: 1.5;
}

.digest {
  color: var(--text-faint);
}

.notice {
  color: var(--text);
}

.provenance {
  padding: 0.4rem 0.5rem;
  border-left: 2px solid var(--border);
  color: var(--text-muted);
}

hr {
  width: 100%;
  height: 1px;
  margin: 0.2rem 0;
  border: 0;
  background: var(--border);
}
</style>
