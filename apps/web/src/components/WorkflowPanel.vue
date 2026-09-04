<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  describeWorkflowProgress,
  layoutWorkflow,
  type WorkflowDetail,
  type WorkflowRow,
  type WorkflowRunDetail,
  type WorkflowRunRow,
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

const select = async (workflowId: string) => {
  selectedId.value = workflowId
  openRun.value = null
  notice.value = null
  working.value = true
  try {
    detail.value = await props.read(workflowId)
    runs.value = await props.listRuns(workflowId)
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
                per {{ node.fans }}
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
          <li v-for="step in openRun.steps" :key="step.nodeId + step.pass + step.itemIndex">
            <span class="node-id">{{ step.nodeId }}</span>
            <span v-if="step.item" class="item">{{ step.item }}</span>
            <span v-if="step.pass > 0" class="pass">pass {{ step.pass + 1 }}</span>
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
  color: var(--muted, #667);
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
  border: 1px solid var(--line, #d5d8de);
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
  background: var(--surface-2, #f6f7f9);
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
  color: var(--muted, #667);
  font-size: 0.75rem;
  padding-top: 0.3rem;
}
.edge {
  fill: none;
  stroke: var(--line, #c7ccd4);
  stroke-width: 1.4;
}
.edge.loop {
  stroke-dasharray: 4 3;
}
#wf-arrow path {
  fill: var(--line, #c7ccd4);
}
.node rect {
  fill: var(--surface, #fff);
  stroke: var(--line, #c7ccd4);
  stroke-width: 1.2;
}
.node.barrier rect {
  fill: var(--line, #b9bfc9);
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
  fill: var(--muted, #6a707c);
}
.barrier-label {
  text-anchor: middle;
}
.start {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
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
  color: var(--muted, #667);
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
  color: var(--muted, #667);
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
