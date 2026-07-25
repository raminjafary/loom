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
  },
})
