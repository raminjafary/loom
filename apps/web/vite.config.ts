/// <reference types="vitest/config" />
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
  },
  /**
   * The runner this app went four sessions without.
   *
   * Every rendering decision here has been protected only by `client-core` tests —
   * which is the right place for the *logic*, and says nothing about whether a
   * component reads it correctly. The defect count found by clicking versus by the
   * suite has been roughly nine to zero across those sessions.
   *
   * `happy-dom` rather than jsdom: these are component tests over small trees, and
   * nothing here needs jsdom's fuller layout emulation.
   */
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
})
