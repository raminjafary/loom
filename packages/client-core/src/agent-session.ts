import type {
 AgentPersona,
 AgentRun,
 ApprovalRequest,
 AtlasEdge,
 Capability,
 PlanReview,
 CostSummary,
 DirectoryListing,
 MasteryView,
 ColosseumSession,
 ColosseumView,
 SubjectMap,
 SubjectMapListing,
 PersonaCapability,
 PersonaRevision,
 PromptTrial,
 MergeQueueEntry,
 RunVerification,
 NotificationConfig,
 DelegationEdge,
 DelegationPreview,
 PersonaDraft,
 PersonaGroup,
 Repository,
 ResponseStyle,
 RunControl,
 Runner,
 SwarmBoard,
 WorkerNote,
} from '@loom/api-contract'
import type { LoomApi } from './api.js'
import type { PushRegistration } from './push.js'

/**
 * Agent-pipeline client logic, separate from
 * `WorkspaceSession` — chat and agent-run state change independently and
 * mixing them would force every chat-only view to also carry run/approval
 * concerns.
 *
 * There is no realtime frame for agent-run/approval state (`ServerEvent` only
 * carries message/channel/thread — see workspace-session.ts), and rather than
 * extend that contract this session re-reads the real objects. What *drives* that
 * re-read is the socket, not a clock: every run transition already posts a thread
 * message, so a frame arriving is the earliest signal the structured state behind
 * it is stale. See `noteRealtimeActivity`; the interval underneath is a safety net
 * for what posts no message at all.
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
/**
 * The safety net behind `noteRealtimeActivity`, not the primary mechanism.
 *
 * It was 1.5s, because it was the only thing keeping run state current. Now that a
 * gateway frame drives the refresh, this only has to cover what produces no thread
 * message at all — a queue advancing on the server's own sweep, a run reaped for
 * inactivity — and covering that ten times a minute is enough.
 */
const POLL_INTERVAL_MS = 10_000
/**
 * How long a live-activity frame stays worth drawing.
 *
 * Long enough that an animation started on arrival finishes, short enough that a
 * quiet canvas is visibly quiet — a stale pulse is worse than none, because the whole
 * claim the canvas makes is "this is happening now".
 */
const ACTIVITY_TTL_MS = 6_000
/** Long enough to coalesce a burst of tool events, short enough to feel immediate. */
const NUDGE_DEBOUNCE_MS = 150

export interface AgentSnapshot {
 readonly runners: Runner[]
 readonly repositories: Repository[]
 readonly personas: AgentPersona[]
 readonly personaGroups: PersonaGroup[]
 /**
 * Which planner may delegate to which persona, and why not. Computed server-side by the rules
 * that refuse a child start, so a canvas cannot draw a team the runtime refuses.
 *
 * Re-read whenever a persona changes, because every one of these edges is a
 * statement about two personas — editing one silently invalidates a row of them.
 */
 readonly delegationMatrix: DelegationEdge[]
 /** The capability registry and its attachments. */
 readonly capabilities: Capability[]
 readonly capabilityAttachments: PersonaCapability[]
 /**
 * Every persona's superseded prompts, newest first.
 *
 * Workspace-wide in one read rather than per persona, because the question a human has
 * is "did an agent rewrite any of these" and asking it per row is one query per row.
 * The newest entry for a persona names who wrote the version that is live *now*.
 */
 readonly personaRevisions: PersonaRevision[]
 /**
 * What the runs so far say about each persona's live self-edit, keyed
 * by persona id. Absent means nothing is being measured, which is the ordinary state.
 */
 readonly promptTrials: Record<string, PromptTrial>
 /**
 * The run this client is *watching* — the one whose approvals and diff the
 * workspace view shows. Distinct from `activeRuns` now that a workspace may run
 * several at once: a human watches one at a time even when
 * three are executing.
 */
 readonly activeRun: AgentRun | null
 /** Everything currently executing in the workspace. */
 readonly activeRuns: AgentRun[]
 readonly pendingApprovals: ApprovalRequest[]
 /**
 * The serialized merge queue, workspace-wide and in
 * `position` order. Polled with the rest rather than pushed: a queue advances on
 * the server's sweep, so a client that only re-read it on its own actions would
 * show a stale one exactly while it is doing the interesting thing.
 */
 readonly mergeQueue: MergeQueueEntry[]
 /**
 * The watched run's tree: its worker-notes ledger and the board rendering of it
 *.
 *
 * Keyed to whichever run this client is watching rather than workspace-wide,
 * because a ledger belongs to a *tree*: two unrelated goals have two ledgers, and
 * merging them on screen would show a human context that does not apply.
 *
 * Null until a run is being watched. `treeNotes` carries `authorKind`, which a view
 * is required to honour — agent-authored prose must be rendered as untrusted.
 */
 readonly swarmBoard: SwarmBoard | null
 readonly treeNotes: WorkerNote[]
 /**
 * Workspace spend.
 *
 * Workspace-wide rather than keyed to the watched run, unlike `swarmBoard` — and
 * that is the whole reason it is a separate fetch. The cost model asks "what is this workspace
 * costing", which no rollup of one tree can answer, and a human deciding whether a
 * model tier is worth it is asking about all of them.
 */
 readonly costSummary: CostSummary | null
 /**
 * Run id → persona name, for every run this client has heard of.
 *
 * The thread needs it and cannot derive it: a message's author is an
 * `agent_run` actor carrying an opaque id, and a thread outlives the runs in it.
 * Keyed by run and never evicted, because a run's persona name is fixed once the
 * run exists — so a finished run keeps its name after it leaves every list.
 * `resolvePersonaNames` fills the gaps for runs that predate this session.
 */
 readonly personaNameByRunId: Record<string, string>
 /**
 * The pairing token just minted, shown once.
 *
 * Carries the `name` the operator typed as well as the id, because the id is what
 * the contract returns and a uuid is not what anyone called the machine they are
 * standing at — the banner used to identify a single-use secret by the one field
 * in it that means nothing to a human.
 */
 readonly lastPairing: { runnerId: string; name: string; rawToken: string } | null
 readonly diff: string | null
 // Inbox — runs needing a human decision, workspace-wide.
 readonly needsAttention: AgentRun[]
 /**
 * What the swarm produced and a human already decided about.
 *
 * The other half of the Inbox board. Kept separate from `needsAttention` rather than
 * merged into one list, because the two are ordered by different things and for
 * different reasons — oldest-first there, since the longest wait is closest to the
 * approval SLA, and newest-first here, because it is a record.
 */
 readonly settledRuns: AgentRun[]
 /**
 * What each of those runs' branches did against its repository's definition of done
 *.
 *
 * Fetched beside them rather than folded onto the run, because a verification lands
 * minutes after the run it belongs to: a field on `AgentRun` would be one the run's
 * own poll kept re-reading as null until it was not.
 */
 readonly runVerifications: RunVerification[]
 // The run being reviewed from the Inbox — independent of `activeRun`,
 // since a human can review a past run's approval/diff without it being
 // the one currently executing.
 readonly inspectedRun: AgentRun | null
 readonly inspectedApprovals: ApprovalRequest[]
 // Global kill switch — null until `init` has read it, so the UI
 // can tell "not loaded yet" apart from "loaded, not paused".
 readonly runControl: RunControl | null
 // Notifications. Null until `init` has read it; a
 // `transport: null` value means this deployment has none configured, which a
 // client must show as such rather than as "not subscribed".
 readonly notificationConfig: NotificationConfig | null
 readonly loading: boolean
 readonly error: string | null
 /**
 * Per-surface failures, because a panel that renders its empty state on a failed
 * fetch tells the human the opposite of what happened.
 *
 * There is one global `error`, and it is not enough for these four. It is shared by
 * ~35 actions and rendered in a banner at the top of the page, so a failed Inbox
 * fetch produces "Nothing needs you right now" in the list — the single most
 * dangerous false statement this app can make — with the real reason somewhere
 * above, or replaced already by the next error to arrive.
 *
 * Only the surfaces whose empty state is indistinguishable from failure get one.
 * A panel whose fetch failure is visible some other way does not need a field here.
 */
 readonly fetchErrors: {
 readonly inbox: string | null
 readonly board: string | null
 readonly cost: string | null
 readonly diff: string | null
 }
 /**
 * How many runs the last kill-switch press actually cancelled.
 *
 * `runControl.pauseAll` has always returned `cancelledRunIds`; this client
 * destructured `{ control }` and dropped it, so the button reported "Runs paused"
 * and never what it had stopped. A stop control that will not say what it stopped
 * leaves a human to go and count, which is the opposite of one button.
 *
 * Null until a pause happens in this session — "not pressed here" is not "pressed,
 * and it killed nothing", and zero is a real and reassuring answer.
 */
 readonly lastPauseCancelledCount: number | null
 /**
 * Recent live-activity frames for the watched tree.
 *
 * A short, self-expiring buffer rather than a log: its only consumer is the canvas,
 * which asks "is anything crossing this edge *right now*". Frames older than
 * `ACTIVITY_TTL_MS` are dropped on every insert, so a tab left open overnight holds
 * nothing, and a client that never renders them pays one array write per frame.
 *
 * Not a source of truth. The board fetch remains the answer to what a swarm is
 * doing; this only says what just happened, and a dropped frame costs an animation
 * rather than a wrong tree.
 */
 readonly recentActivity: RunActivity[]
}

