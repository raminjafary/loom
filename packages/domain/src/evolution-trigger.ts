import type {
  AgentPersonaId,
  RepositoryId,
  ThreadId,
  WorkspaceId,
} from './ids.js'
import type { BriefSource } from './proposer-brief.js'

/**
 * The trigger: what makes the platform open a proposer session and a search without anyone
 * asking it to.
 *
 * This is the moment the improvement loop closes. Everything before it needed a human to
 * notice that a persona was worth improving and to click something; the loop could measure an
 * edit but not decide that an edit was due. It is also the traffic generator every later
 * experiment feeds on — a divergence set, a clause-attribution regression and a punch-up curve
 * are all functions of settled searches, and settled searches were previously rate-limited by
 * somebody's attention.
 *
 * **It grants no authority.** Every write downstream of a firing is one the envelope already
 * permits: a proposer session writes candidates, and candidates go on trial. Promotion stays a
 * human's, permanently. What this decides is *when to spend a session*, not what may be done
 * with one.
 *
 * ## The numbers below are a stated prior, not a measurement
 *
 * The instrument was specified as "a mined threshold", and the mining was attempted first: the
 * only populated deployment holds **zero settled searches, zero persona revisions and zero
 * discarded dispositions** across 40 runs, all of them driver traffic. There is nothing to
 * calibrate on, and a number derived from an empty table would be a guess wearing a
 * measurement's clothes — which is the failure this codebase spends most of its comments
 * avoiding.
 *
 * So the defaults are arguments rather than findings, they are overridable per deployment, and
 * **every verdict names the population it was computed over** so the first real firings correct
 * them. `describeTriggerVerdict` is what puts that population in front of a human.
 */

/**
 * Discarded dispositions since the persona's last measurement settled, before a session is due.
 *
 * Three, and the argument is about what each count can mean rather than about a rate. One
 * discarded branch is a task that turned out to be wrong, or a human changing their mind. Two
 * is a coincidence. Three, in a window that resets every time a measurement settles, is a
 * persona whose work is being thrown away faster than the loop is learning from it.
 *
 * It has to be small for the same reason: the window is not "all time", it is "since the last
 * verdict", so a threshold of ten would be reachable only by a persona nobody was measuring.
 */
export const TRIGGER_DISCARDED_DISPOSITIONS = 3

/**
 * Failures of one *named* check before that check is a recurring weakness.
 *
 * Named rather than aggregate, because "the build broke three times" and "three different
 * checks failed once each" are different findings and only the first is something a prompt can
 * be asked to fix. The definition of done already names the check that failed; this is the
 * threshold on that name.
 */
export const TRIGGER_CHECK_FAILURES = 3

export interface TriggerThresholds {
  readonly discardedDispositions: number
  readonly checkFailures: number
}

export const DEFAULT_TRIGGER_THRESHOLDS: TriggerThresholds = {
  discardedDispositions: TRIGGER_DISCARDED_DISPOSITIONS,
  checkFailures: TRIGGER_CHECK_FAILURES,
}

/** Why a trigger fired, which is also which record the session should be shown. */
export type TriggerSignal =
  /**
   * Work that passed its checks and a human threw away anyway. This is the divergence signal —
   * exactly what verifiable rewards cannot see — so a session fired on it is shown the taste
   * record.
   */
  | 'discarded-dispositions'
  /** One named check failing repeatedly. A session fired on it is shown the failure record. */
  | 'recurring-check'

export interface TriggerPopulation {
  /** Runs that reached a decision since the last measurement settled. The denominator. */
  readonly decided: number
  /**
   * Of those, how many **passed their checks and were discarded anyway**.
   *
   * Not every discard: this signal shows the session the taste record, which is built from runs
   * where the definition of done and the human disagreed, so a count that included discards with
   * no verdict would fire on evidence the brief has nothing to say about.
   */
  readonly discarded: number
  /** The most-failed named check in the window, if the persona has one. */
  readonly recurringCheck: { readonly name: string; readonly failures: number } | null
}

