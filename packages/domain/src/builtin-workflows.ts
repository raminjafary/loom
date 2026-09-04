/**
 * The harnesses a workspace ships with.
 *
 * A workspace that opened onto an empty canvas and a "New workflow" button would teach an
 * operator that a harness is something they invent, when the whole argument for drawing one is
 * that the shapes worth drawing are already known and few. These five are that list: the six
 * named patterns, composed into the five jobs people actually run.
 *
 * They are **drawn graphs, not special-cased code paths**, and that is the load-bearing part.
 * Deep research is not a `deepResearch()` function with a flag — it is nodes and edges the same
 * validator checks and the same executor runs, so it can be redrawn, versioned, priced and
 * measured exactly as anything a person draws. A built-in that took a private path would be a
 * built-in that proved nothing about the vocabulary.
 *
 * Four rules each of these follows, and each is a decision rather than a default:
 *
 * - **A verifier is never the author.** Every refutation step runs a different persona from the
 *   one whose answer it is checking, which the validator enforces and these obey rather than
 *   work around. That is the same construction the surrogate verifier uses, one level up.
 * - **A fan's width is small.** Four to six, not sixteen. A shipped harness is the first one an
 *   operator runs, and the number it teaches them is the number they will leave alone.
 * - **A barrier only where a stage genuinely needs every lane.** The reported mistake is
 *   defaulting to barriers, and a shipped set that did it would teach the mistake.
 * - **Named for the job.** "code review" is what somebody wants done; "fan into a barrier into a
 *   verifier" is a shape they would have to interpret.
 *
 * **Personas are named, not id'd**, and a workflow naming one a workspace does not have is
 * skipped at seeding rather than failing the set — an operator who deleted `qa` should still get
 * the rest.
 */

import type { WorkflowGraph } from './workflow-graph.js'

export interface BuiltinWorkflow {
  readonly name: string
  /**
   * When to reach for this one, in one line.
   *
   * Required rather than optional on a shipped harness, for the reason a shipped team's is: a
   * preset nobody can tell apart from the next one is a preset nobody picks, and the cost of
   * picking the wrong harness is measured in runs.
   */
  readonly description: string
  readonly graph: WorkflowGraph
}

