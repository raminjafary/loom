/**
 * A map maintaining itself.
 *
 * The argument in one line: memory that only grows is the context problem wearing a
 * different hat. A map is bounded by construction (`MAX_NODES_PER_MAP`), and a bound with
 * nothing retiring against it is a map that eventually cannot record anything new
 * *because of what it used to believe*.
 *
 * **Three decisions from mastery, and the first is the one that shapes everything else.**
 *
 * 1. **Trimming is a proposal until it has run once.** Deleting memory is the one
 * self-modification with no diff to review, so a pass writes down what it intends to
 * drop and drops it on the *next* pass unless something contradicts it in between.
 * That costs one extra pass and buys the thing an irreversible act otherwise never
 * has: a window in which it is observable before it happens. A proposal that stops
 * being true is withdrawn rather than carried out, which is what makes the window real
 * rather than ceremonial.
 * 2. **Nothing here asks a model.** Every rule below is computed from the graph and from
 * the revision the map is derived at, which puts the whole pass on the trusted side of
 * The provenance line and makes it free to re-run after every invalidation. A
 * curation pass that asked a model what to forget would be a model editing the memory
 * every future run reads — the poisoning risk with a maintenance label on it.
 * 3. **Retiring is a write, not a delete** (domain expertise, the bi-temporal model). Everything
 * here produces an `invalidatedAt` stamp and a reason. The claim stays, and "this was
 * true until commit `abc`" stays sayable.
 *
 * **What this deliberately does not do**, and the reason is worth stating rather than
 * leaving as an omission: domain expertise wants claims *scored by outcome* — "a lesson cited by three
 * runs that merged cleanly outranks one from a run that was discarded". That needs
 * per-*claim* citation, and the platform records retrieval per map (`expertise_use`),
 * not per node. Scoring nodes on the map's own record would give every claim in a map the
 * same score, which is not a ranking; guessing which nodes a run acted on would be worse
 * than not ranking at all. The map-level version of that measurement exists and is
 * The trial.
 */

import type { MapEdge, MapNode } from './subject-map.js'

/** Why a claim is proposed for retirement. A closed set, because each is a rule. */
export type RetirementReason =
 /**
 * A live claim says this one is wrong.
 *
 * The strongest signal in the graph and the cheapest: `contradicts` exists in the edge
 * vocabulary precisely so a later pass can say *why* something stopped being believed,
 * and a claim standing under a live contradiction is the definition of a belief the
 * map has outgrown. Note the asymmetry — the contradiction retires the *target*, never
 * its author, because the author is the newer observation.
 */
 | 'contradicted'
 /**
 * A newer claim explicitly replaced it (`supersedes`). Retiring the old one is what
 * the edge was drawn to mean, and leaving both live is how a map comes to hold two
 * answers to one question.
 */
 | 'superseded'
 /**
 * The subject was re-mastered and this claim was not re-confirmed at the new revision.
 *
 * The weakest of the three and the reason the two-pass rule exists: a mastery run that
 * ran out of budget half way through re-confirms half the map, and retiring everything
 * it did not reach would delete a map for being interrupted. Proposed, and carried out
 * only if a *second* pass still finds it unconfirmed — by which time another mastery
 * run has usually re-confirmed it.
 */
 | 'unconfirmed'

export interface RetirementProposal {
 readonly nodeId: string
 readonly key: string
 readonly reason: RetirementReason
 /** One sentence, stored on the row so the retirement is answerable afterwards. */
 readonly detail: string
}

export interface CurationReport {
 /** Live claims examined. Mastery asks a pass to report exactly this set of numbers. */
 readonly checked: number
 readonly kept: number
 /** Retired on this pass — every one of them proposed on a previous pass. */
 readonly retired: number
 /** Newly proposed, to be carried out next pass unless something contradicts them. */
 readonly proposed: number
 /** Proposals withdrawn because they stopped being true. */
 readonly withdrawn: number
}

const DETAIL: Record<RetirementReason, (key: string) => string> = {
 contradicted: (key) => `a live claim contradicts "${key}"`,
 superseded: (key) => `a newer claim supersedes "${key}"`,
 unconfirmed: (key) => `"${key}" was not re-confirmed when the subject was re-mastered`,
}

/**
 * What a pass would retire, given the graph as it stands.
 *
 * `extracted` nodes are exempt from `unconfirmed` and only from that: a parser's output
 * is invalidated by the merge queue observing the file change (`selectStaleNodeIds`),
 * which is a fact rather than an inference, and a mastery run that did not happen to
 * re-derive a parsed fact has not made it false. A parsed claim that a *live* claim
 * contradicts is still proposed, because that contradiction is a finding either way it
 * resolves.
 */
export const proposeRetirements = (
 nodes: readonly MapNode[],
 edges: readonly MapEdge[],
 /** The revision the map is derived at now. Claims older than it were not re-confirmed. */
 currentRevision: string,
): RetirementProposal[] => {
 const live = nodes.filter((node) => node.invalidatedAt === null)
 const liveKeys = new Set(live.map((node) => node.key))
 const liveEdges = edges.filter(
 (edge) =>
 edge.invalidatedAt === null && liveKeys.has(edge.fromKey) && liveKeys.has(edge.toKey),
)

 const contradicted = new Set(
 liveEdges.filter((edge) => edge.kind === 'contradicts').map((edge) => edge.toKey),
)
 const superseded = new Set(
 liveEdges.filter((edge) => edge.kind === 'supersedes').map((edge) => edge.toKey),
)

 const proposals: RetirementProposal[] = []
 for (const node of live) {
 const reason: RetirementReason | null = contradicted.has(node.key)
 ? 'contradicted'
: superseded.has(node.key)
 ? 'superseded'
: node.provenance !== 'extracted' && node.derivedAtRevision !== currentRevision
 ? 'unconfirmed'
: null
 if (reason === null) continue
 proposals.push({
 nodeId: node.id,
 key: node.key,
 reason,
 detail: DETAIL[reason](node.key),
 })
 }
 return proposals
}

/**
 * Splits a pass's proposals against what the previous pass already proposed.
 *
 * `retire` is the two-pass rule paying out: a claim proposed last time and still failing
 * now has had its window. `withdraw` is the other half, and it is what makes the window
 * real — a proposal that stopped being true is taken back rather than carried out,
 * because the whole point of proposing first is that something might change in between.
 */
export const splitProposals = (
 proposals: readonly RetirementProposal[],
 alreadyProposed: ReadonlySet<string>,
): {
 readonly retire: RetirementProposal[]
 readonly propose: RetirementProposal[]
 readonly withdraw: string[]
} => {
 const nowProposed = new Set(proposals.map((proposal) => proposal.nodeId))
 return {
 retire: proposals.filter((proposal) => alreadyProposed.has(proposal.nodeId)),
 propose: proposals.filter((proposal) => !alreadyProposed.has(proposal.nodeId)),
 withdraw: [...alreadyProposed].filter((nodeId) => !nowProposed.has(nodeId)),
 }
}
