<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  describeWorkflowProgress,
  layoutWorkflow,
  type WorkflowDetail,
  type WorkflowRow,
  type WorkflowRunDetail,
  type WorkflowProposal,
  type WorkflowRunRow,
  type WorkflowTrialReport,
  type WorkflowShapeNode,
} from '@loom/client-core'

/**
 * Workflows — the shape, and what one execution of it did.
 *
 * The panel exists because of the one claim drawing a harness makes that scripting one cannot:
 * that a person can *see* where the work waits. So the two things it spends its space on are the
 * two a list of rows would hide.
 *
 * - **A barrier is drawn as a bar across the lane**, and a pipeline is the absence of one. The
 *   reported mistake in hand-written harnesses is waiting for every branch when only one
 *   predecessor was needed, and in a script that decision is invisible. Here it is the only wide
 *   flat thing on the canvas.
 * - **A fan says what it fans over and how wide it may get**, before it has run. That number is
 *   the difference between a step and six steps, and it is the number a person refuses on.
 *
 * **There is no editor here yet, and the absence is deliberate rather than pending.** A shape is
 * a configuration a measurement cites, so an edit is a new version — and the way configuration is
 * meant to become a conversation is a designer agent proposing one, not a form. What this panel
 * does is let a person read a shape, price it, run it, and watch it; drawing one from nothing is
 * the next surface, and it should arrive as a proposal a human approves.
 *
 * Every title, persona name and reason here is model- or human-authored text. Interpolated, never
 * `v-html`.
 */

const props = defineProps<{
  workflows: WorkflowRow[]
  repositories: { id: string; displayName: string }[]
  /**
   * Where an execution's steps will render.
   *
   * A prop rather than a picker: a workflow's steps are ordinary runs, so they belong in the
   * thread the person starting them is already looking at. A second place to choose a thread
   * would let somebody start eight runs somewhere nobody is subscribed.
   */
  threadId: string | null
  busy?: boolean
  read: (workflowId: string) => Promise<WorkflowDetail | null>
  listRuns: (workflowId: string) => Promise<WorkflowRunRow[]>
  readRun: (runId: string) => Promise<WorkflowRunDetail | null>
  start: (input: {
    workflowId: string
    repositoryId: string
    threadId: string
    input: string
    capUsd: number | null
  }) => Promise<{ runId: string | null; detail: string }>
  cancel: (runId: string) => Promise<{ cancelled: boolean; detail: string }>
  /**
   * The designer, which is what stands in for the editor this panel does not have.
   *
   * Callback props rather than events, and not by preference: the parent's emit map has a
   * documented inference ceiling past which every handler in it degrades to `any`, and four
   * more events would cross it again.
   */
  personas: { id: string; name: string }[]
  proposals: WorkflowProposal[]
  design: (input: {
    personaId: string
    repositoryId: string
    threadId: string
    ask: string
  }) => Promise<{ runId: string | null; detail: string }>
  approveDesign: (designId: string) => Promise<{
    versionId: string | null
    version: number | null
    detail: string
  }>
  declineDesign: (input: {
    designId: string
    note: string | null
  }) => Promise<{ declined: boolean; detail: string }>
  /**
   * The trial: whether this harness beats a planner and its workers on its own class of work.
   *
   * Read per selected harness rather than held in the panel's props, because the verdict changes
   * when a task is decided somewhere else entirely.
   */
  readTrial: (workflowId: string) => Promise<WorkflowTrialReport | null>
  runTrialTask: (input: {
    workflowId: string
    repositoryId: string
    threadId: string
    input: string
    capUsd: number | null
    plannerPersonaId: string
  }) => Promise<{ arm: 'workflow' | 'planner' | null; runId: string | null; detail: string }>
}>()

const emit = defineEmits<{
  refresh: []
  /** The run a step was dealt to — the panel does not render a transcript, the thread does. */
  open: [agentRunId: string]
}>()