export type TriggerVerdict =
  | {
      readonly fire: true
      readonly signal: TriggerSignal
      /**
       * The record the session should be shown, chosen to match the evidence that fired it.
       *
       * **A default the caller may override, and the reason is a confound.** The taste-vs-failure
       * comparison is an experiment over matched lineages; a trigger that always paired the
       * taste record with discarded work would make source and signal collinear, and no later
       * regression could separate "the taste record helps" from "personas whose work gets
       * discarded are different personas". An experiment assigning sources deliberately
       * overrides this; an operator who has registered no experiment gets the sensible pairing.
       */
      readonly source: BriefSource
      readonly population: TriggerPopulation
      readonly reason: string
    }
  | { readonly fire: false; readonly reason: string }

/**
 * Whether a persona is due a session, from its own recent history.
 *
 * Pure, and it takes the population rather than reading it, for the reason every gate in this
 * codebase is pure: the interesting cases are combinations of counts, and a test that has to
 * stand up a database to reach one is a test nobody writes.
 *
 * **Order matters and is not arbitrary.** Discarded dispositions are checked before a recurring
 * check because they are the scarcer signal and the more expensive one to ignore: a failing
 * check is visible to anyone reading the Inbox, while work that passed and was thrown away
 * looks like success from every automated angle.
 */
export const evolutionTriggerVerdict = (input: {
  readonly personaName: string
  readonly population: TriggerPopulation
  readonly thresholds?: TriggerThresholds
}): TriggerVerdict => {
  const thresholds = input.thresholds ?? DEFAULT_TRIGGER_THRESHOLDS
  const { decided, discarded, recurringCheck } = input.population

  if (discarded >= thresholds.discardedDispositions) {
    return {
      fire: true,
      signal: 'discarded-dispositions',
      source: 'taste-record',
      population: input.population,
      reason:
        `${discarded} of ${decided} decided runs of "${input.personaName}" were discarded since ` +
        `its last measurement settled, at a threshold of ${thresholds.discardedDispositions}. ` +
        'Work that passed its checks and was thrown away anyway is the one signal the ' +
        'definition of done cannot see, so the session is shown the taste record.',
    }
  }

  if (recurringCheck && recurringCheck.failures >= thresholds.checkFailures) {
    return {
      fire: true,
      signal: 'recurring-check',
      source: 'failure-record',
      population: input.population,
      reason:
        `"${recurringCheck.name}" failed ${recurringCheck.failures} times across ${decided} ` +
        `decided runs of "${input.personaName}", at a threshold of ${thresholds.checkFailures}. ` +
        'One named check failing repeatedly is something a prompt can be asked about, so the ' +
        'session is shown the failure record.',
    }
  }

  /**
   * The held case says the counts, not just "no".
   *
   * A sweep that reports "nothing due" every tick teaches an operator nothing about whether the
   * threshold is right, and the whole reason these numbers are a prior rather than a finding is
   * that they need correcting from real traffic. A held verdict is the only place that traffic
   * is visible before it crosses.
   */
  return {
    fire: false,
    reason:
      `Not due: ${discarded} discarded of ${decided} decided (threshold ` +
      `${thresholds.discardedDispositions})` +
      (recurringCheck
        ? `, worst check "${recurringCheck.name}" at ${recurringCheck.failures} (threshold ${thresholds.checkFailures})`
        : ', no named check has failed') +
      '.',
  }
}

/**
 * A persona the trigger could fire for, with the context a session would be started in.
 *
 * In the domain rather than the port because both sides need the shape and neither owns it: the
 * adapter builds it out of a join, and the sweep reads its envelope out of the markdown.
 */
export interface TriggerCandidate {
  readonly workspaceId: WorkspaceId
  readonly personaId: AgentPersonaId
  readonly personaName: string
  readonly markdownSource: string
  /** The thread and repository of the run this persona last did work in. */
  readonly threadId: ThreadId
  readonly repositoryId: RepositoryId
}
