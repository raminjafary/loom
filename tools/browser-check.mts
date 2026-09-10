/**
 * The surfaces a person operates, in a **real browser** — Phase 3c, the roadmap's trailing item.
 *
 *   docker compose up -d postgres valkey
 *   pnpm db:test:prepare
 *   npx tsx tools/browser-check.mts            # add HEADED=1 to watch it
 *
 * Zero tokens. It signs up through the real gate, drives the real app against a real server
 * and a real realtime gateway, and asserts on what is **visible** — size, position against
 * the fold, overflow, contrast — because that is the class of defect this project keeps
 * shipping and the class `happy-dom` structurally cannot see.
 *
 * The ratio that put it on the roadmap: every UI defect this project has shipped was found
 * by a human looking at a browser, and none by the suite, across a run of sessions in which
 * `apps/web` grew past a hundred component tests. On its first run this driver found the
 * selected view tab rendering its label at a contrast ratio of 1.02 — invisible, in the
 * default theme, on every load. That defect is fixed; the check that would have caught it is
 * `contrast`, below, and the check that keeps its *cause* from returning is in
 * `architecture.test.ts`.
 *
 * It **asserts** rather than prints, and the assertions are deliberately about geometry
 * rather than about content: `toBeMounted` is what the component suite already says.
 *
 * Screenshots land in `artifacts/browser/` — evidence for a human, never the verdict.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { buildApp } from '../apps/server/src/index.js'
import { loadConfig } from '../apps/server/src/config.js'
import { buildGateway } from '../apps/ws-gateway/src/gateway.js'
import {
  boxOf,
  clientAsThePage,
  computedStyle,
  contrastRatio,
  hasHorizontalOverflow,
  isInViewport,
  isVisible,
  openBrowser,
  seedProsecutedBranch,
  signUpThroughTheGate,
  startStack,
  VIEWPORT,
} from './browser-harness.mts'

const REPO_ROOT = new URL('..', import.meta.url).pathname
const ARTIFACTS = join(REPO_ROOT, 'artifacts/browser')
const SUBSCRIPTION_SECRET = 'browser-check-subscription-secret-32-chs'

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
      // The test database, like every other driver here: this one signs up a user and
      // creates a channel, and a dev workspace is not somewhere to do that.
      NODE_ENV: 'test',
      BETTER_AUTH_SECRET: 'browser-check-secret-at-least-32-characters',
      WS_SUBSCRIPTION_SECRET: SUBSCRIPTION_SECRET,
      SERVER_PORT: String(apiPort),
      WEB_ORIGIN: webOrigin,
    } as NodeJS.ProcessEnv)
    const app = await buildApp(config)
    await app.fastify.listen({ port: apiPort, host: '127.0.0.1' })
    /**
     * The realtime gateway is a separate service in every deployment, and the app's first
     * act after sign-in is to open a socket to it. Folding it into the API here would test
     * a topology nobody runs.
     */
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

/**
 * Every console error and page exception, gathered for one assertion at the end. A render
 * that threw leaves a component half-drawn, and every later assertion then describes the
 * wreckage rather than the defect.
 */
const consoleErrors: string[] = []
const browser = await openBrowser({
  artifacts: ARTIFACTS,
  headed: process.env.HEADED === '1',
  onConsoleError: (message) => consoleErrors.push(message),
})
const { page } = browser
/**
 * Every refused request, printed rather than counted. A 4xx the app swallows shows up
 * nowhere else — the console assertion below catches that one threw, and this line is what
 * says which endpoint and why.
 */
page.on('response', (response) => {
  if (response.status() < 400) return
  void response
    .text()
    .then((body) => console.log(`   HTTP ${response.status()} ${response.url()} ${body.slice(0, 200)}`))
    .catch(() => {})
})

