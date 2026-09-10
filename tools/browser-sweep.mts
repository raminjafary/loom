/**
 * Every surface, walked in a real browser, with a screenshot of each.
 *
 *   docker compose up -d postgres valkey
 *   npx tsx tools/browser-sweep.mts            # HEADED=1 to watch
 *
 * The difference from `browser-check.mts`, which is the CI gate: that one asserts a fixed set
 * of properties on a few surfaces and must stay fast and stable. **This one goes everywhere**
 * — every settings tab, every sidebar section, every overlay, at two viewport widths — and its
 * output is evidence for a person plus a small number of checks that apply to *every* surface
 * rather than to any particular one.
 *
 * Those universal checks are the point. A surface is not exempt from them because nobody wrote
 * a test for it:
 *
 * - nothing throws while it is open
 * - the page does not scroll sideways
 * - the surface's own heading is on screen rather than below the fold
 * - every enabled control on it is legible against what is behind it
 *
 * Each of those has caught a real defect in this repository, three of them in the last day.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { buildApp, devAuth } from '../apps/server/src/index.js'
import { loadConfig } from '../apps/server/src/config.js'
import { buildGateway } from '../apps/ws-gateway/src/gateway.js'
import {
  boxOf,
  hasHorizontalOverflow,
  isInViewport,
  openBrowser,
  signUpThroughTheGate,
  startStack,
  VIEWPORT,
} from './browser-harness.mts'

const REPO_ROOT = new URL('..', import.meta.url).pathname
const ARTIFACTS = join(REPO_ROOT, 'artifacts/sweep')
const SUBSCRIPTION_SECRET = 'browser-sweep-subscription-secret-32-chs'

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

await rm(ARTIFACTS, { recursive: true, force: true })

const stack = await startStack({
  log: (message) => console.log(message),
  start: async ({ apiPort, wsPort, webOrigin }) => {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      BETTER_AUTH_SECRET: 'browser-sweep-secret-at-least-32-characters',
      WS_SUBSCRIPTION_SECRET: SUBSCRIPTION_SECRET,
      SERVER_PORT: String(apiPort),
      WEB_ORIGIN: webOrigin,
    } as NodeJS.ProcessEnv)
    const app = await buildApp(config)
    await app.fastify.listen({ port: apiPort, host: '127.0.0.1' })
    const gateway = await buildGateway({
      valkeyUrl: config.VALKEY_URL,
      webOrigin,
      subscriptionSecret: SUBSCRIPTION_SECRET,
    })
    await gateway.listen({ port: wsPort, host: '127.0.0.1' })
    return {
      close: async () => {
        await gateway.close()
        await app.fastify.close()
      },
    }
  },
})

const consoleErrors: string[] = []
const browser = await openBrowser({
  artifacts: ARTIFACTS,
  headed: process.env.HEADED === '1',
  onConsoleError: (message) => consoleErrors.push(message),
})
const { page } = browser

/** The four questions asked of every surface, whatever it is. */
const sweep = async (name: string, heading: string | null) => {
  const before = consoleErrors.length
  await page.waitForTimeout(700)
  await browser.screenshot(name)

  const overflow = await hasHorizontalOverflow(page)
  const unreadable: string[] = await page.evaluate(`(() => {
    const lum = (value) => {
      const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?/.exec(value)
      if (!m) return null
      if (m[4] !== undefined && Number(m[4]) === 0) return null
      const ch = (raw) => {
        const c = Number(raw) / 255
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * ch(m[1]) + 0.7152 * ch(m[2]) + 0.0722 * ch(m[3])
    }
    const bg = (el) => {
      let n = el
      while (n) {
        const c = getComputedStyle(n).backgroundColor
        if (lum(c) !== null) return c
        n = n.parentElement
      }
      return 'rgb(255,255,255)'
    }
    const out = []
    for (const el of Array.from(document.querySelectorAll('button, a, label, h1, h2, h3, th'))) {
      if (el.disabled) continue
      const st = getComputedStyle(el)
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.7) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const t = (el.textContent || '').trim()
      if (!t) continue
      const f = lum(st.color), b = lum(bg(el))
      if (f === null || b === null) continue
      const hi = f > b ? f : b, lo = f > b ? b : f
      const ratio = (hi + 0.05) / (lo + 0.05)
      if (ratio < 3) out.push(t.slice(0, 20) + ' (' + ratio.toFixed(2) + ')')
    }
    return out
  })()`)

  const threw = consoleErrors.slice(before)
  const headingOnScreen = heading === null ? true : await isInViewport(page, heading)

  const problems = [
    ...(overflow ? ['scrolls sideways'] : []),
    ...(unreadable.length > 0 ? [`unreadable: ${unreadable.join(', ')}`] : []),
    ...(threw.length > 0 ? [`threw: ${threw[0]}`] : []),
    ...(headingOnScreen ? [] : ['its heading is below the fold']),
  ]
  check(name, problems.length === 0, problems.join(' · '))
}

