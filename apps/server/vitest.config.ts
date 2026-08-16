import { defineConfig } from 'vitest/config'

/**
 * Integration tests here share one real external Postgres/Valkey instance
 * rather than a fresh instance per file, so test files must not run
 * concurrently — two files truncating overlapping tables at the same time
 * corrupts each other's fixtures, not a flaky-test symptom to retry away.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    /**
     * Above every wait these tests contain, because vitest's 5s default was below eight
     * of them.
     *
     * This is the fix for the intermittent that three handoffs recorded as "cause
     * unproven": the warm-handoff nudge waits 20s for a frame and polls 10s for a
     * message, and the test around it had the 5s default — so under a loaded suite the
     * outer clock fired first and the failure read `Test timed out in 5000ms`, which
     * names the wrong clock. Seven other waits here are 10s and had the same trap
     * latent; they had simply never been slow enough to hit it.
     *
     * Raising it weakens nothing. A test that would have passed still passes; the only
     * behaviour that changes is how long a genuinely hung test takes to say so, and
     * these run against a real Postgres over a real socket where "slow" and "broken"
     * are not the same event.
     */
    testTimeout: 20_000,
  },
})
