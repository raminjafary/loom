<script setup lang="ts">
import type {
  AgentPersona,
  AtlasEdge,
  Capability,
  DirectoryListing,
  MasteryView,
  ColosseumSession,
  ColosseumView,
  SubjectMapListing,
  PersonaCapability,
  PersonaRevision,
  PromptTrial,
  VariantSearch,
  PersonaDraft,
  PersonaGroup,
  Repository,
  RunControl,
  SelfDeploymentView,
  Runner,
  VerificationCheck,
} from '@loom/api-contract'
import { DEFAULT_HANDOFF_CAP_PER_TREE, DEFAULT_HANDOFF_THRESHOLD } from '@loom/domain'
import { computed, onMounted, ref, watch } from 'vue'
import CapabilityPanel from './CapabilityPanel.vue'
import HandoffPolicyPanel from './HandoffPolicyPanel.vue'
import AtlasPanel from './AtlasPanel.vue'
import ColosseumPanel from './ColosseumPanel.vue'
import MasteryPanel from './MasteryPanel.vue'
import PersonaEditor from './PersonaEditor.vue'
import PersonaGroupPanel from './PersonaGroupPanel.vue'
import RepositoryPanel from './RepositoryPanel.vue'
import RunnerPanel from './RunnerPanel.vue'

/**
 * Configuration, out of the sidebar.
 *
 * Runners, repositories, personas, capabilities and groups are things a human sets
 * up once and then rarely touches. They were occupying two thirds of a 21rem column
 * that is supposed to answer "what is happening right now", and they need width the
 * column never had — a persona is a markdown document, and it was being edited in a
 * ten-row textarea 240px wide.
 */

const props = defineProps<{
  runners: Runner[]
  repositories: Repository[]
  personas: AgentPersona[]
  personaGroups: PersonaGroup[]
  capabilities: Capability[]
  /** Superseded persona prompts, workspace-wide. */
  personaRevisions: PersonaRevision[]
  /** What the runs say about each persona's live self-edit. */
  promptTrials: Record<string, PromptTrial>
  /** The searching half — candidate prompts being measured, by persona id. */
  variantSearches: Record<string, VariantSearch>
  /**
   * Settles a variant search: `variantId` names the
   * candidate a human took, null means they took none.
   *
   * A callback prop rather than one more emit, and the reason is a real ceiling rather than
   * taste: this overlay's emit map is already large enough that adding a single entry pushes
   * the parent's inference over a limit, after which *every* handler on it silently degrades
   * to `any` — the ones that were fine included. A prop costs nothing there. The actual fix
   * is a smaller overlay, which is a change to this surface and not to this feature.
   */
  settleSearch: (input: { personaId: string; variantId: string | null }) => void
  /**
   * Asks a separate session for the next set of candidates. A callback prop for the reason
   * `settleSearch` is one, and for a second: the answer is a sentence the panel shows, and an
   * emit cannot return one.
   */
  startProposer: (input: {
    personaId: string
  }) => Promise<{ started: boolean; reason: string | null }>
  capabilityAttachments: PersonaCapability[]
  lastPairing: { runnerId: string; name: string; rawToken: string } | null
  /** The expertise tab — fetched on demand, so never part of the session snapshot. */
  masteryPersonaId: string | null
  masteryMaps: SubjectMapListing[]
  masteryView: MasteryView | null
  masteryLoading: boolean
  masteryError: string | null
  /** What the last curation pass did. */
  masteryCuration: {
    checked: number
    kept: number
    retired: number
    proposed: number
    withdrawn: number
  } | null
  /** The venue — sessions and the one being read, fetched when the tab opens. */
  colosseumSessions: ColosseumSession[]
  colosseumView: ColosseumView | null
  /** The atlas — cross-project relations awaiting a human, fetched with the tab. */
  atlasProposals: AtlasEdge[]
  /** The workspace's own policy row — where the handoff threshold and cap live. */
  runControl: RunControl | null
  /**
   * Which revision of Loom's own source is serving. Null while the session has not read it —
   * distinct from a read that came back saying nothing has been promoted, which is the panel's
   * own quiet line.
   */
  selfDeployment: SelfDeploymentView | null
}>()

const repositoryNames = computed(() =>
  Object.fromEntries(props.repositories.map((repository) => [repository.id, repository.displayName])),
)

/**
 * The overlay's events, as a named type rather than inline in `defineEmits`.
 *
 * Not a style choice. This surface emits three dozen events, and inline the literal crosses
 * the inference limit Vue's macro expansion works inside — past which *every* handler in the
 * parent silently degrades to `any`, including the ones that were fine. Adding one event was
 * enough to cross it. A named type keeps the map checkable; the real fix is a smaller
 * overlay, which is a change to this surface rather than to this feature.
 */
