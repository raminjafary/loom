/**
 * Telling an agent *what* to learn.
 *
 * The operator's ask, verbatim: *"how can I tell the agent what kind of expertise it
 * should grasp — find patterns in the commits of the author, or from review verdicts and
 * the author's mindset, alongside the knowledge and mastery of the repo, concepts,
 * domain?"* Until now `mastery.start` took a repository and an optional free-text task,
 * which is a mechanism only in the sense that a blank page is one.
 *
 * **A closed vocabulary, plus free text, and the order matters.** Mastery names the failure
 * a mastery run produces by default: a node per file and an edge per import, "the easiest
 * possible output, and it looks like success". Free guidance alone does not fix that,
 * because a model that has been told "learn this repository" and then "focus on payments"
 * produces the same directory listing about payments. What changes the output is telling it
 * *what earns a node* for the thing being asked — and that is a paragraph per focus,
 * written once here, rather than a paragraph a human writes correctly each time. The free
 * text stays because a closed set cannot express "the parts of this that bill customers",
 * and it is the human's, not a replacement for the vocabulary.
 *
 * **A focus is a request, never a filter.** Nothing here narrows what the map may hold or
 * what the run may read; it changes what the opening asks for. That distinction is what
 * keeps this from being a capability surface — a directive that could *restrict* a run
 * would be a second, weaker envelope, and the capability registry is clear that there is
 * one.
 */

import type { MapSubjectKind } from './subject-map.js'
import { UNTRUSTED_MAP_CLOSE, UNTRUSTED_MAP_OPEN } from './subject-map.js'
import { UNTRUSTED_NOTE_CLOSE, UNTRUSTED_NOTE_OPEN } from './worker-notes.js'

export type MasteryFocus =
  /** Module boundaries, entry points, what talks to what through which seam. */
  | 'architecture'
  /** How things are done here — written down or not. The half a newcomer gets wrong. */
  | 'conventions'
  /** Where past changes went wrong: traps, flaky ground, things that look safe. */
  | 'hazards'
  /** What the tests cover, how they are run, and what they are silent about. */
  | 'tests'
  /** The business ideas the code implements, and where each is realized. */
  | 'domain'
  /** What this author keeps insisting on when they review. Author subjects only. */
  | 'review-stance'
  /** What recurs in this author's own changes — habits, not biography. */
  | 'habits'

export const MASTERY_FOCUS_AREAS: readonly MasteryFocus[] = [
  'architecture',
  'conventions',
  'hazards',
  'tests',
  'domain',
  'review-stance',
  'habits',
]

/**
 * Which focuses make sense for which subject, because offering one that cannot be
 * satisfied is the same failure as a roster listing a persona the gate will refuse: the
 * human reads the option as a promise, and the run spends money discovering it was not.
 *
 * `habits` and `review-stance` need a person's record, so they belong to an author
 * subject. Everything else is about a body of material and applies to any of them.
 */
export const FOCUS_BY_SUBJECT: Readonly<Record<MapSubjectKind, readonly MasteryFocus[]>> = {
  repository: ['architecture', 'conventions', 'hazards', 'tests', 'domain'],
  author: ['habits', 'review-stance', 'conventions', 'hazards'],
  corpus: ['domain', 'conventions', 'architecture'],
}

/**
 * What each focus asks for, in the terms mastery says a map earns its cost by: what is
 * *not* in any one file. Every one of these is written to be checkable by the reader of the
 * resulting map — "the convention, and the files obeying it" rather than "the conventions".
 */
const FOCUS_INSTRUCTION: Readonly<Record<MasteryFocus, string>> = {
  architecture:
    'Architecture: the entry points, the module boundaries that actually hold, and the ' +
    'seams things pass through (a queue, a port, a config key) rather than the calls they ' +
    'make. Record a concept per subsystem with `implements` edges to the code that realizes ' +
    'it; do not record the directory tree, which the next reader can list in a second.',
  conventions:
    'Conventions: how things are done here, especially the ones written down nowhere. A ' +
    'convention earns a node when you can name the files that obey it — record those as ' +
    '`implements` edges, and record anything that violates it as a `contradicts` edge, ' +
    'which is usually the more useful half.',
  hazards:
    'Hazards: where a change is more dangerous than it looks. Tests that fail for reasons ' +
    'unrelated to the change, a module several things depend on through a seam that hides ' +
    'it, a value that is easy to convert twice, anything a past commit had to fix twice. ' +
    'Record these as `hazard` nodes naming the paths involved.',
  tests:
    'Tests: how this is verified and how it is run — the command, what a test file is ' +
    'named, what is covered and, more usefully, what is not. Record `tested_by` edges from ' +
    'the code to the tests that actually exercise it, not from every file to its neighbour.',
  domain:
    'Domain: the business ideas this implements, in the words the domain uses rather than ' +
    'the words the code uses. Each one is a `concept` node whose value is the edges fanning ' +
    'out to where it is realized — a domain idea implemented across four modules is exactly ' +
    'what no single file says.',
  'review-stance':
    'Review stance: what this person keeps insisting on when they review other people\'s ' +
    'work. Read their review comments and the changes made in response to them. Record only ' +
    'what recurs across several separate reviews, as a `convention` node with ' +
    '`observationCount` set to how many you actually counted — a preference expressed once ' +
    'is a mood, and recording it as a habit is what makes a derived reviewer worse than no ' +
    'reviewer at all.',
  habits:
    'Habits: what recurs in this person\'s own changes. How they decompose a change, what ' +
    'they refactor on the way past, what they always add (a test, a comment, a guard), what ' +
    'they never do. Read the diffs, not the commit subjects. Record only patterns you have ' +
    'seen at least three times, with `observationCount` saying how many — and record the ' +
    'pattern, not the person: "adds a failing test before the fix" is useful, "is careful" ' +
    'is not.',
}