const selectedId = ref<string | null>(null)
const detail = ref<WorkflowDetail | null>(null)
const runs = ref<WorkflowRunRow[]>([])
const openRun = ref<WorkflowRunDetail | null>(null)
const ask = ref('')
const repositoryId = ref('')
const capUsd = ref('5')
const notice = ref<string | null>(null)
const working = ref(false)
const designAsk = ref('')
const designerId = ref('')
const openProposalId = ref<string | null>(null)
const declineNote = ref('')
const trial = ref<WorkflowTrialReport | null>(null)
const trialTask = ref('')

const armOf = (arm: 'workflow' | 'planner') =>
  trial.value?.arms.find((entry) => entry.arm === arm) ?? null

/**
 * Runs the next task of this class, on whichever arm the trial is owed.
 *
 * The arm is not a choice on this form, and that is the point: assignment is the platform's, from
 * the counts, so a person cannot settle the question by choosing which side to send the easy work
 * to. What they are shown instead is which way it will go before they press.
 */
const runNextTask = async () => {
  const workflowId = selectedId.value
  const threadId = props.threadId
  if (workflowId === null || threadId === null || trialTask.value.trim() === '') return
  if (repositoryId.value === '' || designerId.value === '') return
  working.value = true
  try {
    const parsedCap = Number.parseFloat(capUsd.value)
    const result = await props.runTrialTask({
      workflowId,
      repositoryId: repositoryId.value,
      threadId,
      input: trialTask.value.trim(),
      capUsd: Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : null,
      plannerPersonaId: designerId.value,
    })
    notice.value = result.detail
    if (result.runId !== null) {
      trialTask.value = ''
      trial.value = await props.readTrial(workflowId)
      runs.value = await props.listRuns(workflowId)
    }
  } finally {
    working.value = false
  }
}

/**
 * The proposal being read, drawn with the same layout an execution is.
 *
 * A diagram rather than a diff, because what a person is deciding about is a *shape*: where the
 * work waits, how wide a fan may get, and who grades whose work. A JSON graph in a review queue
 * would be a decision nobody can make.
 */
const openProposal = computed(
  () => props.proposals.find((proposal) => proposal.id === openProposalId.value) ?? null,
)

const proposedShape = computed(() =>
  openProposal.value === null ? null : layoutWorkflow(openProposal.value.graph),
)

const askForDesign = async () => {
  const threadId = props.threadId
  if (threadId === null || designAsk.value.trim() === '' || designerId.value === '') return
  if (repositoryId.value === '') return
  working.value = true
  try {
    const result = await props.design({
      personaId: designerId.value,
      repositoryId: repositoryId.value,
      threadId,
      ask: designAsk.value.trim(),
    })
    notice.value = result.detail
    if (result.runId !== null) designAsk.value = ''
  } finally {
    working.value = false
  }
}

const approveIt = async (designId: string) => {
  working.value = true
  try {
    notice.value = (await props.approveDesign(designId)).detail
    openProposalId.value = null
    emit('refresh')
  } finally {
    working.value = false
  }
}

const declineIt = async (designId: string) => {
  working.value = true
  try {
    notice.value = (
      await props.declineDesign({
        designId,
        note: declineNote.value.trim() === '' ? null : declineNote.value.trim(),
      })
    ).detail
    declineNote.value = ''
    openProposalId.value = null
    emit('refresh')
  } finally {
    working.value = false
  }
}

const select = async (workflowId: string) => {
  selectedId.value = workflowId
  openRun.value = null
  notice.value = null
  working.value = true
  try {
    detail.value = await props.read(workflowId)
    runs.value = await props.listRuns(workflowId)
    trial.value = await props.readTrial(workflowId)
  } finally {
    working.value = false
  }
}

const show = async (runId: string) => {
  working.value = true
  try {
    openRun.value = await props.readRun(runId)
  } finally {
    working.value = false
  }
}