type SettingsOverlayEmits = {
  close: []
  'select-expertise': [personaId: string]
  'select-map': [mapId: string]
  'refresh-maps': []
  master: [
    input: {
      repositoryId: string
      subjectKind: 'repository' | 'author'
      subjectRef: string
      focus: string[]
      guidance: string
    },
  ]
  /** portable expertise: a human's standing answer about whether a map is used. */
  'set-retrieval': [input: { mapId: string; override: 'on' | 'off' | null }]
  /** One curation pass over one map. */
  curate: [mapId: string]
  'colosseum-select': [sessionId: string]
  'colosseum-refresh': []
  'colosseum-convene': [
    input: {
      purpose: 'consultation' | 'contention' | 'crunching' | 'warm_up'
      subject: string
      question: string
      personaIds: string[]
    },
  ]
  'colosseum-claim': [input: { sessionId: string; personaId: string; statement: string }]
  'colosseum-settle': [
    input: { claimId: string; verdict: 'upheld' | 'refuted'; citation: string },
  ]
  'colosseum-take-turn': [input: { sessionId: string; personaId?: string }]
  'set-handoff-policy': [input: { threshold: number | null; capPerTree: number | null }]
  'colosseum-conclude': [sessionId: string]
  'set-plan-review': [required: boolean]
  'atlas-refresh': []
  'atlas-contend': [edgeId: string]
  'atlas-decide': [input: { edgeId: string; decision: 'promoted' | 'rejected'; note?: string }]
  'create-pairing-token': [name: string]
  bind: [input: { runnerId: string; path: string; displayName: string }]
  'create-repository': [
    input: { runnerId: string; parentPath: string; name: string; displayName: string },
  ]
  list: [input: { runnerId: string; path: string }, done: (listing: DirectoryListing) => void]
  'set-verification-checks': [repositoryId: string, checks: VerificationCheck[]]
  'set-reconciler-enabled': [repositoryId: string, enabled: boolean]
  'set-install-command': [repositoryId: string, command: string | null]
  'warm-cache': [
    repositoryId: string,
    done: (result: { ok: boolean; detail: string | null }) => void,
  ]
  'remove-runner': [runnerId: string, done: (r: { ok: boolean; reason: string | null }) => void]
  unbind: [
    input: { repositoryId: string; acknowledge: boolean },
    done: (r: { ok: boolean; reason: string | null }) => void,
  ]
  'delete-persona': [personaId: string]
  'create-persona': [markdownSource: string]
  'update-persona': [input: { personaId: string; markdownSource: string }]
  'parse-persona': [markdownSource: string, done: (draft: PersonaDraft) => void]
  'reset-persona': [personaId: string]
  /** Restores a superseded prompt. */
  'revert-persona': [input: { personaId: string; revisionId: string }]
  /** Ends a trial by keeping the agent's edit. */
  'keep-revision': [input: { personaId: string; revisionId: string }]
  register: [
    input: {
      kind: 'mcp' | 'skill'
      name: string
      description: string
      transport?: 'stdio' | 'sse' | 'http' | null
      command?: string | null
      args?: string[]
      url?: string | null
      content?: string | null
    },
  ]
  remove: [capabilityId: string]
  attach: [input: { personaId: string; capabilityId: string; allowedTools?: string[] }]
  detach: [input: { personaId: string; capabilityId: string }]
  'create-group': [input: { name: string; personaIds: string[] }]
  'update-group': [input: { personaGroupId: string; name: string; personaIds: string[] }]
  'delete-group': [personaGroupId: string]
  /** Opens the composition canvas. */
  compose: []
}

const emit = defineEmits<SettingsOverlayEmits>()

type Tab = 'infrastructure' | 'personas' | 'expertise' | 'colosseum' | 'capabilities'

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'infrastructure', label: 'Runners & repositories' },
  { id: 'personas', label: 'Personas & groups' },
  { id: 'expertise', label: 'Expertise' },
  { id: 'colosseum', label: 'Colosseum' },
  { id: 'capabilities', label: 'Capabilities' },
]

const tab = ref<Tab>('infrastructure')

/**
 * Fetched when its tab is first opened rather than on mount: a session is convened rarely,
 * and loading it for everyone who opens Settings would put a query on a surface most
 * sessions never look at — the same discipline live swarm observability applies to the
 * swarm graph.
 */
watch(tab, (next) => {
  if (next === 'colosseum') emit('colosseum-refresh')
  // The atlas queue lives on the expertise tab because a relation is between two maps.
  if (next === 'expertise') emit('atlas-refresh')
})

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') emit('close')
}

/**
 * The Escape handler sat on a `tabindex="-1"` element that nothing ever focused, so
 * it never fired — and unlike the diff and graph overlays this scrim had no
 * `@click.self` either. Settings was closable only by its ✕, while claiming
 * `aria-modal="true"`.
 *
 * Focusing the scrim on mount is what makes both the keydown and the modal claim
 * true, and it moves focus off whatever was behind the overlay.
 */
