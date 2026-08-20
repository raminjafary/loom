import { compareToManifest, type ManifestCheck, type RollbackManifest } from './rollback-manifest.js'

/**
 * Tiers 3 and 4 of self-modification: what has to be true before a revision of Loom's own
 * source becomes the revision that is running.
 *
 * The four tiers below this one all change *configuration* — a prompt, a tool list, a model.
 * Every one of them takes effect by writing a row, and the worst case is a persona instructed
 * badly. This tier changes the program. Its worst case is a platform that does not start, and
 * the thing that makes it survivable is not care taken while editing: it is that a promotion is
 * a **pointer move between two revisions that both exist on disk**, so undoing it is another
 * pointer move rather than a rebuild from a repository the running code can no longer read.
 *
 * **Editing Loom's source is already possible and is not this tier.** An agent can be given a
 * clone of this repository, change it, and have its branch merged, exactly as for any other
 * repository — nothing here is needed for that. What this file governs is *promotion*: making
 * merged code the code that serves. So the vocabulary is deliberately not "apply an edit" but
 * "promote a revision", and the unit is a commit rather than a diff.
 *
 * ## The order of the rules is the design
 *
 * The permission is checked before every shape check, which is `revisePromptBody`'s rule and
 * the same reason: a deployment where this is switched off must hear the same sentence whatever
 * it asked for, or the refusal doubles as a probe for what would have been allowed.
 *
 * After that the rules run cheapest-first only where that is also safest. `descends-from` comes
 * before the checks because it is the one failure a passing manifest cannot see: a manifest says
 * what still passes, never what quietly went missing, so promoting a commit that does not
 * contain what is running is a silent revert of everything in between and it can pass every
 * check there is.
 *
 * ## What is deliberately not here
 *
 * **No building, and no swapping.** This module decides; a caller with a filesystem does. A
 * promote that also built would be a promote whose failure mode is a half-swapped tree, and the
 * whole argument for this tier is that the dangerous step is a pointer move and nothing else.
 *
 * **No opinion about who asked.** A run, a sweep or a human all reach the same gate. The
 * envelope is a persona's ceiling on what that persona may become, and this is not about a
 * persona — it is about the deployment, so the permission belongs to the deployment.
 */

/**
 * One built revision of Loom's own source.
 *
 * `retained` is the field the whole tier rests on. A revision whose build has been deleted is
 * history, not a rollback target — and a deployment that promoted while its predecessor was
 * unretained has no way back that does not involve the code it just replaced.
 */
export interface SelfRevision {
  readonly commit: string
  readonly builtAt: Date
  /** Whether the built artifact is still on disk. */
  readonly retained: boolean
  /**
   * Whether this revision has answered as a *running process*, on its own port, before being
   * asked to serve.
   *
   * Separate from the manifest's checks and not derivable from them: `pnpm typecheck` passing
   * says the program is well-typed, and the failure this tier is most exposed to is a program
   * that is well-typed and does not start — a missing migration, a secret refused at boot, a
   * port already held. Every one of those passes a build.
   */
  readonly health: 'unchecked' | 'healthy' | 'unhealthy'
}

export interface SelfDeployment {
  /**
   * What is serving now. Null on a deployment that has never promoted, which is the ordinary
   * state of every installation — including this one.
   */
  readonly running: SelfRevision | null
  /** What a rollback would put back. Null when there is nothing to go back to. */
  readonly previous: SelfRevision | null
}

export type SelfPromotionRule =
  /** Promotion is switched off for this deployment. Absence is no permission. */
  | 'disabled'
  /** The candidate is what is already running. */
  | 'already-running'
  /** The candidate does not contain the running revision in its history. */
  | 'not-a-descendant'
  /** The candidate has no build artifact, or it has been released. */
  | 'unbuilt'
  /** The candidate has not answered as a running process. */
  | 'unhealthy'
  /** A check that passed at the manifest's commit fails or is absent on the candidate. */
  | 'regressed'
  /** The revision being replaced is not retained, so this promotion would have no way back. */
  | 'no-way-back'