try {
  await page.goto(stack.origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /create an account/i }).waitFor()
  await sweep('gate', 'form.card h1')

  await signUpThroughTheGate(page, stack.origin)
  await page.locator('.app').waitFor({ timeout: 20_000 })
  await page.waitForTimeout(1_500)
  await sweep('workspace-empty', '.sidebar .brand')

  // A channel and a message, so the surfaces that render content have some.
  const channelName = `sweep-${Date.now().toString(36)}`
  await page.getByPlaceholder('new-channel').fill(channelName)
  await page.getByRole('button', { name: /^add$/i }).click()
  await page.getByText(channelName, { exact: false }).first().waitFor({ timeout: 10_000 })
  await page.getByPlaceholder(/^Message/).fill('A message, so the thread has something in it.')
  await page.getByRole('button', { name: /^send$/i }).click()
  await page.getByText('A message, so the thread').first().waitFor({ timeout: 10_000 })
  await sweep('channel-with-a-message', '.topbar h1, .topbar h2')

  /**
   * A control that is not there is a surface this run could not reach, and saying so is more
   * useful than dying on it — an exploratory sweep that crashes on the fourth of twenty
   * surfaces has told you about three.
   */
  const clickIfPresent = async (locator: ReturnType<typeof page.locator>, what: string) => {
    if ((await locator.count()) === 0) {
      console.log(`  --    ${what} — not reachable from here`)
      return false
    }
    /**
     * Disabled is a *state this surface is in*, not a failure to reach it: a sidebar section
     * with nothing in it cannot be expanded, and its collapsed summary is what it has to say.
     * Waiting for it to become clickable is waiting for something that is deliberately never
     * going to happen.
     */
    if (!(await locator.first().isEnabled())) {
      console.log(`  --    ${what} — empty, so it does not open`)
      return false
    }
    await locator.first().click({ timeout: 10_000 })
    return true
  }

  // Every thread view.
  // "One agent" renders only while a run is focused, so it is legitimately absent here.
  for (const view of ['Decisions', 'Everything']) {
    /**
     * `role="tab"`, not `button`. An explicit ARIA role replaces the implicit one, so a
     * `getByRole('button')` finds nothing — which is how two passes of this sweep reported
     * three surfaces unreachable that are plainly on screen in its own screenshots.
     */
    const button = page.locator('.thread-views').getByRole('tab', { name: view, exact: true })
    if (await clickIfPresent(button, `thread view: ${view}`)) {
      await sweep(`thread-view-${view.toLowerCase().replace(/\s+/g, '-')}`, '.topbar h1, .topbar h2')
    }
  }

  // Every sidebar section, expanded.
  for (const section of ['Watching', 'Swarm', 'Notes', 'Merge queue', 'Spend']) {
    const head = page.locator('section.section button.head', { hasText: section })
    if (!(await clickIfPresent(head, `sidebar: ${section}`))) continue
    await sweep(`sidebar-${section.toLowerCase().replace(/\s+/g, '-')}`, null)
    await head.first().click()
  }

  // Every settings tab.
  await page.locator('button.settings-toggle').first().click()
  await page.locator('[aria-label="Settings"][role="dialog"]').waitFor({ timeout: 10_000 })
  for (const tab of [
    'Runners & repositories',
    'Personas & groups',
    'Expertise',
    'Workflows',
    'Colosseum',
    'Capabilities',
  ]) {
    const button = page.getByRole('button', { name: tab })
    if (!(await clickIfPresent(button, `settings: ${tab}`))) continue
    await sweep(`settings-${tab.toLowerCase().replace(/[^a-z]+/g, '-')}`, '[aria-label="Settings"] h2')
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  // The overlays.
  if (await clickIfPresent(page.getByRole('button', { name: /^design$/i }), 'the team canvas')) {
    await sweep('team-canvas', '[aria-label="Compose a team"] h2')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }

  if (await clickIfPresent(page.getByRole('button', { name: /^graph$/i }), 'the swarm graph')) {
    await sweep('swarm-graph', null)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }

  await page.getByRole('button', { name: /^inbox/i }).click()
  await sweep('inbox', null)
  await page.getByRole('button', { name: /workspace|back/i }).first().click().catch(() => {})
  await page.waitForTimeout(500)

  // And the whole thing again, narrow.
  await page.setViewportSize({ width: 900, height: 700 })
  await sweep('narrow-workspace', '.sidebar .brand')
  await page.locator('button.settings-toggle').first().click()
  await page.locator('[aria-label="Settings"][role="dialog"]').waitFor({ timeout: 10_000 })
  await sweep('narrow-settings', '[aria-label="Settings"] h2')
  await page.keyboard.press('Escape')
  await page.setViewportSize(VIEWPORT)

  // Cleanup: leave the shared workspace as this run found it.
  await page.getByRole('button', { name: new RegExp(`^Delete #${channelName}$`) }).click().catch(() => {})
  await page.getByRole('button', { name: new RegExp(`^Confirm deleting #${channelName}$`) }).click().catch(() => {})
  await page.waitForTimeout(1_000)

  void boxOf
} finally {
  await browser.close()
  await stack.close()
}

console.log(
  failures === 0
    ? `\nevery surface clean — screenshots in artifacts/sweep/`
    : `\n${failures} surface(s) with something to look at — screenshots in artifacts/sweep/`,
)
process.exit(failures === 0 ? 0 : 1)