const startIt = async () => {
  const workflowId = selectedId.value
  const threadId = props.threadId
  if (workflowId === null || threadId === null) return
  if (ask.value.trim() === '' || repositoryId.value === '') return
  working.value = true
  try {
    const parsedCap = Number.parseFloat(capUsd.value)
    const result = await props.start({
      workflowId,
      repositoryId: repositoryId.value,
      threadId,
      input: ask.value.trim(),
      capUsd: Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : null,
    })
    notice.value = result.detail
    if (result.runId !== null) {
      ask.value = ''
      runs.value = await props.listRuns(workflowId)
      await show(result.runId)
    }
  } finally {
    working.value = false
  }
}

const stopIt = async (runId: string) => {
  working.value = true
  try {
    notice.value = (await props.cancel(runId)).detail
    if (selectedId.value !== null) runs.value = await props.listRuns(selectedId.value)
    if (openRun.value?.id === runId) await show(runId)
  } finally {
    working.value = false
  }
}

/**
 * The shape being drawn: the execution's when one is open, and the workflow's own otherwise.
 *
 * An execution renders the version *it* ran rather than the version in use, which is the whole
 * point of versioning a shape: reading a month-old execution against today's drawing would show
 * a diagram of work that never happened.
 */
const shape = computed(() =>
  openRun.value !== null
    ? layoutWorkflow(openRun.value.graph, openRun.value.steps)
    : layoutWorkflow(detail.value?.graph ?? null),
)

const progress = computed(() =>
  openRun.value === null ? null : describeWorkflowProgress(openRun.value.steps),
)

const laneLabel = (node: WorkflowShapeNode): string | null => {
  if (node.lanes.length === 0) return null
  /**
   * A bracket's lanes are matches and its passes are rounds, so "6 lanes" would be the one
   * reading a person cannot act on. Rounds are what tells them how far the tournament has got.
   */
  if (node.kind === 'bracket') {
    const rounds = new Set(node.lanes.map((lane) => lane.pass)).size
    return `${node.lanes.length} match(es) in ${rounds} round(s)`
  }
  if (node.lanes.length === 1) return node.lanes[0]?.item ?? null
  return `${node.lanes.length} lanes`
}

const money = (value: number | null) => (value === null ? null : `$${value.toFixed(2)}`)

watch(
  () => props.workflows,
  (list) => {
    if (selectedId.value === null && list.length > 0) void select(list[0]!.id)
  },
  { immediate: true },
)

watch(
  () => props.repositories,
  (list) => {
    if (repositoryId.value === '' && list.length > 0) repositoryId.value = list[0]!.id
  },
  { immediate: true },
)

watch(
  () => props.personas,
  (list) => {
    if (designerId.value === '') {
      // The shipped designer if this workspace has it, since asking anything else for a harness
      // is a deliberate choice rather than a default.
      const shipped = list.find((persona) => persona.name === 'workflow-designer')
      designerId.value = shipped?.id ?? list[0]?.id ?? ''
    }
  },
  { immediate: true },
)
</script>