export interface SelfPromotionRefusal {
  readonly ok: false
  readonly rule: SelfPromotionRule
  readonly reason: string
}

export interface SelfPromotionApproval {
  readonly ok: true
  /**
   * The pointers after the swap. Returned rather than described, because "what is running and
   * what can be rolled back to" is the entire state of this tier and a caller deriving it a
   * second way is a second thing that can be wrong.
   *
   * `running` is narrowed to non-null against `SelfDeployment`, which is not pedantry: an
   * approved promotion always leaves something serving, and a caller that had to check would be
   * writing a branch for a state this function cannot return.
   */
  readonly next: { readonly running: SelfRevision; readonly previous: SelfRevision | null }
  /**
   * Revisions whose builds may now be deleted — named rather than left to a caller's arithmetic.
   * Nothing that appears here is reachable by a rollback any more.
   */
  readonly releasable: readonly string[]
  readonly detail: string
}

export type SelfPromotionVerdict = SelfPromotionApproval | SelfPromotionRefusal

const short = (commit: string): string => commit.slice(0, 12)

/**
 * Whether a built revision may become the running one.
 *
 * `ancestors` is the candidate's history, newest first and not including the candidate itself.
 * Passed in rather than derived because git lives outside the domain — and passed as a list
 * rather than as a boolean so the refusal can say what the candidate *does* contain, which is
 * the difference between a sentence an operator can act on and a rejection.
 */
export const promoteSelfRevision = (input: {
  readonly enabled: boolean
  readonly deployment: SelfDeployment
  readonly candidate: SelfRevision
  readonly ancestors: readonly string[]
  readonly manifest: RollbackManifest
  readonly observed: readonly ManifestCheck[]
}): SelfPromotionVerdict => {
  if (!input.enabled) {
    return {
      ok: false,
      rule: 'disabled',
      reason:
        'Self-promotion is switched off for this deployment, so no revision of Loom\'s own ' +
        'source may be made to serve. Off is the default and it is a real off switch rather ' +
        'than an unset value: a human turns it on, having decided that a platform which can ' +
        'replace itself is what they want.',
    }
  }

  const running = input.deployment.running
  if (running !== null && running.commit === input.candidate.commit) {
    return {
      ok: false,
      rule: 'already-running',
      reason:
        `${short(input.candidate.commit)} is already the revision serving, so promoting it ` +
        'would change nothing and cost the way back: the revision it replaced would become ' +
        'the rollback target of a rollback nobody could want.',
    }
  }

  /**
   * Before the checks, because this is the one loss a passing manifest cannot see. A manifest
   * reports what still passes; it has no way to report a commit that was simply not there.
   */
  if (running !== null && !input.ancestors.includes(running.commit)) {
    return {
      ok: false,
      rule: 'not-a-descendant',
      reason:
        `${short(input.candidate.commit)} does not contain ${short(running.commit)}, the ` +
        'revision serving now, so promoting it would silently undo everything between the two. ' +
        'A manifest cannot catch that — it reports what still passes, never what went missing. ' +
        'Rebase or merge first, then promote what results.',
    }
  }

  if (!input.candidate.retained) {
    return {
      ok: false,
      rule: 'unbuilt',
      reason:
        `${short(input.candidate.commit)} has no build on disk. Promotion never builds: a ` +
        'promote that also built would be one whose failure mode is a half-swapped tree, and ' +
        'the only reason this tier is survivable is that the dangerous step is a pointer move ' +
        'between two revisions that both already exist.',
    }
  }

  if (input.candidate.health !== 'healthy') {
    return {
      ok: false,
      rule: 'unhealthy',
      reason:
        `${short(input.candidate.commit)} has not answered as a running process ` +
        `(${input.candidate.health}). A build that typechecks is not a program that starts — a ` +
        'missing migration, a secret refused at boot and a port already held all pass every ' +
        'check in the manifest, and each one is a platform that is down.',
    }
  }

  const verdict = compareToManifest(input.manifest, input.observed)
  if (verdict.regressions.length > 0) {
    return {
      ok: false,
      rule: 'regressed',
      reason:
        `${short(input.candidate.commit)} loses something that worked: ${verdict.detail} A ` +
        'check that is absent counts the same as one that fails, because absence is how a ' +
        'self-modification hides.',
    }
  }

  /**
   * Last, and it is about the revision being *replaced* rather than the one arriving. Checked
   * after everything else on purpose: a caller told "no way back" while the candidate is also
   * broken would fix the retention and then meet the real refusal.
   */
  if (running !== null && !running.retained) {
    return {
      ok: false,
      rule: 'no-way-back',
      reason:
        `${short(running.commit)} is serving but its build is no longer on disk, so promoting ` +
        'over it would leave nothing to roll back to. Rebuild it first: a rollback is a pointer ' +
        'move, and a pointer to nothing is a rebuild from a repository the running code may no ' +
        'longer be able to read.',
    }
  }

  /**
   * Exactly one previous revision is kept. Two would be a policy nobody asked for and a
   * question at every failure — "how far back" is not a decision a platform should be making
   * on its own at the moment it is broken.
   */
  const releasable = input.deployment.previous === null ? [] : [input.deployment.previous.commit]

  return {
    ok: true,
    next: { running: input.candidate, previous: running },
    releasable,
    detail:
      running === null
        ? `${short(input.candidate.commit)} becomes the revision serving; there is no earlier ` +
          'one, so there is nothing to roll back to yet.'
        : `${short(input.candidate.commit)} becomes the revision serving and ` +
          `${short(running.commit)} is kept as the way back. ${verdict.detail}`,
  }
}