const scrim = ref<HTMLElement | null>(null)
onMounted(() => scrim.value?.focus())
</script>

<template>
  <div
    ref="scrim"
    class="scrim"
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
    tabindex="-1"
    @keydown="onKeydown"
    @click.self="emit('close')"
  >
    <div class="sheet">
      <header>
        <h2>Settings</h2>
        <nav>
          <button
            v-for="entry in TABS"
            :key="entry.id"
            type="button"
            :class="{ on: tab === entry.id }"
            @click="tab = entry.id"
          >
            {{ entry.label }}
          </button>
        </nav>
        <button type="button" class="close" aria-label="Close settings" @click="emit('close')">
          ✕
        </button>
      </header>

      <div class="body">
        <template v-if="tab === 'infrastructure'">
          <RunnerPanel
            :runners="runners"
            :last-pairing="lastPairing"
            @create-pairing-token="(name) => emit('create-pairing-token', name)"
            @remove="(runnerId, done) => emit('remove-runner', runnerId, done)"
          />
          <RepositoryPanel
            :repositories="repositories"
            :runners="runners"
            @bind="(input) => emit('bind', input)"
            @create="(input) => emit('create-repository', input)"
            @list="(input, done) => emit('list', input, done)"
            @set-verification-checks="(id, checks) => emit('set-verification-checks', id, checks)"
            @set-reconciler-enabled="
              (id, enabled) => emit('set-reconciler-enabled', id, enabled)
            "
            @set-install-command="(id, command) => emit('set-install-command', id, command)"
            @warm-cache="(id, done) => emit('warm-cache', id, done)"
            @unbind="(input, done) => emit('unbind', input, done)"
          />
          <HandoffPolicyPanel
            :control="runControl"
            :default-threshold="DEFAULT_HANDOFF_THRESHOLD"
            :default-cap-per-tree="DEFAULT_HANDOFF_CAP_PER_TREE"
            @save="(input) => emit('set-handoff-policy', input)"
          />
          <!--
            The plan gate, beside the handoff policy because both
            are workspace policy an operator sets deliberately — and deliberately *not* beside
            the kill switch, which is what somebody hits in an emergency. A pause must never
            be able to turn a review gate off as a side effect.
          -->
          <section class="policy">
            <h4>Plans</h4>
            <label class="check">
              <input
                type="checkbox"
                :checked="runControl?.planReviewRequired !== false"
                @change="
                  emit(
                    'set-plan-review',
                    ($event.target as HTMLInputElement).checked,
                  )
                "
              />
              <span>A plan waits for me before anything starts</span>
            </label>
            <p class="hint">
              On, a planner's decomposition is recorded and nothing runs until you accept it —
              which is the gate that replaced the per-tool approvals when the teams became
              autonomous. Off, workers start the moment a plan is submitted, and steering is
              the only way to change it afterwards.
            </p>
          </section>

          <!--
            What is actually running, which until now nothing said. Read-only on purpose and the
            asymmetry is the design: promoting a revision of Loom's own source is a separate
            process, because the code being replaced must not be the code deciding — so this
            panel reports and offers no button.

            Absent is the ordinary state and gets one quiet line rather than a warning: an
            installation that has never promoted is running whatever a human installed, which is
            not a problem to be solved.
          -->
          <section class="policy">
            <h4>Platform revision</h4>
            <p v-if="selfDeployment?.problem" class="hint danger">
              The deployment pointer could not be read, so what is serving cannot be confirmed
              from here: {{ selfDeployment.problem }}
            </p>
            <template v-else-if="selfDeployment?.deployment?.running">
              <p class="hint">
                Serving
                <code>{{ selfDeployment.deployment.running.commit.slice(0, 12) }}</code>, built
                {{ selfDeployment.deployment.running.builtAt.toLocaleString() }}.
              </p>
              <p class="hint">
                <template v-if="selfDeployment.deployment.previous?.retained">
                  The way back is
                  <code>{{ selfDeployment.deployment.previous.commit.slice(0, 12) }}</code>, still
                  built and on disk — a rollback is a pointer move.
                </template>
                <template v-else-if="selfDeployment.deployment.previous">
                  <!--
                    A recorded predecessor whose build is gone is *not* a way back, and saying
                    "previous: abc123" without that would offer a rollback that cannot happen.
                  -->
                  <code>{{ selfDeployment.deployment.previous.commit.slice(0, 12) }}</code> is
                  recorded as the predecessor but its build has been released, so there is
                  nothing to roll back to.
                </template>
                <template v-else>
                  There is no earlier revision kept, so recovery from here is a checkout at a
                  known-good commit rather than a rollback.
                </template>
              </p>
            </template>
            <p v-else class="hint">
              No revision of Loom's own source has been promoted here — this deployment is
              running whatever was installed by hand.
            </p>
          </section>
        </template>

        <template v-else-if="tab === 'personas'">
          <PersonaEditor
            :personas="personas"
            :capabilities="capabilities"
            :attachments="capabilityAttachments"
            :revisions="personaRevisions"
            :trials="promptTrials"
            :searches="variantSearches"
            @create-persona="(source) => emit('create-persona', source)"
            @update-persona="(input) => emit('update-persona', input)"
            @delete-persona="(personaId) => emit('delete-persona', personaId)"
            @attach="(input) => emit('attach', input)"
            @detach="(input) => emit('detach', input)"
            @parse="(source, done) => emit('parse-persona', source, done)"
            @reset-persona="(personaId) => emit('reset-persona', personaId)"
            @revert-persona="(input) => emit('revert-persona', input)"
            @keep-revision="(input) => emit('keep-revision', input)"
            @settle-search="settleSearch"
            :start-proposer="startProposer"
          />
          <PersonaGroupPanel
            :personas="personas"
            :groups="personaGroups"
            @create="(input) => emit('create-group', input)"
            @update="(input) => emit('update-group', input)"
            @delete="(id) => emit('delete-group', id)"
            @compose="emit('compose')"
          />
        </template>

        <template v-else-if="tab === 'expertise'">
          <!--
            The queue first, and the mastery view under it.

            Not a preference: a proposal is something *waiting on the reader* and a map is
            something they went looking for, and with an agent chosen the mastery panel is
            several screens tall. Putting the queue after it is how a feature that works
            perfectly becomes one nobody knew existed — the same lesson the inbox lanes
            and the canvas inspector each cost a session to learn.
          -->
          <AtlasPanel
            :proposals="atlasProposals"
            @refresh="emit('atlas-refresh')"
            @contend="(edgeId) => emit('atlas-contend', edgeId)"
            @decide="(input) => emit('atlas-decide', input)"
          />
          <MasteryPanel
            :personas="personas"
            :persona-id="masteryPersonaId"
            :repositories="repositories"
            :maps="masteryMaps"
            :view="masteryView"
            :loading="masteryLoading"
            :error="masteryError"
            :repository-names="repositoryNames"
            :active-repository-id="null"
            @select-persona="(personaId) => emit('select-expertise', personaId)"
            @select="(mapId) => emit('select-map', mapId)"
            @refresh="emit('refresh-maps')"
            @master="(input) => emit('master', input)"
            @set-retrieval="(input) => emit('set-retrieval', input)"
            :curation="masteryCuration"
            @curate="(mapId) => emit('curate', mapId)"
          />
        </template>

        <template v-else-if="tab === 'colosseum'">
          <ColosseumPanel
            :personas="personas"
            :sessions="colosseumSessions"
            :view="colosseumView"
            @select="(sessionId) => emit('colosseum-select', sessionId)"
            @refresh="emit('colosseum-refresh')"
            @convene="(input) => emit('colosseum-convene', input)"
            @claim="(input) => emit('colosseum-claim', input)"
            @settle="(input) => emit('colosseum-settle', input)"
            @take-turn="(input) => emit('colosseum-take-turn', input)"
            @conclude="(sessionId) => emit('colosseum-conclude', sessionId)"
          />
        </template>

        <CapabilityPanel
          v-else
          :capabilities="capabilities"
          :attachments="capabilityAttachments"
          :personas="personas"
          @register="(input) => emit('register', input)"
          @remove="(id) => emit('remove', id)"
          @attach="(input) => emit('attach', input)"
          @detach="(input) => emit('detach', input)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Workspace policy an operator sets deliberately — see the section's own comment. */
.policy {
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}

.policy h4 {
  margin: 0 0 0.4rem;
  font-size: 0.8rem;
}

.policy .check {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
}

.policy .hint {
  margin: 0.3rem 0 0;
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--text-faint);
}

.scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: rgb(0 0 0 / 45%);
}

.sheet {
  display: flex;
  flex-direction: column;
  width: min(64rem, 100%);
  max-height: 100%;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--surface);
  overflow: hidden;
}

header {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.7rem 1rem;
  border-bottom: 1px solid var(--border);
}

h2 {
  margin: 0;
  font-size: 0.95rem;
}

nav {
  display: flex;
  gap: 0.3rem;
}

nav button {
  padding: 0.28rem 0.6rem;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  background: none;
  color: var(--text-muted);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}

nav button.on {
  border-color: var(--border);
  background: var(--bg);
  color: var(--text);
  font-weight: 600;
}

.close {
  margin-left: auto;
  padding: 0.2rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--bg);
  color: var(--text-muted);
  font: inherit;
  cursor: pointer;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
</style>