try {
  // ---------------------------------------------------------------- the gate
  await page.goto(stack.origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /create an account/i }).waitFor()
  await browser.screenshot('gate')

  check('the gate renders its form', await isVisible(page, 'form.card'))
  check('the whole form is above the fold', await isInViewport(page, 'form.card'))
  check('the gate does not scroll sideways', !(await hasHorizontalOverflow(page)))

  await signUpThroughTheGate(page, stack.origin)
  await page.locator('.app').waitFor({ timeout: 20_000 })
  await page.waitForTimeout(1_500)
  await browser.screenshot('shell')

  // --------------------------------------------------------------- the shell
  check('the shell renders', await isVisible(page, '.app'))
  check('the composer is on screen, not below the fold', await isInViewport(page, '.composer, footer textarea'))
  check('the shell does not scroll sideways', !(await hasHorizontalOverflow(page)))

  /**
   * The socket, from the browser's side. Its absence is invisible in a screenshot and
   * fatal in use: every run event, cost tick and status change arrives on it.
   */
  const connection = await page.locator('.conn').first().getAttribute('class')
  check('the realtime connection is open', connection?.includes('open') === true, connection ?? 'no indicator')

  /**
   * The defect this driver found on its first run. A selected control has to be readable,
   * and 4.5:1 is the ordinary threshold for text this size.
   */
  const selectedTab = await contrastRatio(page, '.thread-views button.on')
  check(
    'the selected view tab is legible against its own background',
    (selectedTab ?? 0) >= 4.5,
    `${(selectedTab ?? 0).toFixed(2)}:1`,
  )

  /**
   * A sweep rather than a list, because the next one of these will be on a control nobody
   * thought to name here. Disabled controls are exempt: they are deliberately faint, and
   * that is the one place low contrast carries meaning.
   */
  /**
   * Passed as source text rather than as a function. The drivers run under a TypeScript
   * loader that rewrites arrow functions to reference its own `__name` helper, which does
   * not exist inside the page — the evaluate throws `ReferenceError` and takes the run with
   * it. Every in-page function below is a string for that reason.
   */
  const unreadable: string[] = await page.evaluate(`(() => {
    const luminance = (value) => {
      const match = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?/.exec(value)
      if (!match) return null
      if (match[4] !== undefined && Number(match[4]) === 0) return null
      const channel = (raw) => {
        const c = Number(raw) / 255
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * channel(match[1]) + 0.7152 * channel(match[2]) + 0.0722 * channel(match[3])
    }
    const backgroundOf = (element) => {
      let node = element
      while (node) {
        const candidate = getComputedStyle(node).backgroundColor
        if (luminance(candidate) !== null) return candidate
        node = node.parentElement
      }
      return 'rgb(255, 255, 255)'
    }
    const out = []
    for (const element of Array.from(document.querySelectorAll('button, a, label, h1, h2, h3'))) {
      if (element.disabled) continue
      const style = getComputedStyle(element)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      if (Number(style.opacity) < 0.7) continue
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const text = (element.textContent || '').trim()
      if (!text) continue
      const fg = luminance(style.color)
      const bg = luminance(backgroundOf(element))
      if (fg === null || bg === null) continue
      const lighter = fg > bg ? fg : bg
      const darker = fg > bg ? bg : fg
      const ratio = (lighter + 0.05) / (darker + 0.05)
      if (ratio < 3) out.push(text.slice(0, 24) + ' (' + ratio.toFixed(2) + ':1)')
    }
    return out
  })()`)
  check('every enabled control is readable against what is behind it', unreadable.length === 0, unreadable.join(', '))

  // --------------------------------------------------- an empty state that speaks
  /**
   * "An empty canvas that said nothing" is on the list of defects that shipped. A panel
   * with nothing in it still has to tell a person that, and a summary is where it does.
   */
  const silentSections: string[] = await page.evaluate(`Array.from(document.querySelectorAll('section.section'))
      .filter((section) => ((section.querySelector('.summary') || {}).textContent || '').trim().length === 0)
      .map((section) => ((section.querySelector('.title') || {}).textContent || '?').trim())`)
  check('every collapsed sidebar section says what is in it', silentSections.length === 0, silentSections.join(', '))

  // ------------------------------------------------------------- doing something
  /**
   * A name per run. This deployment has one workspace and every sign-up joins it, so a
   * fixed name is a 400 on the second run of the day — which is a fact about the platform
   * worth knowing, and not one this driver should re-discover every time.
   */
  const channelName = `browser-check-${Date.now().toString(36)}`
  await page.getByPlaceholder('new-channel').fill(channelName)
  await page.getByRole('button', { name: /^add$/i }).click()
  await page.getByText(channelName, { exact: false }).first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(500)

  /**
   * "A create that never selected what it created" is on the list. Creating a thing and
   * leaving the person on the previous one is the defect, and it is invisible to a test
   * that asserts the request was made.
   */
  const heading = (await page.locator('.topbar h1, .topbar h2').first().innerText()).trim()
  check('creating a channel selects it', heading.includes(channelName), heading)

  await page.getByPlaceholder(/^Message/).fill('a message from the browser check')
  await page.getByRole('button', { name: /^send$/i }).click()
  await page.getByText('a message from the browser check').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(500)
  await browser.screenshot('channel')

  check(
    'a sent message is on screen',
    await isInViewport(page, 'text=a message from the browser check'),
  )
  check('sending does not push the page sideways', !(await hasHorizontalOverflow(page)))

  /**
   * Deleting a channel is two clicks by design — the icon arms, the second click fires —
   * and it leaves the shared workspace as this run found it.
   *
   * What is *not* asserted here: the server's refusal, which fires on runs started in the
   * channel rather than on messages in it. A channel with runs costs a Runner and a model,
   * and this driver spends neither. The refusal has its own coverage in the application
   * tests; what a browser adds — that the sentence lands somewhere a person can see — is
   * the half still waiting on a driver that starts a run.
   */
  await page.getByRole('button', { name: new RegExp(`^Delete #${channelName}$`) }).click()
  await page.getByRole('button', { name: new RegExp(`^Confirm deleting #${channelName}$`) }).click()
  await page.waitForTimeout(1_500)
  check(
    'a channel deleted from the sidebar goes away',
    (await page.getByText(channelName, { exact: false }).count()) === 0,
  )

  // ------------------------------------------------------- the third-party canvas
  /**
   * The first defect on the list was a `<style scoped>` block whose rules were rewritten to
   * match this component's scope attribute — which the canvas library's own pane, viewport
   * and nodes do not carry. Every rule matched nothing, `width/height: 100%` never applied,
   * and the canvas rendered as an unsized box. An element with no size is exactly what a
   * component test cannot see.
   */
  await page.getByRole('button', { name: /^design$/i }).click()
  await page.waitForTimeout(1_500)
  await browser.screenshot('design-canvas')
  const canvas = await page.locator('.vue-flow').first().boundingBox()
  check(
    'the canvas has a size',
    canvas !== null && canvas.width > 200 && canvas.height > 200,
    canvas ? `${Math.round(canvas.width)}×${Math.round(canvas.height)}` : 'no box',
  )
  check('the canvas does not overflow the page', !(await hasHorizontalOverflow(page)))

  /**
   * A dialog that claims `aria-modal` and cannot be dismissed from the keyboard is the
   * defect this driver found second, and the third instance of one this project has
   * already fixed twice: the handler sits on a `tabindex="-1"` scrim that nothing focuses,
   * so it never fires. Asserted here rather than in a component test because whether an
   * element *has focus* is a property of a real document, and the mounted component has
   * the handler either way.
   */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  check(
    'the team composer closes on Escape',
    (await page.locator('[aria-label="Compose a team"]').count()) === 0,
  )

  // -------------------------------------------------------------- the overlays
  await page.locator('button.settings-toggle').first().click()
  await page.waitForTimeout(1_000)
  await browser.screenshot('settings')
  check('settings opens', await isVisible(page, '[aria-label="Settings"][role="dialog"]'))
  /**
   * The most recent defect an operator reported as broken was an inspector rendering
   * several screens below the fold: it worked, and could not be seen. An overlay's own
   * heading being on screen is the cheapest form of that assertion.
   */
  check(
    'the settings overlay starts on screen',
    await isInViewport(page, '[aria-label="Settings"] h2'),
  )
  check('settings does not scroll the page sideways', !(await hasHorizontalOverflow(page)))
  /**
   * The tab bar must not move when the tab changes.
   *
   * The sheet was centred and its height followed its content, so switching tabs moved the
   * header the tabs live in — 235px across the six of them, which means the control you are
   * aiming at leaves from under the cursor as you click it. Invisible to every component test
   * in `apps/web`, because `happy-dom` has no layout engine and every one of these numbers is
   * zero there.
   */
  const tabTops: { label: string; top: number }[] = []
  for (const label of ['Runners & repositories', 'Personas & groups', 'Expertise', 'Workflows', 'Colosseum', 'Capabilities']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.waitForTimeout(400)
    const box = await boxOf(page, '[aria-label="Settings"] nav')
    tabTops.push({ label, top: Math.round(box?.y ?? -1) })
  }
  const tops = tabTops.map((entry) => entry.top)
  check(
    'the settings tab bar stays put as the tab changes',
    tops.length > 0 && Math.max(...tops) - Math.min(...tops) === 0,
    tabTops.map((entry) => `${entry.label}@${entry.top}`).join(' · '),
  )

  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  check(
    'settings closes on Escape',
    (await page.locator('[aria-label="Settings"][role="dialog"]').count()) === 0,
  )

  await page.getByRole('button', { name: /^inbox/i }).click()
  await page.waitForTimeout(1_000)
  await browser.screenshot('inbox')
  const inboxText = (await page.locator('main').innerText()).trim()
  check('the inbox says something when it is empty', inboxText.length > 0, `${inboxText.slice(0, 40)}…`)

  /**
   * The Inbox with something in it, which is the half no driver had ever seen.
   *
   * Two branches, one of them prosecuted. The prosecution's whole product effect is an
   * *ordering* — a branch whose diff broke a probe somebody wrote for it is a better use of
   * the next thirty seconds — and an ordering is a thing only a rendered page can be asked
   * about. `inbox-board.test.ts` proves the array; this proves the column.
   */
  console.log('\n— the Inbox, with a prosecuted branch in it —')
  const client = await clientAsThePage(page, stack.apiBase)
  const quiet = await seedProsecutedBranch({
    client,
    apiBase: stack.apiBase,
    task: 'A branch nobody wrote a probe against.',
    observations: [{ name: 'the old path still refuses an empty answer', outcome: 'held', detail: null }],
  })
  const noisy = await seedProsecutedBranch({
    client,
    apiBase: stack.apiBase,
    task: 'A branch whose diff broke a probe.',
    observations: [
      { name: 'the documented lower bound is enforced', outcome: 'broke', detail: 'applyDiscount(100, -10) returned 110 — the price went up.' },
      { name: 'the upper bound throws', outcome: 'held', detail: null },
    ],
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /^inbox/i }).click()
  await page.waitForTimeout(2_000)
  await browser.screenshot('inbox-prosecuted')

  /**
   * Relative, not absolute. The gate signs in to the shared default workspace and cannot
   * truncate it, so the lane holds whatever previous runs left — and the claim was never "there
   * are two cards", it is "the one with a broken probe is above the one without". That holds
   * however much else is in the column, which is also the only form in which it is worth
   * anything: a lane with two cards does not need ordering.
   */
  const reviewLane = page.locator('.lane').filter({ hasText: /ready to review/i }).first()
  const cards = reviewLane.locator('li.row')
  const texts = await cards.allInnerTexts()
  /**
   * By the *head* of the run id, because that is what the card shows: `shortBranchName` keeps
   * `loom/run-` and the first characters of the id, so matching on the tail finds nothing and
   * reports it as a missing card.
   */
  const indexOfRun = (runId: string) => texts.findIndex((text) => text.includes(runId.slice(0, 8)))
  const noisyAt = indexOfRun(noisy.runId)
  const quietAt = indexOfRun(quiet.runId)

  check('both seeded branches reached the review lane', noisyAt >= 0 && quietAt >= 0, `${noisyAt} and ${quietAt} of ${texts.length}`)
  /**
   * And the prosecutors themselves did not. Each one leaves a branch of its own, so before the
   * board learned to tell work from a second opinion, every prosecuted branch put *two* cards
   * in this column and two on the badge — one of them a run whose prompt tells it to commit
   * nothing. Asserted on the persona name, which is what the card leads with.
   */
  check(
    'and no prosecutor is sitting in it as a thing to decide about',
    !texts.some((text) => /^prosecutor\b/m.test(text.trim())),
    texts.filter((text) => /^prosecutor\b/m.test(text.trim())).length + ' prosecutor card(s)',
  )
  check(
    'the branch whose probe broke is ranked above the one whose probes held',
    noisyAt >= 0 && quietAt >= 0 && noisyAt < quietAt,
    `broke at ${noisyAt}, held at ${quietAt}`,
  )
  check(
    'and its card says why, in the prosecutor’s own sentence',
    /2 probes written against this diff, 1 broke/.test(texts[noisyAt] ?? ''),
    (texts[noisyAt] ?? '').replace(/\n/g, ' · ').slice(0, 120),
  )
  /**
   * The card that has nothing to report says nothing. A summary on every card would make the
   * one that matters indistinguishable from the thirty that do not, which is the failure the
   * ordering exists to prevent.
   */
  check(
    'the branch whose probes all held carries no prosecution line',
    !/probes? written against this diff/.test(texts[quietAt] ?? ''),
    (texts[quietAt] ?? '').replace(/\n/g, ' · ').slice(0, 90),
  )
  /**
   * Legibility, and against the *card* rather than the page: this line is new and muted on
   * purpose, and muted-on-purpose is one shade from invisible. The verdict beside it is the
   * repository's and may be red; a reader who saw these in the same colour would read a refused
   * merge, so they must also not match.
   */
  const probeContrast = await contrastRatio(page, 'li.row .probes')
  check(
    'the prosecution line is legible',
    probeContrast !== null && probeContrast >= 4.5,
    `${probeContrast?.toFixed(2) ?? 'none'}:1`,
  )
  const probeColour = await computedStyle(page, 'li.row .probes', 'color')
  const verdictColour = await computedStyle(page, 'li.row .verdict', 'color')
  check(
    'and it is not the verdict’s colour, because it is not a verdict',
    probeColour !== '' && probeColour !== verdictColour,
    `${probeColour} vs ${verdictColour}`,
  )

  await quiet.close()
  await noisy.close()
  await page.getByRole('button', { name: /workspace|back/i }).first().click().catch(() => {})
  await page.waitForTimeout(500)

  // ------------------------------------------------------------ a narrow window
  /**
   * "A `<select>` that would not shrink" and "columns squeezed unreadable by a detail
   * panel" are both on the list, and both are one viewport away from visible. 900px is a
   * split screen on the same laptop.
   */
  await page.setViewportSize({ width: 900, height: 700 })
  await page.waitForTimeout(1_000)
  await browser.screenshot('narrow')
  check('a narrow window does not scroll sideways', !(await hasHorizontalOverflow(page)))
  const launcher = await boxOf(page, 'aside.agent-sidebar')
  check(
    'the right-hand panel stays inside the window',
    launcher !== null && launcher.x + launcher.width <= 901,
    launcher ? `right edge at ${Math.round(launcher.x + launcher.width)}` : 'not rendered',
  )
  const selects: string[] = await page.evaluate(`Array.from(document.querySelectorAll('select'))
      .map((element) => {
        const rect = element.getBoundingClientRect()
        const parent = element.parentElement ? element.parentElement.getBoundingClientRect() : null
        return parent && rect.width > parent.width + 1
          ? (element.name || element.id || 'select') + ' ' + Math.round(rect.width) + ' > ' + Math.round(parent.width)
          : null
      })
      .filter((entry) => entry !== null)`)
  check('no control is wider than the column holding it', selects.length === 0, selects.join(', '))

  /**
   * Every top-bar control is the thing at its own coordinates.
   *
   * The sweep found this and no assertion here would have: below about 1000px the actions
   * row overflowed the main column and the run launcher — later in the DOM, and fixed-width
   * — painted straight over it. Settings, Inbox, Design and **Stop all** were all present,
   * enabled, and underneath another element. Stop all is the kill switch.
   *
   * `elementFromPoint` is the only honest form of the question: visible, enabled and
   * on-screen were all true the whole time.
   */
  const covered: string[] = await page.evaluate(`(() => {
    const out = []
    for (const el of Array.from(document.querySelectorAll('.topbar-actions button'))) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      if (top !== el && !el.contains(top)) {
        out.push((el.textContent || el.getAttribute('aria-label') || '?').trim().slice(0, 16))
      }
    }
    return out
  })()`)
  check('no top-bar control is covered by another element', covered.length === 0, covered.join(', '))
  await page.setViewportSize(VIEWPORT)

  // ------------------------------------------------------------------ the log
  check('nothing threw in the browser', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} finally {
  await browser.screenshot('final')
  await browser.close()
  await stack.close()
}

console.log(
  failures === 0
    ? `\nall checks passed — screenshots in artifacts/browser/`
    : `\n${failures} check(s) failed — screenshots in artifacts/browser/`,
)
process.exit(failures === 0 ? 0 : 1)