export const MAX_MASTERY_GUIDANCE_LENGTH = 2_000

export interface MasteryDirective {
  readonly focus: MasteryFocus[]
  /** The human's own words. Empty when they had none, which is the ordinary case. */
  readonly guidance: string
}

export type MasteryDirectiveVerdict =
  | { readonly ok: true; readonly directive: MasteryDirective }
  | { readonly ok: false; readonly reason: string }

/**
 * Validates a directive against the subject it is for.
 *
 * The one refusal that is not a formality is a focus the subject cannot satisfy: asking a
 * repository run for `review-stance` would produce either an invention or nothing, and
 * both are worse than being told the pairing does not exist.
 */
export const parseMasteryDirective = (
  input: { focus?: readonly string[]; guidance?: string },
  subjectKind: MapSubjectKind,
): MasteryDirectiveVerdict => {
  const allowed = FOCUS_BY_SUBJECT[subjectKind]
  const focus: MasteryFocus[] = []
  for (const raw of input.focus ?? []) {
    const match = MASTERY_FOCUS_AREAS.find((candidate) => candidate === raw)
    if (!match) {
      return { ok: false, reason: `"${raw}" is not something a mastery run can be asked for` }
    }
    if (!allowed.includes(match)) {
      return {
        ok: false,
        reason: `A ${subjectKind} subject cannot be asked for "${match}" — it has no record to derive it from. Available: ${allowed.join(', ')}.`,
      }
    }
    if (!focus.includes(match)) focus.push(match)
  }

  const guidance = (input.guidance ?? '').trim()
  if (guidance.length > MAX_MASTERY_GUIDANCE_LENGTH) {
    return {
      ok: false,
      reason: `Guidance may be at most ${MAX_MASTERY_GUIDANCE_LENGTH} characters — it points a run at something, it does not brief it.`,
    }
  }

  return { ok: true, directive: { focus, guidance } }
}

/**
 * Renders the directive into the run's opening.
 *
 * The guidance is neutralized against every fence in the system for the same reason a
 * map claim is. It is human-authored in the ordinary case and would be model-authored the
 * moment the designer agent can start a mastery run — and a directive that could
 * close the untrusted-map fence would let text arrive in a *later* run's prompt as
 * trusted platform framing, which is the one place this system cannot afford a gap.
 */
export const renderMasteryDirective = (directive: MasteryDirective): string => {
  const parts: string[] = []

  if (directive.focus.length > 0) {
    parts.push(
      [
        'You have been asked to concentrate on the following. This is what to spend the ' +
          'run on and what earns a node; it does not stop you recording something important ' +
          'that falls outside it.',
        ...directive.focus.map((focus) => `- ${FOCUS_INSTRUCTION[focus]}`),
      ].join('\n'),
    )
  }

  if (directive.guidance.length > 0) {
    parts.push(`The person who started this run added: ${neutralize(directive.guidance)}`)
  }

  return parts.join('\n\n')
}

const neutralize = (text: string): string =>
  [UNTRUSTED_MAP_CLOSE, UNTRUSTED_MAP_OPEN, UNTRUSTED_NOTE_CLOSE, UNTRUSTED_NOTE_OPEN].reduce(
    (acc, delimiter) => acc.split(delimiter).join('[redacted-delimiter]'),
    text,
  )

/**
 * What a run mastering an **author** is told about where the record is.
 *
 * Separate from the focus instructions because it is about the *corpus*, not about what
 * to look for in it: an author's record is git history, and a run that does not know to
 * read `git log` will read the working tree and produce a repository map with a person's
 * name on it.
 *
 * **The constraint in the last line is not technical and is not negotiable**.
 * An agent derived from a person's observable practice is informed by that person; it is
 * not them, and it must never be presented as them. Stating it in the opening is cheap
 * and is the earliest point at which it can be stated at all.
 */
export const authorCorpusInstruction = (subjectRef: string): string =>
  [
    `The record you are learning from is this repository's history for "${subjectRef}". Read it ` +
      `with git: \`git log --author="${subjectRef}" --format=%H\` for their commits, ` +
      '`git show` for the diffs, and the commit messages and any review trailers for what ' +
      'they said about other people\'s work. The working tree tells you what the code is ' +
      'now; it does not tell you anything about this person.',
    'Build from repetition, not from biography. A pattern seen once is a coincidence; ' +
      'record what you have seen several times, and say how many times in observationCount. ' +
      'The map is rejected outright if it records a convention observed fewer than three ' +
      'times, and that rule exists because personalized guidance built from single ' +
      'observations measurably performs worse than none at all.',
    'What you are producing is "the conventions this person keeps insisting on, extracted ' +
      'and made checkable". It is not a portrait, and nothing derived from it will ever be ' +
      'presented as this person or attributed to them. Do not record judgements about them, ' +
      'their skill or their character — record practices, and the evidence for each.',
  ].join('\n\n')