export type SelfRollbackRule = 'nothing-retained' | 'not-serving'

export type SelfRollbackVerdict =
  | {
      readonly ok: true
      /** Same narrowing as a promotion's, and for the same reason. */
      readonly next: { readonly running: SelfRevision; readonly previous: null }
      readonly releasable: readonly string[]
      readonly detail: string
    }
  | { readonly ok: false; readonly rule: SelfRollbackRule; readonly reason: string }

/**
 * Putting the previous revision back.
 *
 * **Not gated on `enabled`**, and that asymmetry is deliberate: switching self-promotion off is
 * a statement about what may be *installed*, and a deployment that turned it off while a bad
 * revision was serving would otherwise have disabled its own way out. The gate belongs on the
 * step that takes a risk.
 *
 * Afterwards there is nothing to roll back to. The revision just rejected is not a target — a
 * second rollback would mean "put the broken one back", which is the one thing the gesture must
 * never be able to do — so it becomes releasable and `previous` is null. A deployment that wants
 * the newer revision again promotes it, through the gate, like anything else.
 */
export const rollbackSelfRevision = (input: {
  readonly deployment: SelfDeployment
}): SelfRollbackVerdict => {
  const { running, previous } = input.deployment
  if (running === null) {
    return {
      ok: false,
      rule: 'not-serving',
      reason:
        'No revision of Loom\'s own source has been promoted here, so there is nothing to roll ' +
        'back from. This deployment is running whatever a human installed.',
    }
  }
  if (previous === null || !previous.retained) {
    return {
      ok: false,
      rule: 'nothing-retained',
      reason:
        previous === null
          ? `${short(running.commit)} is serving and no earlier revision is kept, so a rollback ` +
            'has no target. Recovery from here is the drill: a checkout at a known-good commit, ' +
            'run by code that is not the code being repaired.'
          : `${short(previous.commit)} is recorded as the way back but its build is gone from ` +
            'disk, so the pointer would move to nothing. Recovery from here is the drill rather ' +
            'than a rollback.',
    }
  }
  return {
    ok: true,
    next: { running: previous, previous: null },
    releasable: [running.commit],
    detail:
      `${short(previous.commit)} serves again and ${short(running.commit)} is released. There ` +
      'is nothing to roll back to now: putting the rejected revision back is what promotion is ' +
      'for, through the same gate as anything else.',
  }
}