export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflow[] = [
  {
    name: 'deep research',
    description:
      'Answer an open question from many angles at once, then attack the answer before ' +
      'reporting it. Expensive — reach for it when being wrong is expensive.',
    graph: {
      nodes: [
        {
          kind: 'step',
          id: 'angles',
          title: 'Choose the angles',
          persona: 'solution-architect',
          task:
            'The question is: {{input}}\n\n' +
            'Name between three and five *distinct angles* it should be investigated from — ' +
            'different sources, different disciplines, different assumptions about what the ' +
            'answer even is. Each one will be researched by somebody who cannot see the others, ' +
            'so an angle that overlaps another buys nothing. Do not answer the question here.',
          answer: { fields: [{ kind: 'list', name: 'angles' }] },
        },
        {
          /**
           * Each searcher is blind to the others by construction rather than by instruction:
           * a fan's lanes are separate runs with separate contexts, so one lane cannot anchor
           * on another's findings. That is the whole reason this stage is a fan and not a
           * single step told to "consider several angles".
           */
          kind: 'fan',
          id: 'sweep',
          title: 'Research each angle',
          persona: 'swe',
          task:
            'Research this one angle, and only this one: {{item}}\n\n' +
            'The question behind it is: {{input}}\n\n' +
            'Read what is actually there rather than what you expect. Report what you found ' +
            'and where you found it, and say plainly where the evidence ran out — a gap named ' +
            'is worth more here than a gap filled in.',
          source: 'angles',
          over: 'angles',
          maxWidth: 5,
          answer: { fields: [{ kind: 'text', name: 'findings' }] },
        },
        {
          kind: 'barrier',
          id: 'swept',
          title: 'Every angle in',
        },
        {
          kind: 'step',
          id: 'claims',
          title: 'Draw the claims out',
          persona: 'product-manager',
          task:
            'Here is what each angle found:\n\n{{sweep.findings}}\n\n' +
            'The question was: {{input}}\n\n' +
            'Reduce this to the *claims* it supports — each one a single statement that could ' +
            'turn out to be false. A claim two angles disagree about is the most valuable ' +
            'entry in the list, so keep both rather than averaging them.',
          answer: { fields: [{ kind: 'list', name: 'claims' }] },
        },
        {
          kind: 'verifier',
          id: 'refute',
          title: 'Attack each claim',
          persona: 'qa',
          task:
            'Try to refute this claim: {{item}}\n\n' +
            'You are not asked whether it sounds right. Find the evidence that would make it ' +
            'false, and say whether you found any. If you cannot refute it, say what would.',
          verifies: 'claims',
          over: 'claims',
          maxWidth: 6,
          answer: { fields: [{ kind: 'text', name: 'verdict' }] },
        },
        {
          kind: 'barrier',
          id: 'attacked',
          title: 'Every claim attacked',
        },
        {
          kind: 'step',
          id: 'report',
          title: 'Write the report',
          persona: 'product-manager',
          task:
            'The question: {{input}}\n\n' +
            'The claims:\n\n{{claims.claims}}\n\n' +
            'What survived an attempt to refute them:\n\n{{refute.verdict}}\n\n' +
            'Write the answer, citing where each part came from. A claim that did not survive ' +
            'belongs in the report as a thing that was checked and rejected — leaving it out ' +
            'is how a report becomes more confident than the work behind it.',
          answer: null,
        },
      ],
      edges: [
        { from: 'angles', to: 'sweep', when: null, loop: null },
        { from: 'sweep', to: 'swept', when: null, loop: null },
        { from: 'angles', to: 'swept', when: null, loop: null },
        { from: 'swept', to: 'claims', when: null, loop: null },
        { from: 'claims', to: 'refute', when: null, loop: null },
        { from: 'refute', to: 'attacked', when: null, loop: null },
        { from: 'claims', to: 'attacked', when: null, loop: null },
        { from: 'attacked', to: 'report', when: null, loop: null },
      ],
    },
  },

  {
    name: 'code review',
    description:
      'Review a change along several dimensions at once, and verify each finding before it is ' +
      'reported. The shape a review is worth reading because of.',
    graph: {
      nodes: [
        {
          kind: 'step',
          id: 'dimensions',
          title: 'Choose the dimensions',
          persona: 'solution-architect',
          task:
            'The change to review: {{input}}\n\n' +
            'Read enough of it to name three or four *dimensions* worth a separate pass — ' +
            'correctness, a specific failure mode this change is exposed to, the interface it ' +
            'presents, whatever this particular change makes risky. Each is reviewed by ' +
            'somebody who sees only that dimension, so name them so they do not overlap. ' +
            'Do not review anything yourself here.',
          answer: { fields: [{ kind: 'list', name: 'dimensions' }] },
        },
        {
          kind: 'fan',
          id: 'review',
          title: 'Review each dimension',
          persona: 'swe',
          task:
            'Review this change along one dimension only: {{item}}\n\n' +
            'The change: {{input}}\n\n' +
            'Report what you find as separate findings, each one naming the file and what ' +
            'specifically goes wrong. A finding you cannot state as "given X, this does Y and ' +
            'should do Z" is a preference, and preferences are not findings.',
          source: 'dimensions',
          over: 'dimensions',
          maxWidth: 4,
          answer: { fields: [{ kind: 'text', name: 'found' }] },
        },
        {
          kind: 'barrier',
          id: 'reviewed',
          title: 'Every dimension in',
        },
        {
          kind: 'step',
          id: 'collate',
          title: 'Collate the findings',
          persona: 'product-manager',
          task:
            'Here is what each dimension turned up:\n\n{{review.found}}\n\n' +
            'Reduce it to one list of findings, most serious first, with duplicates merged. ' +
            'Do not add findings of your own and do not drop one for being awkward — the next ' +
            'stage decides which of these are real.',
          answer: { fields: [{ kind: 'list', name: 'findings' }] },
        },
        {
          kind: 'verifier',
          id: 'confirm',
          title: 'Verify each finding',
          persona: 'qa',
          task:
            'Try to show this finding is wrong: {{item}}\n\n' +
            'The change: {{input}}\n\n' +
            'Go to the code and check. A finding survives only if you can state the inputs ' +
            'that trigger it and what happens then. Say so plainly when it does not survive: a ' +
            'review whose findings are half real teaches people to skim the whole thing.',
          verifies: 'collate',
          over: 'findings',
          maxWidth: 6,
          answer: { fields: [{ kind: 'text', name: 'verdict' }] },
        },
        {
          kind: 'barrier',
          id: 'confirmed',
          title: 'Every finding checked',
        },
        {
          kind: 'step',
          id: 'report',
          title: 'Report what survived',
          persona: 'product-manager',
          task:
            'The verdicts:\n\n{{confirm.verdict}}\n\n' +
            'Report the findings that survived, in order of how much they matter, each with ' +
            'the failure it causes. Say how many were checked and discarded — that number is ' +
            'what tells a reader the rest were checked at all.',
          answer: null,
        },
      ],
      edges: [
        { from: 'dimensions', to: 'review', when: null, loop: null },
        { from: 'review', to: 'reviewed', when: null, loop: null },
        { from: 'dimensions', to: 'reviewed', when: null, loop: null },
        { from: 'reviewed', to: 'collate', when: null, loop: null },
        { from: 'collate', to: 'confirm', when: null, loop: null },
        { from: 'confirm', to: 'confirmed', when: null, loop: null },
        { from: 'collate', to: 'confirmed', when: null, loop: null },
        { from: 'confirmed', to: 'report', when: null, loop: null },
      ],
    },
  },

  {
    name: 'security analysis',
    description:
      'The review shape against a threat model: enumerate what an attacker would try, probe ' +
      'each, and keep what did not work as well as what did.',
    graph: {
      nodes: [
        {
          kind: 'step',
          id: 'threats',
          title: 'Build the threat model',
          persona: 'security-reviewer',
          task:
            'What is being analysed: {{input}}\n\n' +
            'Name the things an attacker would actually try here — three to five, each a ' +
            'specific move against a specific surface rather than a category. "Injection" is a ' +
            'category; "a tool argument reaching a shell through the approval card" is a move. ' +
            'Do not attempt any of them here.',
          answer: { fields: [{ kind: 'list', name: 'threats' }] },
        },
        {
          kind: 'fan',
          id: 'probe',
          title: 'Probe each threat',
          persona: 'swe',
          task:
            'Take this one move and work out whether it lands: {{item}}\n\n' +
            'The system: {{input}}\n\n' +
            'Read the code that would have to stop it. Say what stops it and where, or exactly ' +
            'how far it gets. Do not write an exploit — the answer needed here is where the ' +
            'boundary is, not a demonstration of crossing it.',
          source: 'threats',
          over: 'threats',
          maxWidth: 5,
          answer: { fields: [{ kind: 'text', name: 'result' }] },
        },
        {
          kind: 'barrier',
          id: 'probed',
          title: 'Every threat probed',
        },
        {
          kind: 'step',
          id: 'collate',
          title: 'Sort what landed from what did not',
          persona: 'security-reviewer',
          task:
            'What each probe found:\n\n{{probe.result}}\n\n' +
            'Split it: the moves that get somewhere, and the moves that are stopped and by ' +
            'what. Both lists matter — a move that was tried and stopped is a boundary somebody ' +
            'can rely on, and a report that only lists holes leaves the next reader repeating ' +
            'the work that found none.',
          answer: { fields: [{ kind: 'list', name: 'exposures' }] },
        },
        {
          kind: 'verifier',
          id: 'confirm',
          title: 'Verify each exposure',
          persona: 'qa',
          task:
            'Try to show this exposure is not real: {{item}}\n\n' +
            'The system: {{input}}\n\n' +
            'Find the check, the guard or the boundary that already stops it. A security ' +
            'finding that turns out to be guarded elsewhere is worse than no finding, because ' +
            'it spends the attention the real ones need.',
          verifies: 'collate',
          over: 'exposures',
          maxWidth: 6,
          answer: { fields: [{ kind: 'text', name: 'verdict' }] },
        },
        {
          kind: 'barrier',
          id: 'confirmed',
          title: 'Every exposure checked',
        },
        {
          kind: 'step',
          id: 'report',
          title: 'Report the analysis',
          persona: 'security-reviewer',
          task:
            'The threat model:\n\n{{threats.threats}}\n\n' +
            'What the probes found:\n\n{{probe.result}}\n\n' +
            'What survived being checked:\n\n{{confirm.verdict}}\n\n' +
            'Write the analysis. Lead with what is exposed; then record what was tried and ' +
            'found stopped, and where it was stopped. Name the moves nobody probed, because ' +
            'the reader will otherwise take this list for the whole territory.',
          answer: null,
        },
      ],
      edges: [
        { from: 'threats', to: 'probe', when: null, loop: null },
        { from: 'probe', to: 'probed', when: null, loop: null },
        { from: 'threats', to: 'probed', when: null, loop: null },
        { from: 'probed', to: 'collate', when: null, loop: null },
        { from: 'collate', to: 'confirm', when: null, loop: null },
        { from: 'confirm', to: 'confirmed', when: null, loop: null },
        { from: 'collate', to: 'confirmed', when: null, loop: null },
        { from: 'confirmed', to: 'report', when: null, loop: null },
      ],
    },
  },

  {
    name: 'agent team',
    description:
      'Split a piece of work, do the parts in parallel, then have somebody who did none of it ' +
      'check the whole. A standing team as a drawn thing rather than a habit re-typed per task.',
    graph: {
      nodes: [
        {
          kind: 'step',
          id: 'split',
          title: 'Split the work',
          persona: 'planner',
          task:
            'The work: {{input}}\n\n' +
            'Split it into parts that can be done at the same time without treading on each ' +
            'other — three or four. Name for each part which files it owns, because two parts ' +
            'editing one file is the failure this split exists to avoid. Do none of the work.',
          answer: { fields: [{ kind: 'list', name: 'parts' }] },
        },
        {
          kind: 'fan',
          id: 'work',
          title: 'Do each part',
          persona: 'swe',
          task:
            'Do this part, and only this part: {{item}}\n\n' +
            'The whole job, for context: {{input}}\n\n' +
            'Stay inside the files your part named. Something outside them that needs changing ' +
            'is a thing to report rather than a thing to change — somebody else is in there.',
          source: 'split',
          over: 'parts',
          maxWidth: 4,
          answer: { fields: [{ kind: 'text', name: 'done' }] },
        },
        {
          kind: 'barrier',
          id: 'assembled',
          title: 'Every part done',
        },
        {
          /**
           * The checker is `qa` rather than another `swe`, and that is the same rule the
           * verifier nodes keep: the reviewing relation is only worth anything when the
           * reviewer did not write what it reads.
           */
          kind: 'step',
          id: 'check',
          title: 'Check the whole',
          persona: 'qa',
          task:
            'The job was: {{input}}\n\n' +
            'What each part reports doing:\n\n{{work.done}}\n\n' +
            'You did none of this. Check that the parts fit: run what can be run, and look ' +
            'specifically at the seams between them, which is where parallel work breaks. ' +
            'Report what is wrong rather than fixing it.',
          answer: null,
        },
      ],
      edges: [
        { from: 'split', to: 'work', when: null, loop: null },
        { from: 'work', to: 'assembled', when: null, loop: null },
        { from: 'split', to: 'assembled', when: null, loop: null },
        { from: 'assembled', to: 'check', when: null, loop: null },
      ],
    },
  },

  {
    name: 'migration sweep',
    description:
      'Find every site of a mechanical change, make each one separately, and verify each on its ' +
      'own. The one shape where keeping the lanes apart earns what it costs.',
    graph: {
      nodes: [
        {
          kind: 'step',
          id: 'discover',
          title: 'Find every site',
          persona: 'swe',
          task:
            'The change to make everywhere: {{input}}\n\n' +
            'Find every place it applies. Search rather than recall, and list one entry per ' +
            'site with the file and what specifically is there. Change nothing yet — a sweep ' +
            'that edits as it searches cannot tell you how many sites there were.',
          answer: { fields: [{ kind: 'list', name: 'sites' }] },
        },
        {
          kind: 'fan',
          id: 'transform',
          title: 'Change each site',
          persona: 'swe',
          task:
            'Make the change at this one site: {{item}}\n\n' +
            'The change: {{input}}\n\n' +
            'Only this site. A site that turns out to need something different from the others ' +
            'is a thing to report and leave alone — a sweep whose lanes each improvised is a ' +
            'sweep nobody can review.',
          source: 'discover',
          over: 'sites',
          maxWidth: 6,
          answer: { fields: [{ kind: 'text', name: 'diff' }] },
        },
        {
          /**
           * Verified per lane, *before* the barrier, which is the whole reason the lanes are
           * separate: site 3's check runs the moment site 3 is changed, rather than after the
           * slowest site in the sweep. A barrier here would buy nothing and cost the wall-clock
           * of the worst lane.
           */
          kind: 'step',
          id: 'verify',
          title: 'Check that site',
          persona: 'qa',
          task:
            'One site was just changed:\n\n{{transform.diff}}\n\n' +
            'The change being made everywhere: {{input}}\n\n' +
            'Check this one site only. Run whatever this repository runs to check it. Report ' +
            'whether it holds, and if not, exactly what broke.',
          answer: { fields: [{ kind: 'text', name: 'verdict' }] },
        },
        {
          kind: 'barrier',
          id: 'swept',
          title: 'Every site done',
        },
        {
          kind: 'step',
          id: 'report',
          title: 'Report the sweep',
          persona: 'swe',
          task:
            'The sites found:\n\n{{discover.sites}}\n\n' +
            'What each check said:\n\n{{verify.verdict}}\n\n' +
            'Report the sweep: how many sites, how many hold, and which do not with what broke. ' +
            'A site that was found and skipped counts — it is the one somebody will otherwise ' +
            'discover in six months.',
          answer: null,
        },
      ],
      edges: [
        { from: 'discover', to: 'transform', when: null, loop: null },
        { from: 'transform', to: 'verify', when: null, loop: null },
        { from: 'verify', to: 'swept', when: null, loop: null },
        { from: 'discover', to: 'swept', when: null, loop: null },
        { from: 'swept', to: 'report', when: null, loop: null },
      ],
    },
  },
]