/** One live-activity frame, narrowed to what a canvas can draw. */
export interface RunActivity {
 readonly agentRunId: string
 readonly parentRunId: string | null
 readonly kind:
 | 'started'
 | 'tool_call'
 | 'tool_result'
 | 'delegated'
 | 'note_written'
 | 'awaiting_human'
 | 'finished'
 readonly label: string | null
 readonly at: number
}

export interface AgentSession {
 snapshot: AgentSnapshot
 onChange(listener: (snapshot: AgentSnapshot) => void): => void
 init: Promise<void>
 /**
 * Re-reads everything `init` reads, without the loading flag.
 *
 * Exists because the 1.5s poll is scoped to a *watched run* and stops once nothing
 * is active, so a page that has been sitting open shows whatever it last saw — a
 * merged branch, a finished reconciler and a new note all arrive invisibly. Clients
 * call this on focus rather than adding a second timer: the deliberate decision not
 * to poll continuously (see the Inbox) is about background cost, and a tab nobody is
 * looking at is exactly the case that decision is protecting.
 */
 refresh: Promise<void>
 createPairingToken(name: string): Promise<void>
 bindRepository(input: { runnerId: string; path: string; displayName: string }): Promise<void>
 /**
 * Browses a Runner's allowed roots. Returns rather than patching
 * state: a picker is transient UI a client opens, walks and closes, and parking
 * a filesystem cursor in the session snapshot would make every other view
 * re-render on every keystroke of browsing.
 */
 listDirectory(input: { runnerId: string; path: string }): Promise<DirectoryListing>
 createRepository(input: {
 runnerId: string
 parentPath: string
 name: string
 displayName: string
 }): Promise<void>
 /**
 * Authors a persona. Returns its id, or null when the server refused — the composition
 * canvas adds a newly authored planner to the team in the same gesture, and
 * doing that by name against a refreshed list would be guessing.
 */
 createPersona(markdownSource: string): Promise<string | null>
 /**
 * Parses a draft without saving it. This is how a
 * client reads the persona format: the same parser the write path uses, reached
 * through the contract, so the form can never show fields a save would not store.
 */
 parsePersona(markdownSource: string): Promise<PersonaDraft>
 /**
 * A persona's maps.
 *
 * Not part of the session snapshot, deliberately: expertise is per persona and a
 * workspace has many, so folding every map into the snapshot would put an unbounded
 * read on the path that opens the app. These are fetched when a human looks.
 */
 listPersonaMaps(personaId: string): Promise<SubjectMapListing[]>
 getMastery(mapId: string): Promise<MasteryView | null>
 listRepositoryMaps(repositoryId: string): Promise<SubjectMapListing[]>
 /**
 * Every map in the workspace — what the design canvas shows per
 * member. Returns `[]` on failure, like the other decorating reads: a canvas without
 * its badges is worse, not broken.
 */
 listWorkspaceMaps: Promise<SubjectMapListing[]>
 /**
 * Which maps one run was handed, and which it was deliberately denied.
 *
 * Returns `[]` on failure, like `listRepositoryMaps`: it decorates a run that is
 * otherwise complete, so a failure here should cost the badge and never the view.
 */
 listExpertiseUsedByRuns(agentRunIds: readonly string[]): Promise<
 {
 agentRunId: string
 map: SubjectMap
 arm: 'retrieved' | 'withheld'
 nodesShown: number
 edgesShown: number
 }[]
 >
 /**
 * The venue. Read-only from the client except for convening, recording an opening
 * claim and settling one — there is deliberately no path that writes a map from a
 * session, because a session's output is claims with verdicts and promotion is a
 * human act.
 */
 /**
 * The atlas's write side — the queue, and the two acts on it.
 *
 * There is deliberately no `propose`. A relation is proposed by a run that followed a
 * lead and went and looked; a human drawing one here would record a relation nobody
 * checked with the same status as one that was.
 */
 /**
 * Reviewing a plan before it builds.
 *
 * No `submit`: a decomposition comes from a Planner over the Runner channel. What a human
 * does is decide, and the three acts cost different things — accepting spends the plan,
 * asking for changes spends another planning turn, rejecting spends nothing.
 */
 getPlanForReview(agentRunId: string): Promise<PlanReview | null>
 acceptPlan(agentRunId: string): Promise<{ started: number } | null>
 requestPlanChanges(input: { agentRunId: string; note: string }): Promise<boolean>
 rejectPlan(input: { agentRunId: string; reason?: string }): Promise<boolean>
 setPlanReviewRequired(required: boolean): Promise<void>
 listAtlasProposals(input?: {
 status?: ('proposed' | 'contended' | 'promoted' | 'rejected')[]
 }): Promise<AtlasEdge[]>
 contendAtlasProposal(input: {
 edgeId: string
 threadId: string
 }): Promise<{ edge: AtlasEdge; sessionId: string | null } | null>
 decideAtlasProposal(input: {
 edgeId: string
 decision: 'promoted' | 'rejected'
 note?: string
 }): Promise<AtlasEdge | null>
 listColosseumSessions: Promise<ColosseumSession[]>
 getColosseumSession(sessionId: string): Promise<ColosseumView | null>
 conveneColosseum(input: {
 threadId: string
 repositoryId: string | null
 purpose: 'consultation' | 'contention' | 'crunching' | 'warm_up'
 subject: string
 question: string
 personaIds: string[]
 }): Promise<string | null>
 recordColosseumClaim(input: {
 sessionId: string
 personaId: string
 statement: string
 }): Promise<void>
 settleColosseumClaim(input: {
 claimId: string
 verdict: 'upheld' | 'refuted'
 citation: string
 }): Promise<void>
 /**
 * Asks one participant to speak. `personaId` omitted means whoever has gone
 * longest without it.
 *
 * Returns the refusal rather than swallowing it, because every refusal here is a fact
 * about the session — the floor is taken, the cap is used up, there is no repository to
 * answer from — and a button that silently does nothing teaches a human that the venue
 * is broken.
 */
 takeColosseumTurn(input: { sessionId: string; personaId?: string }): Promise<{
 ok: boolean
 reason: string
 speakerPersonaName: string | null
 } | null>
 concludeColosseum(sessionId: string): Promise<void>
 /** A human's standing answer about whether a map is used. */
 setMapRetrieval(mapId: string, override: 'on' | 'off' | null): Promise<void>
 /**
 * One curation pass over one map. Returns what it did, which is the whole
 * content of the act: what was re-checked, kept, retired, and proposed for next time.
 */
 curateMap(mapId: string): Promise<{
 checked: number
 kept: number
 retired: number
 proposed: number
 withdrawn: number
 } | null>
 /**
 * Starts a mastery run, which
 * means it is subject to the concurrency limit, the kill switch and the budget cap
 * like anything else. Returns null and sets the session error on refusal, the same
 * shape as `startRun`.
 */
 startMastery(input: {
 threadId: string
 personaId: string
 repositoryId: string
 task?: string
 /**
 * What is being mastered. An `author` subject's corpus is the
 * repository's history for that person, which is why the repository is required
 * either way.
 */
 subjectKind?: 'repository' | 'author'
 subjectRef?: string
 /** What kind of expertise to grasp — a closed vocabulary. */
 focus?: string[]
 /** The human's own words, for what the vocabulary cannot express. */
 guidance?: string
 }): Promise<string | null>
 /**
 * Who this planner could delegate to under a launcher's overrides.
 * Server-side for the same reason `parsePersona` is: these are the rules that refuse
 * a child start, and a client that guessed could reassure a human about a run the
 * gate then refuses.
 */
 previewDelegation(input: {
 personaId: string
 model?: string
 budgetCapUsd?: number | null
 }): Promise<DelegationPreview>
 /**
 * Edits an existing persona, **including a built-in**.
 *
 * Built-ins are ordinary rows, not a protected class: `seedBuiltinPersonas` inserts
 * one only when no persona of that name exists, so an edited built-in survives every
 * later seed rather than being silently reverted. That is what makes editing them
 * safe to offer — and editing them is the only way to change a shipped persona's
 * harness settings, `approvalMode` above all, without forking it under a new name.
 */
 updatePersona(input: { personaId: string; markdownSource: string }): Promise<void>
 /**
 * Removes a persona. Loses no history — a run snapshots its persona at start — so
 * the server only refuses while a run of that persona is in flight.
 */
 deletePersona(personaId: string): Promise<void>
 /** Takes the shipped version of a built-in, discarding what the row said. */
 resetPersonaToBuiltin(personaId: string): Promise<void>
 /**
 * Puts a superseded prompt back. The half of self-editing that
 * makes the other half an acceptable trade: an agent rewrites itself without asking,
 * and a human who disagrees undoes it in one click.
 */
 revertPersonaPrompt(input: { personaId: string; revisionId: string }): Promise<void>
 /** Ends a trial by keeping the agent's edit. */
 keepPersonaRevision(input: { personaId: string; revisionId: string }): Promise<void>
 /**
 * Unbinds a repository, deleting its runs and their recorded spend with it.
 * Resolves `{ ok: false, reason }` when the server wants that loss acknowledged,
 * so a caller can show the count before asking again with `acknowledge`.
 */
 unbindRepository(input: {
 repositoryId: string
 acknowledge?: boolean
 }): Promise<{ ok: boolean; reason: string | null }>
 /** Forgets a Runner. Refused while any repository is still bound to it. */
 removeRunner(runnerId: string): Promise<{ ok: boolean; reason: string | null }>
 registerCapability(input: {
 kind: 'mcp' | 'skill'
 name: string
 description: string
 transport?: 'stdio' | 'sse' | 'http' | null
 command?: string | null
 args?: string[]
 url?: string | null
 content?: string | null
 /** Hosts this grant opens through the egress proxy. Empty means none. */
 egressHosts?: string[]
 }): Promise<void>
 removeCapability(capabilityId: string): Promise<void>
 attachCapability(input: { personaId: string; capabilityId: string; allowedTools?: string[] }): Promise<void>
 detachCapability(input: { personaId: string; capabilityId: string }): Promise<void>
 createPersonaGroup(input: { name: string; personaIds: string[] }): Promise<void>
 updatePersonaGroup(input: {
 personaGroupId: string
 name: string
 personaIds: string[]
 /** Canvas positions. Omitted leaves the stored ones alone. */
 layout?: Record<string, { x: number; y: number }>
 /**
 * How many of each member the team runs at once. Omitted leaves the
 * stored widths alone; the server refuses a width of 0 or one past the ceiling rather
 * than storing a number that would then refuse every run of that persona.
 */
 fleet?: Record<string, number>
 /** Who reviews whom on this team. Omitted leaves it alone. */
 reviewers?: Record<string, string[]>
 /**
 * The chain of command, keyed by **worker**. Omitted leaves it alone;
 * `{}` clears it, which is a real state — an unassigned member is offered to every
 * planner's roster, which is what every team does today.
 */
 reportsTo?: Record<string, string>
 /** What this team is for. Omitted leaves the stored line alone. */
 description?: string
 /**
 * The other repositories this team's subtasks may name. Omitted
 * leaves them alone; `[]` clears them.
 */
 extraRepositoryIds?: string[]
 /**
 * Which member the work starts from, as the canvas's vantage for
 * depth. Omitted leaves the stored root alone; `null` clears it back to
 * picked-by-reach, which is a different act.
 */
 orchestratorId?: string | null
 /**
 * Which repository this team's work lands in. Omitted leaves the
 * stored choice alone; `null` un-chooses it, on the same terms as `orchestratorId`.
 */
 repositoryId?: string | null
 }): Promise<void>
 deletePersonaGroup(personaGroupId: string): Promise<void>
 startRun(input: {
 threadId: string
 repositoryId: string
 personaId: string
 task?: string
 /** How much prose this run should produce. */
 responseStyle?: ResponseStyle
 /** Overrides the persona's model for this run only. */
 model?: string
 /** Overrides the persona's spend ceiling for this run only; null is uncapped. */
 budgetCapUsd?: number | null
 }): Promise<void>
 /**
 * Switches which of several concurrent runs this client is watching. Does not stop or change anything server-side — it is purely which
 * run's approvals and diff are on screen.
 */
 watchRun(agentRunId: string): Promise<void>
 /** `answer` carries the reply when the gate is a clarifying question. */
 decide(
 approvalRequestId: string,
 decision: 'approve' | 'deny',
 answer?: string,
): Promise<void>
 /**
 * Re-enters a Planner with a message and lets it change its own plan. Switches the watched run to the steering turn, because
 * that is the run a human then wants to read: it is where the delta and the
 * refusals appear.
 */
 steer(agentRunId: string, message: string): Promise<void>
 loadDiff(agentRunId: string): Promise<void>
 keepRun(agentRunId: string): Promise<void>
 discardRun(agentRunId: string): Promise<void>
 pushRun(agentRunId: string, acknowledgeCiChange?: boolean): Promise<void>
 /**
 * Queues a finished run's branch. Deliberately not
 * `mergeRun`: nothing merges here, and naming it for the outcome would hide that
 * the merge happens later, in order, behind other branches.
 *
 * Returns the server's refusal rather than parking it in `error`, for the same reason
 * `unbindRepository` does: a reviewer's blocker is a *question*
 * for the human — "your reviewer says do not merge this; do you disagree?" — and
 * `override` is their answer to it. A banner is the wrong place for a question.
 */
 enqueueMerge(agentRunId: string, override?: boolean): Promise<{ ok: boolean; reason: string | null }>
 cancelMerge(entryId: string): Promise<void>
 refreshMergeQueue: Promise<void>
 /**
 * Re-reads the watched run's tree ledger and board.
 *
 * Exposed as its own action as well as being polled, because a human writing a note
 * expects to see it, and the poll only runs while something in the tree is still
 * executing.
 */
 refreshBoard(agentRunId: string): Promise<void>
 /** Workspace spend. `windowHours` null or omitted means all time. */
 refreshCostSummary(windowHours?: number | null): Promise<void>
 /**
 * Adds a human's note to a tree — authoritative, and rendered to workers outside
 * the untrusted fence. There is deliberately no client path to
 * write an *agent-authored* note: `authorKind` is a provenance fact, and a client
 * able to set it could launder its own text into every later worker's trusted
 * context.
 */
 writeNote(input: {
 agentRunId: string
 kind: 'finding' | 'decision' | 'blocker'
 title: string
 body: string
 paths?: string[]
 }): Promise<void>
 /** What the merge queue runs before merging into this repository; null merges unverified. */
 setVerifyCommand(repositoryId: string, verifyCommand: string | null): Promise<void>
 /**
 * This repository's definition of done. The whole list, because the order is a dependency order.
 */
 setVerificationChecks(
 repositoryId: string,
 checks: { name: string; command: string }[],
): Promise<void>
 /**
 * Whether a reconciler may attempt a conflicted branch in this repository. The operator-wide `LOOM_RECONCILER_ENABLED` still wins when it is
 * off — this is the policy, not an override of the switch.
 */
 setReconcilerEnabled(repositoryId: string, enabled: boolean): Promise<void>
 /** What warms this repository's dependency cache. */
 setInstallCommand(repositoryId: string, installCommand: string | null): Promise<void>
 /** Runs it. Resolves with the failure detail when the install did not succeed. */
 warmCache(repositoryId: string): Promise<{ ok: boolean; detail: string | null }>
 /**
 * The raw transcript tier's "expand raw". Returns rather than
 * patching the snapshot: it is a large, explicitly-requested artifact, and
 * parking it in shared state would push it into every view that reads a run.
 */
 getRawTranscript(agentRunId: string): Promise<{ lines: string[]; chunks: number }>
 refreshInbox: Promise<void>
 inspectRun(agentRunId: string): Promise<void>
 /**
 * Closes the review overlay.
 *
 * Clears the diff and its error with the run, not only the run: reopening a *different*
 * card would otherwise show the previous one's diff underneath a new header for as long
 * as the fetch takes, which is the worst moment to show someone the wrong branch.
 */
 clearInspectedRun: void
 /**
 * Registers where this client can be reached. The caller obtains
 * the registration from its own runtime — `PushManager.subscribe` in a
 * browser — since granting permission is inherently a platform interaction;
 * this only carries the result to the server.
 */
 registerNotificationTarget(registration: PushRegistration): Promise<void>
 unregisterNotificationTarget(endpoint: string): Promise<void>
 /** Kill switch: stops everything in flight and blocks new starts. */
 pauseAllRuns: Promise<void>
 /** Lifts the pause. Never restarts what the pause cancelled. */
 resumeAllRuns: Promise<void>
 /**
 * When the platform *suggests* a handoff, and how many one tree may make.
 *
 * Neither setting swaps an agent: the threshold decides when a filling run is told its
 * own number, and the cap is the one bound the platform enforces on its own. Null on
 * either restores the platform's default.
 */
 setHandoffPolicy(input: { threshold: number | null; capPerTree: number | null }): Promise<void>
 /**
 * Tells this session that something happened in the workspace *now* — called with
 * every realtime frame the workspace session receives.
 *
 * Run state has no realtime frame of its own, but every transition worth showing
 * already posts a thread message, and those are fanned out immediately. This is how
 * the socket drives the refresh that an interval used to chase. Safe to call as
 * often as frames arrive: it coalesces, and does nothing when no run is watched.
 */
 noteRealtimeActivity: void
 /**
 * Feeds one `run.activity` frame in. Called by whoever owns the
 * socket; the session decides whether it belongs to the watched tree and expires it.
 */
 noteRunActivity(activity: RunActivity, treeRunId: string): void
 /**
 * Fills in persona names for runs this session never saw — the ones whose messages
 * are in the thread's history but which finished before the page was opened.
 *
 * Called by the view with the author ids it is about to render. Deduplicated,
 * bounded per call, and it never asks twice about a run the server would not
 * resolve, so a thread scrolled far back does not become a burst of requests.
 */
 resolvePersonaNames(agentRunIds: readonly string[]): Promise<void>
 dispose: void
}

