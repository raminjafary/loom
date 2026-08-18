/**
 * The committer identity every host-side git command that creates a commit runs under.
 *
 * Not a nicety: git refuses to commit at all when it can neither read `user.email` from
 * config nor auto-detect one, and auto-detection is what a CI runner or a freshly
 * provisioned host does not have — the hostname has no domain, so git gets
 * `runner@fv-az…(none)` and stops. Without this the merge queue's rebase and the
 * reconciler's `rebase --continue` fail on exactly those machines, reported to a human
 * as "the reconciler did not resolve it" rather than as a missing git config.
 *
 * Rebase preserves the *author* of each replayed commit, so pinning the committer
 * renames nobody's work: it records that Loom performed the rebase, which it did.
 */
export const LOOM_COMMITTER_FLAGS: readonly string[] = [
  '-c',
  'user.name=Loom',
  '-c',
  'user.email=loom@loom.invalid',
]