<template>
  <section class="panel">
    <header>
      <h3>Workflows</h3>
      <button type="button" :disabled="props.busy" @click="emit('refresh')">Refresh</button>
    </header>

    <p v-if="props.workflows.length === 0" class="empty">
      No workflows here yet. A workflow is a harness for a task class — the same steps, in the
      same order, every time that kind of work comes round.
    </p>

    <!--
      Asking for one, which is what this panel has instead of an editor. A shape is a
      configuration a measurement cites, so an edit is a new version — and a version arrives as
      a proposal somebody approves rather than as a form somebody fills in.
    -->
    <form class="designer" @submit.prevent="askForDesign">
      <label>
        Ask for a harness
        <textarea
          v-model="designAsk"
          rows="2"
          placeholder="what the work is, and what keeps going wrong with it"
        />
      </label>
      <div class="row">
        <label>
          Designer
          <select v-model="designerId">
            <option v-for="persona in props.personas" :key="persona.id" :value="persona.id">
              {{ persona.name }}
            </option>
          </select>
        </label>
        <button
          type="submit"
          :disabled="
            working ||
            props.busy ||
            props.threadId === null ||
            designerId === '' ||
            designAsk.trim() === ''
          "
        >
          Ask
        </button>
      </div>
      <p class="hint">
        It reads the repository and draws. Nothing runs and nothing is configured until you
        approve what it drew.
      </p>
    </form>

    <template v-if="props.proposals.length > 0">
      <h4>Proposed harnesses</h4>
      <ul class="proposals">
        <li v-for="proposal in props.proposals" :key="proposal.id">
          <button
            type="button"
            class="pick"
            :class="{ on: proposal.id === openProposalId }"
            @click="openProposalId = openProposalId === proposal.id ? null : proposal.id"
          >
            <span class="name">{{ proposal.name }}</span>
            <span class="version">
              {{ proposal.workflowId === null ? 'new' : 'next version' }} ·
              {{ proposal.status }}
            </span>
          </button>
        </li>
      </ul>

      <template v-if="openProposal !== null">
        <p class="description">
          {{ openProposal.shape }}
        </p>
        <p class="rationale">{{ openProposal.rationale }}</p>
        <!-- The ceiling for the shape as proposed, above the button that would make it real. -->
        <pre class="ceiling">{{ openProposal.detail }}</pre>

        <figure v-if="proposedShape !== null && proposedShape.nodes.length > 0" class="canvas">
          <svg
            :viewBox="`0 0 ${proposedShape.width} ${proposedShape.height}`"
            role="img"
            aria-label="the proposed shape"
          >
            <path
              v-for="(edge, at) in proposedShape.edges"
              :key="`p-${edge.from}-${edge.to}-${at}`"
              :d="edge.path"
              class="edge"
              :class="{ loop: edge.loop }"
              marker-end="url(#wf-arrow)"
            />
            <g
              v-for="node in proposedShape.nodes"
              :key="`p-${node.id}`"
              :class="['node', node.kind]"
            >
              <rect
                :x="node.x"
                :y="node.y"
                :width="node.width"
                :height="node.height"
                :rx="node.kind === 'barrier' ? 7 : 6"
              />
              <template v-if="node.kind !== 'barrier'">
                <text :x="node.x + 10" :y="node.y + 18" class="title">{{ node.title }}</text>
                <text :x="node.x + 10" :y="node.y + 32" class="sub">{{ node.persona }}</text>
                <text v-if="node.fans" :x="node.x + 10" :y="node.y + 44" class="fan">
                  {{ node.kind === 'bracket' ? 'two at a time from' : 'per' }} {{ node.fans }}
                </text>
              </template>
              <text v-else :x="node.x + node.width / 2" :y="node.y - 5" class="barrier-label">
                {{ node.title }}
              </text>
            </g>
          </svg>
          <figcaption>
            Drawn by {{ openProposal.personaName ?? 'a designer' }}. A bar across the lane is a
            barrier: everything above it has to finish before what follows starts.
          </figcaption>
        </figure>

        <div v-if="openProposal.status === 'proposed'" class="decide">
          <label>
            If you decline, why
            <input v-model="declineNote" type="text" placeholder="what would have to change" />
          </label>
          <div class="row">
            <button type="button" :disabled="working" @click="approveIt(openProposal.id)">
              Approve — draw it as a version
            </button>
            <button type="button" :disabled="working" @click="declineIt(openProposal.id)">
              Decline
            </button>
          </div>
        </div>
        <p v-else class="hint">
          {{ openProposal.status }}<template v-if="openProposal.decisionNote">
            — {{ openProposal.decisionNote }}</template>
        </p>
      </template>
    </template>

    <ul v-else class="picker">
      <li v-for="workflow in props.workflows" :key="workflow.id">
        <button
          type="button"
          class="pick"
          :class="{ on: workflow.id === selectedId }"
          @click="select(workflow.id)"
        >
          <span class="name">{{ workflow.name }}</span>
          <span class="version">v{{ workflow.version }}</span>
        </button>
      </li>
    </ul>

    <template v-if="detail !== null">
      <p v-if="detail.description" class="description">{{ detail.description }}</p>

      <!--
        The ceiling, above the button that spends it. A worst case from the enforced caps rather
        than an estimate: the number's job is to let a person refuse a shape, and only the worst
        case can do that.
      -->
      <pre class="ceiling">{{ detail.detail }}</pre>

      <figure v-if="shape.nodes.length > 0" class="canvas">
        <svg :viewBox="`0 0 ${shape.width} ${shape.height}`" role="img" aria-label="the shape">
          <defs>
            <marker id="wf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7"
              markerHeight="7" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" />
            </marker>
          </defs>
          <path
            v-for="(edge, at) in shape.edges"
            :key="`${edge.from}-${edge.to}-${at}`"
            :d="edge.path"
            class="edge"
            :class="{ loop: edge.loop }"
            marker-end="url(#wf-arrow)"
          />
          <g v-for="node in shape.nodes" :key="node.id" :class="['node', node.kind, node.state]">
            <rect
              :x="node.x"
              :y="node.y"
              :width="node.width"
              :height="node.height"
              :rx="node.kind === 'barrier' ? 7 : 6"
            />
            <template v-if="node.kind !== 'barrier'">
              <text :x="node.x + 10" :y="node.y + 18" class="title">{{ node.title }}</text>
              <text :x="node.x + 10" :y="node.y + 32" class="sub">
                {{ node.persona }}<template v-if="laneLabel(node)"> · {{ laneLabel(node) }}</template>
              </text>
              <text v-if="node.fans" :x="node.x + 10" :y="node.y + 44" class="fan">
                {{ node.kind === 'bracket' ? 'two at a time from' : 'per' }} {{ node.fans }}
              </text>
            </template>
            <text v-else :x="node.x + node.width / 2" :y="node.y - 5" class="barrier-label">
              {{ node.title }}
            </text>
          </g>
          <text
            v-for="(edge, at) in shape.edges.filter((e) => e.label !== null)"
            :key="`label-${at}`"
            class="edge-label"
            x="0"
            y="0"
          >
            {{ edge.label }}
          </text>
        </svg>
        <figcaption>
          A bar across the lane is a barrier: everything above it has to arrive before anything
          below it starts. Everywhere else a step begins the moment its own predecessor finishes.
        </figcaption>
      </figure>

      <form class="start" @submit.prevent="startIt">
        <label>
          <span>Run it on</span>
          <textarea
            v-model="ask"
            rows="2"
            placeholder="What this execution is about — every step is given it."
          />
        </label>
        <div class="row">
          <label>
            <span>Repository</span>
            <select v-model="repositoryId">
              <option v-for="repo in props.repositories" :key="repo.id" :value="repo.id">
                {{ repo.displayName }}
              </option>
            </select>
          </label>
          <label>
            <span>Cap ($)</span>
            <input v-model="capUsd" type="number" min="0" step="0.5" />
          </label>
          <button
            type="submit"
            :disabled="working || ask.trim() === '' || props.threadId === null"
          >
            Start
          </button>
        </div>
      </form>

      <p v-if="notice" class="notice">{{ notice }}</p>

      <!--
        The claim this shape has to survive. A harness costs a run per step every time it is
        used, so "as good as a planner" is not a result in its favour — which is why the verdict
        is here, beside the button that spends money on it, rather than on a page nobody opens.
      -->
      <template v-if="trial !== null">
        <h4>Is it worth it?</h4>
        <p class="verdict" :class="trial.verdict">{{ trial.detail }}</p>
        <table class="arms">
          <thead>
            <tr>
              <th>Arm</th>
              <th>Tasks</th>
              <th>Taken</th>
              <th>Cost / task</th>
              <th>Runs / task</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="arm in trial.arms" :key="arm.arm">
              <th scope="row">{{ arm.arm === 'workflow' ? 'this harness' : 'a planner' }}</th>
              <td>{{ arm.decided }} of {{ arm.tasks }}</td>
              <td>{{ Math.round(arm.successRate * 100) }}%</td>
              <td>${{ arm.meanCostUsd.toFixed(4) }}</td>
              <td>{{ arm.meanRuns.toFixed(1) }}</td>
            </tr>
          </tbody>
        </table>

        <form class="trial" @submit.prevent="runNextTask">
          <label>
            <span>Run the next task of this class</span>
            <textarea
              v-model="trialTask"
              rows="2"
              placeholder="A task this harness exists for. The platform picks the side."
            />
          </label>
          <div class="row">
            <p class="hint">
              The next one goes to
              <strong>{{ trial.nextArm === 'workflow' ? 'the harness' : 'a planner' }}</strong
              >, because that is the side the trial is owed. You do not get to choose — an arm
              somebody picked is a comparison they made.
            </p>
            <button
              type="submit"
              :disabled="working || trialTask.trim() === '' || props.threadId === null"
            >
              Run it
            </button>
          </div>
        </form>
      </template>

      <h4 v-if="runs.length > 0">Executions</h4>
      <ul v-if="runs.length > 0" class="runs">
        <li v-for="run in runs" :key="run.id" :class="['run', run.status]">
          <button type="button" class="open" @click="show(run.id)">
            <span class="ask">{{ run.input }}</span>
            <span class="status">{{ run.status }}</span>
          </button>
          <button
            v-if="run.status === 'running'"
            type="button"
            class="stop"
            @click="stopIt(run.id)"
          >
            Stop
          </button>
          <p v-if="run.haltReason" class="halt">{{ run.haltReason }}</p>
        </li>
      </ul>

      <template v-if="openRun !== null">
        <h4>
          {{ openRun.workflowName }} v{{ openRun.version }} · {{ openRun.status }}
          <span v-if="money(openRun.spentUsd)" class="spent">
            {{ money(openRun.spentUsd) }}<template v-if="openRun.capUsd">
              of {{ money(openRun.capUsd) }}</template>
          </span>
        </h4>
        <p class="progress">{{ progress }}</p>
        <!--
          Steps as rows rather than as a tree, because a workflow is a DAG: a step often reads two
          predecessors, and naming one of them the parent would make the list assert something
          false about which answers that step actually had. The edges are in the diagram above.
        -->
        <ul class="steps">
          <li
            v-for="step in openRun.steps"
            :key="step.nodeId + step.pass + step.itemIndex + step.attempt"
          >
            <span class="node-id">{{ step.nodeId }}</span>
            <span v-if="step.item" class="item">{{ step.item }}</span>
            <span v-if="step.pass > 0" class="pass">pass {{ step.pass + 1 }}</span>
            <!--
              A retry is its own row rather than a replacement, because the try that answered
              nothing still cost a run and a reader deciding whether to trust this shape is owed
              the sight of it.
            -->
            <span v-if="step.attempt > 0" class="pass">try {{ step.attempt + 1 }}</span>
            <span :class="['status', step.status]">{{ step.status }}</span>
            <button
              v-if="step.agentRunId"
              type="button"
              class="link"
              @click="emit('open', step.agentRunId)"
            >
              Open run
            </button>
            <span v-if="step.reason" class="reason">{{ step.reason }}</span>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.empty,