const errorMessage = (error: unknown): string =>
 error instanceof Error ? error.message: String(error)

export const createAgentSession = (options: { api: LoomApi }): AgentSession => {
 let state: AgentSnapshot = {
 runners: [],
 repositories: [],
 personas: [],
 personaGroups: [],
 delegationMatrix: [],
 capabilities: [],
 capabilityAttachments: [],
 personaRevisions: [],
 promptTrials: {},
 activeRun: null,
 activeRuns: [],
 pendingApprovals: [],
 mergeQueue: [],
 swarmBoard: null,
 costSummary: null,
 personaNameByRunId: {},
 treeNotes: [],
 lastPairing: null,
 diff: null,
 needsAttention: [],
 settledRuns: [],
 runVerifications: [],
 inspectedRun: null,
 inspectedApprovals: [],
 runControl: null,
 notificationConfig: null,
 loading: false,
 error: null,
 fetchErrors: { inbox: null, board: null, cost: null, diff: null },
 lastPauseCancelledCount: null,
 recentActivity: [],
 }

 /**
 * `patch` replaces top-level keys wholesale, so a surface clearing its own error
 * must not clear the other three. One helper rather than three spread expressions
 * at every call site, which is how one of them ends up wrong.
 */
 const patchFetchError = (
 key: keyof AgentSnapshot['fetchErrors'],
 message: string | null,
): void => {
 patch({ fetchErrors: {...state.fetchErrors, [key]: message } })
 }

 const listeners = new Set<(snapshot: AgentSnapshot) => void>
 let pollTimer: ReturnType<typeof setInterval> | null = null
 let nudgeTimer: ReturnType<typeof setTimeout> | null = null

 const patch = (next: Partial<AgentSnapshot>) => {
 state = {...state,...next }
 for (const listener of listeners) listener(state)
 }

 /**
 * Learns run → persona name from whatever was just fetched.
 *
 * Every read that returns a run passes through here, so the thread can name an
 * author without a second round-trip. Accumulating rather than replacing: a run
 * that finishes leaves `activeRuns`, and its messages stay in the thread.
 */
 const rememberPersonaNames = (
 entries: ReadonlyArray<{ id: string; name: string } | null | undefined>,
) => {
 let changed = false
 const next = {...state.personaNameByRunId }
 for (const entry of entries) {
 if (!entry || next[entry.id] === entry.name) continue
 next[entry.id] = entry.name
 changed = true
 }
 if (changed) patch({ personaNameByRunId: next })
 }

 const fromRuns = (runs: readonly AgentRun[]) =>
 runs.map((run) => ({ id: run.id, name: run.persona.name }))

 /** Run ids already asked about, so a run the server cannot resolve is asked about once. */
 const resolvedRunIds = new Set<string>

 /**
 * The Inbox and the merge queue are read together, deliberately: they are the
 * same question ("what is outstanding") split by whether a human or the queue is
 * the one who has to act, and a merge that just failed becomes an Inbox item.
 * Refreshing one while leaving the other stale is how a human ends up deciding
 * against a screen that disagrees with itself.
 */
 const fetchInbox = async : Promise<void> => {
 try {
 // Three reads in one round trip, and in one patch. The board is built from all
 // three, and refreshing them separately is how a column ends up describing a run
 // the column beside it also claims.
 const [needsAttention, settledRuns, mergeQueue] = await Promise.all([
 options.api.agentRun.listNeedsAttention,
 options.api.agentRun.listSettled({}),
 options.api.mergeQueue.list,
 ])
 /**
 * Second round trip, deliberately: it takes the run ids the first one returned.
 * Its failure is swallowed and the board renders without the verdicts — an Inbox
 * that could not be shown because a verification lookup failed would be the
 * feature taking the surface down with it.
 */
 const agentRunIds = [...new Set([...needsAttention,...settledRuns].map((run) => run.id))]
 const runVerifications =
 agentRunIds.length === 0
 ? []
: await options.api.agentRun
.listVerifications({ agentRunIds: agentRunIds.slice(0, 200) })
.catch( => [])
 patch({ needsAttention, settledRuns, mergeQueue, runVerifications })
 patchFetchError('inbox', null)
 rememberPersonaNames(fromRuns([...needsAttention,...settledRuns]))
 } catch (error) {
 // Both the banner and the surface: the banner is what a human scanning the page
 // sees, and the surface is what stops the empty list reading as "all clear".
 patch({ error: errorMessage(error) })
 patchFetchError('inbox', errorMessage(error))
 }
 }

 /**
 * The watched tree's ledger and board. Both in one call for
 * the reason the worker-notes design gives for them being one object: fetched apart, a board and
 * a note list could disagree about what a swarm is doing, which is exactly the
 * second source of truth the design refuses.
 */
 const fetchBoard = async (agentRunId: string): Promise<void> => {
 try {
 const [swarmBoard, treeNotes] = await Promise.all([
 options.api.workerNote.board({ agentRunId }),
 options.api.workerNote.listByTree({ agentRunId }),
 ])
 patch({ swarmBoard, treeNotes })
 patchFetchError('board', null)
 // The board is the best source there is for a *tree*: one card per run,
 // each already carrying the persona that ran it.
 rememberPersonaNames(
 (swarmBoard?.cards ?? []).map((card) => ({ id: card.runId, name: card.personaName })),
)
 } catch (error) {
 patch({ error: errorMessage(error) })
 patchFetchError('board', errorMessage(error))
 }
 }

 /**
 * Kept out of `fetchBoard`'s `Promise.all` deliberately: the board is per-tree and
 * refreshes on the run poll, while spend is workspace-wide and changes slowly. Folding
 * them together would re-aggregate the whole workspace on every two-second tick to
 * redraw a number that had not moved.
 */
 const fetchCostSummary = async (windowHours: number | null): Promise<void> => {
 try {
 patch({ costSummary: await options.api.cost.summary({ windowHours }) })
 patchFetchError('cost', null)
 } catch (error) {
 patch({ error: errorMessage(error) })
 patchFetchError('cost', errorMessage(error))
 }
 }

 const fetchInspected = async (agentRunId: string): Promise<void> => {
 try {
 const [run, inspectedApprovals] = await Promise.all([
 options.api.agentRun.get({ agentRunId }),
 options.api.approval.listPending({ agentRunId }),
 ])
 patch({ inspectedRun: run, inspectedApprovals })
 rememberPersonaNames([{ id: run.id, name: run.persona.name }])
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 }

 const stopPolling = => {
 if (pollTimer !== null) {
 clearInterval(pollTimer)
 pollTimer = null
 }
 }

 /**
 * One pass over the watched run's structured state. Both the socket nudge and the
 * safety-net timer go through here, so the two can never disagree about what a
 * refresh consists of.
 */
 const syncWatchedRun = async (agentRunId: string): Promise<void> => {
 try {
 const [run, pendingApprovals, activeRuns] = await Promise.all([
 options.api.agentRun.get({ agentRunId }),
 options.api.approval.listPending({ agentRunId }),
 // Together rather than on their own timers: a swarm's membership changes
 // exactly when its runs do, and a second schedule would just be a second
 // thing to get out of step.
 options.api.agentRun.listActive,
 ])
 patch({ activeRun: run, pendingApprovals, activeRuns })
 rememberPersonaNames([{ id: run.id, name: run.persona.name },...fromRuns(activeRuns)])
 // For the reason `listActive` is here: a sibling writing a note is the tree
 // changing, and a separate schedule would only be another thing to drift.
 await fetchBoard(agentRunId)
 /**
 * The merge queue rides the same pass, by that same sentence: it became part of
 * this view rather than a panel beside it when the graph started drawing it
 *, and an entry advances on the server's own sweep while a human
 * is watching — so left on the Inbox's schedule the band would be stale exactly
 * while it is being looked at.
 *
 * **After the patch above and guarded on its own**, deliberately. The three calls
 * this poll exists for are in the `Promise.all`, whose failure stops the poll
 * entirely — correct for them, and wrong for this: a queue list that 500s must not
 * be able to freeze the watched run's own state. Its failure lands on the surface
 * the Inbox already reports the queue's failures on, so it is not silent either.
 */
 try {
 patch({ mergeQueue: await options.api.mergeQueue.list })
 } catch (error) {
 patchFetchError('inbox', errorMessage(error))
 }
 // Keeps watching while *others* are still running, so a sibling finishing still
 // updates the list — stopping on the watched run alone would freeze the swarm
 // view at whatever it looked like when this one ended.
 if (TERMINAL_STATUSES.has(run.status) && activeRuns.length === 0) stopPolling
 } catch (error) {
 patch({ error: errorMessage(error) })
 stopPolling
 }
 }

 const pollActiveRun = (agentRunId: string) => {
 stopPolling
 pollTimer = setInterval( => {
 void syncWatchedRun(agentRunId)
 }, POLL_INTERVAL_MS)
 }

 /**
 * The socket, not the clock.
 *
 * Structured run state — status, approvals, the board — has no realtime frame of
 * its own, and it used to be chased with a 1.5s interval. It does not need one:
 * every transition worth reacting to already posts a thread message, and those are
 * fanned out over the gateway the moment they happen. So a frame arriving *is* the
 * signal, and the interval behind it drops to a slow safety net.
 *
 * Coalesced, because a busy run posts several events in a burst and one refresh
 * answers all of them. Trailing rather than leading: the last event in a burst is
 * the one whose state we want.
 */
 /**
 * Records one live-activity frame for the watched tree, and drops expired ones.
 *
 * Filtered to the watched tree here rather than in the view: every client in a
 * workspace receives every tree's frames, and a canvas that filtered on render
 * would still grow this array with work it will never draw.
 */
 const noteRunActivity = (activity: RunActivity, treeRunId: string): void => {
 const watchedTree = state.swarmBoard?.treeRunId ?? null
 if (watchedTree !== null && treeRunId !== watchedTree) return
 const now = Date.now
 patch({
 recentActivity: [
...state.recentActivity.filter((entry) => now - entry.at < ACTIVITY_TTL_MS),
 activity,
 ],
 })
 }

 const noteRealtimeActivity = : void => {
 const watched = state.activeRun
 if (!watched) return
 // Only while there is something to be current *about*. Without this, every
 // ordinary chat message in a workspace with no runs would cost five requests.
 const busy = !TERMINAL_STATUSES.has(watched.status) || state.activeRuns.length > 0
 if (!busy || nudgeTimer !== null) return
 nudgeTimer = setTimeout( => {
 nudgeTimer = null
 const current = state.activeRun
 if (current) void syncWatchedRun(current.id)
 }, NUDGE_DEBOUNCE_MS)
 }

 /**
 * Everything the workspace view needs, in one pass. Shared by `init` (with a loading
 * flag) and `refresh` (without) so the two can never drift about what "current" means.
 */
 /**
 * Personas and the delegation matrix together.
 *
 * Never one without the other: every edge in the matrix is a statement about two
 * personas, so editing one invalidates a whole row and column of it. A composition
 * canvas showing stale edges is worse than one showing none — being wrong about
 * what the runtime would allow is the single thing it exists not to be.
 */
 const readPersonasAndMatrix = async : Promise<{
 personas: AgentPersona[]
 delegationMatrix: DelegationEdge[]
 personaRevisions: PersonaRevision[]
 promptTrials: Record<string, PromptTrial>
 }> => {
 const [personas, delegationMatrix, personaRevisions] = await Promise.all([
 options.api.persona.list,
 options.api.personaGroup.delegationMatrix,
 options.api.persona.revisions({}),
 ])
 /**
 * Trials are read only for personas that actually have a revision, which is almost
 * never all of them — the alternative is a request per persona on every refresh for a
 * state most personas are never in.
 */
 const withRevisions = [...new Set(personaRevisions.map((entry) => entry.personaId))]
 const trials = await Promise.all(
 withRevisions.map(async (personaId) => {
 try {
 return [personaId, await options.api.persona.trial({ personaId })] as const
 } catch {
 return [personaId, null] as const
 }
 }),
)
 return {
 personas,
 delegationMatrix,
 personaRevisions,
 promptTrials: Object.fromEntries(
 trials.filter((entry): entry is readonly [string, PromptTrial] => entry[1] !== null),
),
 }
 }

 const loadAll = async : Promise<void> => {
 const [
 runners,
 repositories,
 personas,
 personaGroups,
 activeRun,
 activeRuns,
 runControl,
 notificationConfig,
 mergeQueue,
 capabilities,
 capabilityAttachments,
 delegationMatrix,
 personaRevisions,
 ] = await Promise.all([
 options.api.runner.list,
 options.api.repository.list,
 options.api.persona.list,
 options.api.personaGroup.list,
 options.api.agentRun.getActive,
 options.api.agentRun.listActive,
 options.api.runControl.get,
 options.api.notification.config,
 options.api.mergeQueue.list,
 options.api.capability.list,
 options.api.capability.listAttachments,
 options.api.personaGroup.delegationMatrix,
 options.api.persona.revisions({}),
 ])
 patch({
 runners,
 repositories,
 personas,
 personaGroups,
 delegationMatrix,
 activeRuns,
 runControl,
 notificationConfig,
 mergeQueue,
 capabilities,
 capabilityAttachments,
 personaRevisions,
 })
 rememberPersonaNames([
...fromRuns(activeRuns),
 activeRun ? { id: activeRun.id, name: activeRun.persona.name }: null,
 ])
 // Resume watching whatever run is already active — otherwise a page reload during
 // a run leaves no path back to its approval card.
 if (activeRun && !TERMINAL_STATUSES.has(activeRun.status)) {
 const pendingApprovals = await options.api.approval.listPending({ agentRunId: activeRun.id })
 patch({ activeRun, pendingApprovals })
 await fetchBoard(activeRun.id)
 pollActiveRun(activeRun.id)
 } else if (state.activeRun) {
 // A finished run still has a board worth refreshing: a reconciler starts *after*
 // its parent terminates, so the tree gains a node when nothing is polling.
 await fetchBoard(state.activeRun.id)
 }
 await fetchInbox
 }

 return {
 snapshot: => state,

 onChange(listener) {
 listeners.add(listener)
 return => listeners.delete(listener)
 },

 async init {
 patch({ loading: true, error: null })
 try {
 await loadAll
 } catch (error) {
 patch({ error: errorMessage(error) })
 } finally {
 patch({ loading: false })
 }
 },

 async refresh {
 // No loading flag: this runs on focus, and flipping the whole view to a spinner
 // because someone switched tabs back would be worse than the staleness it fixes.
 try {
 await loadAll
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async deletePersona(personaId) {
 patch({ error: null })
 try {
 await options.api.persona.delete({ personaId })
 // Groups too: `prunePersona` drops it from every group that listed it, so a
 // stale group would keep a chip with no persona behind it.
 patch({
...(await readPersonasAndMatrix),
 personaGroups: await options.api.personaGroup.list,
 })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 /**
 * Returns the refusal instead of parking it in `error`, unlike almost everything
 * else here: the server's answer is the *question* the UI has to put to the human
 * ("this also deletes 12 runs"), and a banner is the wrong place for a question.
 */
 async unbindRepository(input) {
 patch({ error: null })
 try {
 await options.api.repository.unbind({
 repositoryId: input.repositoryId,
...(input.acknowledge ? { acknowledgeRunHistoryLoss: true }: {}),
 })
 patch({ repositories: await options.api.repository.list })
 return { ok: true, reason: null }
 } catch (error) {
 return { ok: false, reason: errorMessage(error) }
 }
 },

 async removeRunner(runnerId) {
 patch({ error: null })
 try {
 await options.api.runner.remove({ runnerId })
 patch({ runners: await options.api.runner.list })
 return { ok: true, reason: null }
 } catch (error) {
 return { ok: false, reason: errorMessage(error) }
 }
 },

 async createPairingToken(name) {
 patch({ error: null })
 try {
 const pairing = await options.api.runner.createPairingToken({ name })
 patch({ lastPairing: {...pairing, name } })
 const runners = await options.api.runner.list
 patch({ runners })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async bindRepository(input) {
 patch({ error: null })
 try {
 await options.api.repository.bindExisting(input)
 const repositories = await options.api.repository.list
 patch({ repositories })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 listDirectory: (input) => options.api.repository.listDirectory(input),

 async createRepository(input) {
 patch({ error: null })
 try {
 await options.api.repository.createNew(input)
 patch({ repositories: await options.api.repository.list })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async createPersona(markdownSource) {
 patch({ error: null })
 try {
 const persona = await options.api.persona.create({ markdownSource })
 patch(await readPersonasAndMatrix)
 // The id is returned as well as stored, so a caller that has something to do with
 // the new persona — the composition canvas puts it straight on the team
 // — does not have to find it again by name in a refreshed list.
 return persona.id
 } catch (error) {
 patch({ error: errorMessage(error) })
 return null
 }
 },

 /**
 * Reads a draft with the server's own parser. Never patches `error`: an unparseable draft is what a
 * human is *in the middle of typing*, and routing it to the session-wide error
 * banner would put a red bar across the app on every keystroke. The problems
 * come back to the caller, which renders them beside the textarea.
 */
 async parsePersona(markdownSource) {
 try {
 return await options.api.persona.parse({ markdownSource })
 } catch (error) {
 return { ok: false, problems: [errorMessage(error)], parsed: null }
 }
 },

 /**
 * Both of these **throw** rather than patching the session error, and that is
 * deliberate.
 *
 * The Expertise panel owns its own error line, and the session banner is shared by
 * ~35 actions. Routing a failed map read there produced exactly the failure this
 * codebase already fixed once for the Inbox: a red bar at the top of the page, and
 * underneath it a panel calmly reporting "this agent has mastered nothing yet" —
 * which is the opposite of what happened. Worse, the banner is not cleared by the
 * retry that succeeds, so it outlives the problem it describes.
 *
 * `startMastery` below keeps the banner, because it is an *action* a human took and
 * has no panel of its own to fail into.
 */
 async listPersonaMaps(personaId) {
 return options.api.mastery.listForPersona({ personaId })
 },

 async getMastery(mapId) {
 return options.api.mastery.get({ mapId })
 },

 /**
 * Every persona's map of one repository — what the swarm graph draws
 * its expertise band from.
 *
 * Returns `[]` on failure rather than throwing, unlike the two above: this decorates
 * a graph that is otherwise complete, so a failure here should cost the band and
 * never the canvas.
 */
 async listRepositoryMaps(repositoryId) {
 try {
 return await options.api.mastery.listForRepository({ repositoryId })
 } catch {
 return []
 }
 },

 async curateMap(mapId) {
 patch({ error: null })
 try {
 return await options.api.mastery.curate({ mapId })
 } catch (error) {
 patch({ error: errorMessage(error) })
 return null
 }
 },

 async getPlanForReview(agentRunId) {
 try {
 return await options.api.plan.get({ agentRunId })
 } catch {
 return null
 }
 },

 async acceptPlan(agentRunId) {
 patch({ error: null })
 try {
 return await options.api.plan.accept({ agentRunId })
 } catch (error) {
 // On the banner: "already started" and "no plan" are sentences a human has to read,
 // not a button that appears to do nothing.
 patch({ error: errorMessage(error) })
 return null
 }
 },

 async requestPlanChanges(input) {
 patch({ error: null })
 try {
 await options.api.plan.requestChanges(input)
 return true
 } catch (error) {
 patch({ error: errorMessage(error) })
 return false
 }
 },

 async rejectPlan(input) {
 patch({ error: null })
 try {
 await options.api.plan.reject({
 agentRunId: input.agentRunId,
...(input.reason === undefined ? {}: { reason: input.reason }),
 })
 return true
 } catch (error) {
 patch({ error: errorMessage(error) })
 return false
 }
 },

 async setPlanReviewRequired(required) {
 patch({ error: null })
 try {
 await options.api.runControl.setPlanReviewRequired({ required })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async listAtlasProposals(input) {
 try {
 return await options.api.atlas.listProposals({
...(input?.status === undefined ? {}: { status: input.status }),
 })
 } catch {
 return []
 }
 },

 async contendAtlasProposal(input) {
 patch({ error: null })
 try {
 return await options.api.atlas.contend(input)
 } catch (error) {
 patch({ error: errorMessage(error) })
 return null
 }
 },

 async decideAtlasProposal(input) {
 patch({ error: null })
 try {
 return await options.api.atlas.decide({
 edgeId: input.edgeId,
 decision: input.decision,
...(input.note === undefined ? {}: { note: input.note }),
 })
 } catch (error) {
 // Kept on the banner: a second decision is refused because the first stands, and
 // that is a sentence a human has to read rather than a button doing nothing.
 patch({ error: errorMessage(error) })
 return null
 }
 },

 async listColosseumSessions {
 try {
 return await options.api.colosseum.list
 } catch {
 return []
 }
 },

 async getColosseumSession(sessionId) {
 try {
 return await options.api.colosseum.get({ sessionId })
 } catch (error) {
 patch({ error: errorMessage(error) })
 return null
 }
 },

 async conveneColosseum(input) {
 patch({ error: null })
 try {
 const session = await options.api.colosseum.convene({...input })
 return session.id
 } catch (error) {
 // Kept on the banner: convening is refused for reasons a human has to read —
 // "nobody knows anything", "the same persona twice" — and a silent failure would
 // look like the button doing nothing.
 patch({ error: errorMessage(error) })
 return null
 }
 },

 async recordColosseumClaim(input) {
 patch({ error: null })
 try {
 await options.api.colosseum.recordClaim(input)
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async settleColosseumClaim(input) {
 patch({ error: null })
 try {
 await options.api.colosseum.settleClaim(input)
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async takeColosseumTurn(input) {
 patch({ error: null })
 try {
 const result = await options.api.colosseum.takeTurn(input)
 // A refusal is not an exception, but it is still what the human needs to read —
 // it is the venue's own bound saying no.
 if (!result.ok) patch({ error: result.reason })
 return result
 } catch (error) {
 patch({ error: errorMessage(error) })
 return null
 }
 },

 async concludeColosseum(sessionId) {
 patch({ error: null })
 try {
 await options.api.colosseum.conclude({ sessionId })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async listWorkspaceMaps {
 try {
 return await options.api.mastery.listAll
 } catch {
 return []
 }
 },

 async listExpertiseUsedByRuns(agentRunIds) {
 if (agentRunIds.length === 0) return []
 try {
 return await options.api.mastery.usedByRuns({ agentRunIds: [...agentRunIds] })
 } catch {
 return []
 }
 },

 /**
 * Keeps the session banner, unlike the reads above: this is an *action* a human took
 * — overruling a measurement — and an action that silently failed would leave the
 * panel showing the state the human thought they had just changed.
 */
 async setMapRetrieval(mapId, override) {
 patch({ error: null })
 try {
 await options.api.mastery.setRetrieval({ mapId, override })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async startMastery(input) {
 patch({ error: null })
 try {
 const run = await options.api.mastery.start(input)
 // Watched exactly as `startRun`'s result is: a mastery run is an ordinary run
 //, so a human
 // must be able to see it working, steer it and stop it like any other.
 patch({ activeRun: run, pendingApprovals: [], diff: null })
 patchFetchError('diff', null)
 pollActiveRun(run.id)
 return run.id
 } catch (error) {
 patch({ error: errorMessage(error) })
 return null
 }
 },

 async keepPersonaRevision(input) {
 patch({ error: null })
 try {
 await options.api.persona.keepRevision(input)
 patch(await readPersonasAndMatrix)
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async revertPersonaPrompt(input) {
 patch({ error: null })
 try {
 await options.api.persona.revert(input)
 patch(await readPersonasAndMatrix)
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async resetPersonaToBuiltin(personaId) {
 patch({ error: null })
 try {
 await options.api.persona.resetToBuiltin({ personaId })
 patch(await readPersonasAndMatrix)
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async previewDelegation(input) {
 try {
 return await options.api.persona.delegationPreview(input)
 } catch {
 // Never routed to the session error banner: this is an aside under a select,
 // and a failed aside must not put a red bar across the app.
 return { planner: false, delegatable: [], refused: [] }
 }
 },

 async registerCapability(input) {
 patch({ error: null })
 try {
 await options.api.capability.register(input)
 patch({ capabilities: await options.api.capability.list })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async removeCapability(capabilityId) {
 patch({ error: null })
 try {
 await options.api.capability.remove({ capabilityId })
 const [capabilities, capabilityAttachments] = await Promise.all([
 options.api.capability.list,
 options.api.capability.listAttachments,
 ])
 // Attachments are re-read too: removing a capability cascades its
 // attachments away, and a stale list would show a persona holding one.
 patch({ capabilities, capabilityAttachments })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async attachCapability(input) {
 patch({ error: null })
 try {
 await options.api.capability.attach(input)
 patch({
 capabilityAttachments: await options.api.capability.listAttachments,
 // A capability is a route to a shell, so attaching one can move
 // a persona out of a planner's envelope — the matrix has to be re-read.
 delegationMatrix: await options.api.personaGroup.delegationMatrix,
 })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async detachCapability(input) {
 patch({ error: null })
 try {
 await options.api.capability.detach(input)
 patch({
 capabilityAttachments: await options.api.capability.listAttachments,
 delegationMatrix: await options.api.personaGroup.delegationMatrix,
 })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async updatePersona(input) {
 patch({ error: null })
 try {
 await options.api.persona.update(input)
 patch(await readPersonasAndMatrix)
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async createPersonaGroup(input) {
 patch({ error: null })
 try {
 await options.api.personaGroup.create(input)
 const personaGroups = await options.api.personaGroup.list
 patch({ personaGroups })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async updatePersonaGroup(input) {
 patch({ error: null })
 try {
 await options.api.personaGroup.update(input)
 const personaGroups = await options.api.personaGroup.list
 patch({ personaGroups })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async deletePersonaGroup(personaGroupId) {
 patch({ error: null })
 try {
 await options.api.personaGroup.delete({ personaGroupId })
 const personaGroups = await options.api.personaGroup.list
 patch({ personaGroups })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async startRun(input) {
 patch({ error: null })
 try {
 const run = await options.api.agentRun.start(input)
 patch({ activeRun: run, pendingApprovals: [], diff: null })
 patchFetchError('diff', null)
 pollActiveRun(run.id)
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async watchRun(agentRunId) {
 patch({ error: null })
 try {
 const [run, pendingApprovals] = await Promise.all([
 options.api.agentRun.get({ agentRunId }),
 options.api.approval.listPending({ agentRunId }),
 ])
 // Diff cleared: it belongs to whichever run it was loaded for, and showing
 // one run's diff under another's name is worse than showing none.
 patch({ activeRun: run, pendingApprovals, diff: null })
 // The diff's error belongs to the run it was loaded for, exactly as the diff
 // itself does — a stale failure under a new run's name is the same lie.
 patchFetchError('diff', null)
 rememberPersonaNames([{ id: run.id, name: run.persona.name }])
 // Fetched here as well as on the poll tick, because a finished run has no
 // poll — and its tree's ledger is exactly what a human reviewing it wants.
 await fetchBoard(agentRunId)
 if (!TERMINAL_STATUSES.has(run.status)) pollActiveRun(agentRunId)
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async decide(approvalRequestId, decision, answer) {
 patch({ error: null })
 try {
 await options.api.approval.decide({
 approvalRequestId,
 decision,
...(answer === undefined ? {}: { answer }),
 })
 if (state.activeRun) pollActiveRun(state.activeRun.id)
 if (state.inspectedRun) await fetchInspected(state.inspectedRun.id)
 await fetchInbox
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async loadDiff(agentRunId) {
 patch({ error: null })
 patchFetchError('diff', null)
 try {
 const { diff } = await options.api.agentRun.getDiff({ agentRunId })
 patch({ diff })
 } catch (error) {
 // `diff` stays null on failure, and the overlay renders null as "Loading the
 // diff…" — so without this the panel claims to be loading forever while the
 // real reason sits in a banner behind the scrim.
 patch({ error: errorMessage(error) })
 patchFetchError('diff', errorMessage(error))
 }
 },

 async keepRun(agentRunId) {
 patch({ error: null })
 try {
 const run = await options.api.agentRun.keep({ agentRunId })
 if (state.activeRun?.id === run.id) patch({ activeRun: run })
 if (state.inspectedRun?.id === run.id) patch({ inspectedRun: run })
 await fetchInbox
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async discardRun(agentRunId) {
 patch({ error: null })
 try {
 const run = await options.api.agentRun.discard({ agentRunId })
 if (state.activeRun?.id === run.id) patch({ activeRun: run })
 if (state.inspectedRun?.id === run.id) patch({ inspectedRun: run })
 await fetchInbox
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async pushRun(agentRunId, acknowledgeCiChange) {
 patch({ error: null })
 try {
 const run = await options.api.agentRun.push({ agentRunId, acknowledgeCiChange })
 if (state.activeRun?.id === run.id) patch({ activeRun: run })
 if (state.inspectedRun?.id === run.id) patch({ inspectedRun: run })
 await fetchInbox
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async enqueueMerge(agentRunId, override) {
 patch({ error: null })
 try {
 await options.api.mergeQueue.enqueue({
 agentRunId,
...(override ? { overrideBlockers: true }: {}),
 })
 // The run itself is re-read, not patched from the entry: queueing does not
 // set a disposition, but it *does* change what the run's buttons may do,
 // and that state lives on the run.
 const run = await options.api.agentRun.get({ agentRunId })
 if (state.activeRun?.id === run.id) patch({ activeRun: run })
 if (state.inspectedRun?.id === run.id) patch({ inspectedRun: run })
 patch({ mergeQueue: await options.api.mergeQueue.list })
 await fetchInbox
 return { ok: true, reason: null }
 } catch (error) {
 return { ok: false, reason: errorMessage(error) }
 }
 },

 async cancelMerge(entryId) {
 patch({ error: null })
 try {
 await options.api.mergeQueue.cancel({ entryId })
 patch({ mergeQueue: await options.api.mergeQueue.list })
 await fetchInbox
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async steer(agentRunId, message) {
 patch({ error: null })
 try {
 const run = await options.api.agentRun.steer({ agentRunId, message })
 // The steering run is watched, and the *steered* tree's board is refreshed
 // from it: a re-plan that cancels a subtask changes the board a human is
 // looking at, and leaving it stale would show work that has already stopped.
 patch({ activeRun: run, pendingApprovals: [], diff: null })
 patchFetchError('diff', null)
 rememberPersonaNames([{ id: run.id, name: run.persona.name }])
 await fetchBoard(run.id)
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async refreshBoard(agentRunId) {
 await fetchBoard(agentRunId)
 },

 async refreshCostSummary(windowHours) {
 await fetchCostSummary(windowHours ?? null)
 },

 async writeNote(input) {
 patch({ error: null })
 try {
 await options.api.workerNote.write(input)
 // Re-read rather than appending the returned note locally: the ledger's order
 // is the server's `seq`, and a client that spliced its own note in would show
 // it in a position the next poll then moves.
 await fetchBoard(input.agentRunId)
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async refreshMergeQueue {
 try {
 patch({ mergeQueue: await options.api.mergeQueue.list })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async setVerifyCommand(repositoryId, verifyCommand) {
 patch({ error: null })
 try {
 await options.api.repository.setVerifyCommand({ repositoryId, verifyCommand })
 patch({ repositories: await options.api.repository.list })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async setVerificationChecks(repositoryId, checks) {
 patch({ error: null })
 try {
 await options.api.repository.setVerificationChecks({ repositoryId, checks })
 patch({ repositories: await options.api.repository.list })
 } catch (error) {
 // Surfaced rather than swallowed: the server refuses a duplicate name and an
 // empty command, and a definition of done that silently did not save is the
 // worst of the three outcomes.
 patch({ error: errorMessage(error) })
 }
 },

 async setReconcilerEnabled(repositoryId, enabled) {
 patch({ error: null })
 try {
 await options.api.repository.setReconcilerEnabled({ repositoryId, enabled })
 patch({ repositories: await options.api.repository.list })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async warmCache(repositoryId) {
 patch({ error: null })
 try {
 return await options.api.repository.warmCache({ repositoryId })
 } catch (error) {
 const message = errorMessage(error)
 patch({ error: message })
 return { ok: false, detail: message }
 }
 },

 async setInstallCommand(repositoryId, installCommand) {
 patch({ error: null })
 try {
 await options.api.repository.setInstallCommand({ repositoryId, installCommand })
 patch({ repositories: await options.api.repository.list })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async registerNotificationTarget(registration) {
 patch({ error: null })
 try {
 const transport = state.notificationConfig?.transport
 if (!transport) throw new Error('Notifications are not configured on this deployment')
 await options.api.notification.subscribe({
 transport,
 endpoint: registration.endpoint,
 credentials: registration.credentials,
 })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async unregisterNotificationTarget(endpoint) {
 patch({ error: null })
 try {
 await options.api.notification.unsubscribe({ endpoint })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async pauseAllRuns {
 patch({ error: null })
 try {
 const { control, cancelledRunIds } = await options.api.runControl.pauseAll
 patch({ runControl: control, lastPauseCancelledCount: cancelledRunIds.length })
 // The pause cancelled whatever was in flight, so stop the run poller
 // rather than letting it keep hitting a now-terminal run, and re-read
 // the run it was watching so the UI shows `cancelled` immediately.
 stopPolling
 if (state.activeRun) {
 const run = await options.api.agentRun.get({ agentRunId: state.activeRun.id })
 patch({ activeRun: run, pendingApprovals: [] })
 }
 await fetchInbox
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async setHandoffPolicy(input) {
 patch({ error: null })
 try {
 patch({ runControl: await options.api.runControl.setHandoffPolicy(input) })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 async resumeAllRuns {
 patch({ error: null })
 try {
 const runControl = await options.api.runControl.resume
 // Cleared with the pause it describes: "3 runs stopped" beside a Resume button
 // reads as a claim about the runs that are about to start again.
 patch({ runControl, lastPauseCancelledCount: null })
 } catch (error) {
 patch({ error: errorMessage(error) })
 }
 },

 getRawTranscript: (agentRunId) => options.api.agentRun.getRawTranscript({ agentRunId }),

 refreshInbox: fetchInbox,
 inspectRun: fetchInspected,

 clearInspectedRun {
 patch({ inspectedRun: null, inspectedApprovals: [], diff: null })
 patchFetchError('diff', null)
 },
 noteRealtimeActivity,
 noteRunActivity,

 async resolvePersonaNames(agentRunIds) {
 const unknown = [...new Set(agentRunIds)].filter(
 (id) => state.personaNameByRunId[id] === undefined && !resolvedRunIds.has(id),
)
 if (unknown.length === 0) return
 // Bounded per call: a thread scrolled far enough back can name a great many
 // runs, and a page of history must not become a burst of requests.
 const batch = unknown.slice(0, 20)
 for (const id of batch) resolvedRunIds.add(id)
 const resolved = await Promise.all(
 batch.map(async (agentRunId) => {
 try {
 const run = await options.api.agentRun.get({ agentRunId })
 return { id: run.id, name: run.persona.name }
 } catch {
 /**
 * A run this client cannot read is not an error worth a banner — but it is
 * also not a name. Left unresolved, the byline reads `agent d353eac8`,
 * which presents an opaque id as if it were a persona: one such line has
 * been sitting in the dev workspace across three handoffs, and nobody could
 * tell from it whether the name was still loading or gone for good.
 *
 * Recorded as a name so the map has an entry and the run is never asked for
 * again. The id stays in the label because it is the only handle a human
 * has for correlating the line with anything else.
 */
 return { id: agentRunId, name: `former run ${agentRunId.slice(0, 8)}` }
 }
 }),
)
 rememberPersonaNames(resolved)
 },

 dispose {
 stopPolling
 if (nudgeTimer !== null) {
 clearTimeout(nudgeTimer)
 nudgeTimer = null
 }
 listeners.clear
 },
 }
}
