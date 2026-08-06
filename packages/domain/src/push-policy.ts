/**
 * PLAN.md §6 A2's push policy. Force-push, tags, and protected-branch
 * targeting are enforced by construction in apps/runner (the push always
 * targets exactly the run's own trusted `refs/heads/<branchName>`) — there is
 * no runtime check for those because there is no code path that could do
 * otherwise. What's left for a classifier: "no CI-config change without
 * human review", the one condition that depends on what the run actually
 * touched.
 */
const CI_CONFIG_PATTERNS = [/^\.github\/workflows\//, /^\.gitlab-ci\.ya?ml$/, /^\.circleci\//]

export type PushEffectVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export const classifyPushEffect = (
  changedPaths: readonly string[],
  acknowledgeCiChange: boolean,
): PushEffectVerdict => {
  const ciTouched = changedPaths.filter((path) => CI_CONFIG_PATTERNS.some((pattern) => pattern.test(path)))
  if (ciTouched.length > 0 && !acknowledgeCiChange) {
    return {
      ok: false,
      reason: `Push blocked — changes touch CI config (${ciTouched.join(', ')}) and need explicit human review. Resubmit with acknowledgeCiChange to confirm.`,
    }
  }
  return { ok: true }
}