.description,
.progress {
  color: var(--text-muted);
  font-size: 0.85rem;
  margin: 0;
}
.picker {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  list-style: none;
  margin: 0;
  padding: 0;
}
.pick {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
  padding: 0.2rem 0.7rem;
  font-size: 0.8rem;
}
.pick.on {
  border-color: var(--accent, #2f6feb);
  color: var(--accent, #2f6feb);
}
.version {
  opacity: 0.6;
  margin-left: 0.35rem;
}
.ceiling {
  background: var(--surface);
  border-radius: 6px;
  font-size: 0.78rem;
  margin: 0;
  padding: 0.5rem 0.6rem;
  white-space: pre-wrap;
}
.canvas {
  margin: 0;
  overflow-x: auto;
}
.canvas svg {
  max-width: 100%;
  height: auto;
}
figcaption {
  color: var(--text-muted);
  font-size: 0.75rem;
  padding-top: 0.3rem;
}
.edge {
  fill: none;
  stroke: var(--border);
  stroke-width: 1.4;
}
.edge.loop {
  stroke-dasharray: 4 3;
}
#wf-arrow path {
  fill: var(--border);
}
.node rect {
  fill: var(--surface, #fff);
  stroke: var(--border);
  stroke-width: 1.2;
}
.node.barrier rect {
  fill: var(--border);
  stroke: none;
}
.node.running rect {
  stroke: var(--accent, #2f6feb);
  stroke-width: 2;
}
.node.answered rect {
  stroke: #2f8f4e;
}
.node.refused rect {
  stroke: #b8402f;
}
.node.mixed rect {
  stroke: #b98a2f;
}
/** A bracket is the one node whose rows are rounds, and it reads as heavier for that reason. */
.node.bracket rect {
  stroke-width: 1.8;
}
.node.skipped rect {
  stroke-dasharray: 3 3;
  opacity: 0.55;
}
.title {
  font-size: 11px;
  fill: var(--text, #22252b);
}
.sub,
.fan,
.barrier-label {
  font-size: 9px;
  fill: var(--text-muted);
}
.barrier-label {
  text-anchor: middle;
}
.start,
.designer,
.decide,
.trial {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.designer label,
.decide label {
  display: flex;
  flex-direction: column;
  font-size: 0.75rem;
  gap: 0.15rem;
}
.designer .row,
.decide .row {
  align-items: flex-end;
  display: flex;
  gap: 0.5rem;
}
.hint,
.rationale {
  color: var(--text-muted);
  font-size: 0.78rem;
  margin: 0;
}
.proposals {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  list-style: none;
  margin: 0.2rem 0;
  padding: 0;
}
.trial label {
  display: flex;
  flex-direction: column;
  font-size: 0.75rem;
  gap: 0.15rem;
}
.trial .row {
  align-items: flex-end;
  display: flex;
  gap: 0.5rem;
}
.verdict {
  font-size: 0.8rem;
  margin: 0.2rem 0;
}
.verdict.planner,
.verdict.no-better {
  color: #b8402f;
}
.verdict.harness {
  color: #2f8f4e;
}
.arms {
  border-collapse: collapse;
  font-size: 0.75rem;
  width: 100%;
}
.arms th,
.arms td {
  border-bottom: 1px solid var(--border);
  padding: 0.15rem 0.3rem;
  text-align: left;
}
.start label {
  display: flex;
  flex-direction: column;
  font-size: 0.75rem;
  gap: 0.15rem;
}
.start .row {
  align-items: flex-end;
  display: flex;
  gap: 0.5rem;
}
.notice {
  font-size: 0.8rem;
  margin: 0;
  white-space: pre-wrap;
}
h4 {
  font-size: 0.85rem;
  margin: 0.4rem 0 0;
}
.spent {
  color: var(--text-muted);
  font-weight: 400;
}
.runs,
.steps {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  list-style: none;
  margin: 0;
  padding: 0;
}
.runs .open {
  background: none;
  border: none;
  cursor: pointer;
  display: flex;
  gap: 0.5rem;
  padding: 0;
  text-align: left;
  width: 100%;
}
.ask {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.steps li {
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  font-size: 0.78rem;
  gap: 0.4rem;
}
.node-id {
  font-family: var(--mono, ui-monospace, monospace);
}
.item,
.pass,
.reason,
.halt {
  color: var(--text-muted);
  font-size: 0.75rem;
}
.status.answered {
  color: #2f8f4e;
}
.status.refused {
  color: #b8402f;
}
.status.skipped {
  opacity: 0.6;
}
.link {
  background: none;
  border: none;
  color: var(--accent, #2f6feb);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0;
}
</style>
