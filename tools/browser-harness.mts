/**
 * A real browser over the real stack — the harness Phase 3c is, and the four things it
 * needed that no component test provides.
 *
 * The evidence for this file is a ratio rather than an opinion: **every UI defect this
 * project has shipped was found by a human looking at a browser, and none by the suite.**
 * That held while `apps/web` grew past a hundred component tests, because the defects keep
 * being layout, geometry, emphasis, scroll position and third-party integration — the class
 * `happy-dom` cannot see. It has no layout engine, so a box has no size, nothing is above or
 * below a fold, and a stylesheet that matches nothing is indistinguishable from one that
 * matches everything.
 *
 * Four decisions, so they are not re-derived:
 *
 * 1. **It signs in, it does not forge a session.** An earlier attempt at seeding an auth
 *    cookie into a browser profile failed three times and would have been the wrong thing
 *    even had it worked: the login gate is a surface, the cookie the server sets is the one
 *    the app must accept, and a harness that skipped both would not have exercised either.
 *    So the browser fills in the real form against real Better Auth, and the workspace it
 *    lands in is the one `ensureMembership` makes for a new user.
 * 2. **The production bundle, not the dev server.** Styles are injected by script in dev and
 *    extracted to a file in a build, and the very first defect on the list is a stylesheet
 *    that matched nothing. Testing the shape a human never loads would have missed it.
 * 3. **Seeding goes through the contract, carrying the browser's own cookie.** A fixture
 *    written straight into Postgres can describe a state the API would refuse to produce.
 *    The client here is the same oRPC contract the app calls, authenticated as the person
 *    at the keyboard.
 * 4. **The assertions are about what is *visible*.** `toBeMounted` is what the component
 *    suite already says. What it cannot say is that the element has a size, sits inside the
 *    viewport, does not overflow its parent, and is legible against what is behind it —
 *    which is, one for one, the list of defects that shipped.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import { chromium, type Browser, type Page } from 'playwright'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'

const execFileAsync = promisify(execFile)
const REPO_ROOT = new URL('..', import.meta.url).pathname
const WEB_DIST = join(REPO_ROOT, 'apps/web/dist')

/** A port the OS says is free right now. Both servers need one before the build runs. */
export const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * The built app, served the way anything serves an SPA: a file if there is one, and
 * `index.html` if there is not, so a deep link is the app rather than a 404.
 */
export const serveBuiltApp = async (port: number): Promise<Server> => {
  const server = createServer((request, response) => {
    void (async () => {
      const path = normalize(decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/'))
      // A traversal out of dist is a bug in the harness, not an attack surface, but a
      // harness that reads the repository because a test asked it to is still wrong.
      const candidate = join(WEB_DIST, path.replace(/^(\.\.[/\\])+/, ''))
      const file = await stat(candidate)
        .then((entry) => (entry.isFile() ? candidate : join(WEB_DIST, 'index.html')))
        .catch(() => join(WEB_DIST, 'index.html'))
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        // Nothing may be cached between runs of a harness whose whole subject is what
        // the current build renders.
        'cache-control': 'no-store',
      })
      createReadStream(file).pipe(response)
    })()
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return server
}

/**
 * `vite build` with the API's address baked in. The addresses have to exist before the
 * build because Vite inlines `import.meta.env` at transform time — which is also why this
 * cannot be a build cached between runs on different ports.
 */
export const buildWebApp = async (input: {
  readonly rpcUrl: string
  readonly wsUrl: string
  readonly authUrl: string
  readonly log?: (message: string) => void
}): Promise<void> => {
  input.log?.('building the web app')
  const started = Date.now()
  await execFileAsync('npx', ['vite', 'build', '--logLevel', 'warn'], {
    cwd: join(REPO_ROOT, 'apps/web'),
    env: {
      ...process.env,
      VITE_RPC_URL: input.rpcUrl,
      VITE_WS_URL: input.wsUrl,
      VITE_AUTH_URL: input.authUrl,
    },
    maxBuffer: 32 * 1024 * 1024,
  })
  input.log?.(`built in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

export interface BrowserSession {
  readonly page: Page
  readonly browser: Browser
  /** The cookie header the browser holds, for calling the contract as this person. */
  readonly cookieHeader: () => Promise<string>
  readonly screenshot: (name: string) => Promise<string>
  readonly close: () => Promise<void>
}

/**
 * A viewport small enough to be honest. 1280×800 is a laptop, and the defect that prompted
 * the most recent report — an inspector rendering several screens below the fold — is only
 * visible to a harness that has a fold at all.
 */
export const VIEWPORT = { width: 1280, height: 800 }

export const openBrowser = async (input: {
  readonly artifacts: string
  readonly headed?: boolean
  readonly onConsoleError?: (message: string) => void
}): Promise<BrowserSession> => {
  await mkdir(input.artifacts, { recursive: true })
  const browser = await chromium.launch({ headless: input.headed !== true })
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()

  /**
   * A page error is a defect even when every assertion passes — an exception during render
   * leaves a component half-drawn and the next assertion looking at what survived.
   */
  page.on('pageerror', (error) => input.onConsoleError?.(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') input.onConsoleError?.(message.text())
  })

  let shot = 0
  return {
    page,
    browser,
    cookieHeader: async () => {
      const cookies = await context.cookies()
      return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    },
    screenshot: async (name: string) => {
      shot += 1
      const path = join(input.artifacts, `${String(shot).padStart(2, '0')}-${name}.png`)
      await page.screenshot({ path, fullPage: false })
      return path
    },
    close: async () => {
      await context.close()
      await browser.close()
    },
  }
}

/**
 * Signs up through the gate, the way a person does.
 *
 * A fresh email per run because Better Auth is right to refuse a duplicate, and a harness
 * that reused one would pass on the first run of the day and fail on the second with an
 * error about the account rather than about the app.
 */
export const signUpThroughTheGate = async (
  page: Page,
  origin: string,
  who = `browser-check-${Date.now()}@example.test`,
): Promise<string> => {
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /create an account/i }).click()
  await page.getByLabel('Name').fill('Browser Check')
  await page.getByLabel('Email').fill(who)
  await page.getByLabel('Password').fill('a-password-long-enough')
  await page.getByRole('button', { name: /^create account$/i }).click()
  return who
}

// ---------------------------------------------------------------------------
// The vocabulary. Every one of these is a question happy-dom cannot answer.
// ---------------------------------------------------------------------------

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * A short timeout on purpose. The default is thirty seconds, which turns "this element is
 * not there" — a perfectly ordinary assertion failure — into a driver that appears to hang
 * and then dies with a stack trace instead of a `FAIL` line.
 */
export const boxOf = async (page: Page, selector: string, timeout = 2_000): Promise<Box | null> =>
  page
    .locator(selector)
    .first()
    .boundingBox({ timeout })
    .catch(() => null)

/** Rendered at all: present, displayed, and occupying real space. */
export const isVisible = async (page: Page, selector: string): Promise<boolean> => {
  const box = await boxOf(page, selector)
  return box !== null && box.width > 0 && box.height > 0
}

/**
 * Inside the window a person is looking at.
 *
 * The defect this exists for shipped as a working feature nobody could see: an inspector
 * and its proposal rendered several screens down, correct in every component test, reported
 * by an operator as broken. `mounted` and `on screen` are different claims.
 */
export const isInViewport = async (page: Page, selector: string): Promise<boolean> => {
  if ((await boxOf(page, selector)) === null) return false
  return page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.right <= window.innerWidth &&
      rect.width > 0 &&
      rect.height > 0
    )
  })
}

/** No part of the child sticks out of the parent — the shape of "squeezed unreadable". */
export const fitsWithin = async (
  page: Page,
  childSelector: string,
  parentSelector: string,
): Promise<boolean> => {
  const [child, parent] = [
    await boxOf(page, childSelector),
    await boxOf(page, parentSelector),
  ]
  if (child === null || parent === null) return false
  return (
    child.x >= parent.x - 1 &&
    child.y >= parent.y - 1 &&
    child.x + child.width <= parent.x + parent.width + 1 &&
    child.y + child.height <= parent.y + parent.height + 1
  )
}

/** The whole page, not one element: a layout that pushes the document sideways. */
export const hasHorizontalOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)

/**
 * Whether a declared style actually landed.
 *
 * The first defect on the list was a `<style scoped>` block whose selectors were rewritten
 * to match a third-party library's own elements, which carry no scope attribute — so every
 * rule matched nothing, and the canvas rendered as an unsized box. A component test cannot
 * see it: the class is on the element either way.
 */
export const computedStyle = (page: Page, selector: string, property: string): Promise<string> =>
  page
    .locator(selector)
    .first()
    .evaluate(
      (element, prop) => getComputedStyle(element).getPropertyValue(prop),
      property,
    )

const relativeLuminance = ([r, g, b]: [number, number, number]): number => {
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

const parseRgb = (value: string): [number, number, number] | null => {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Contrast against whatever is actually behind the text, walking up for a parent that
 * paints — the reason an unreadable edge label passed review is that its own background is
 * `transparent`, so the colour it is read against is not on the element at all.
 */
export const contrastRatio = async (page: Page, selector: string): Promise<number | null> => {
  const pair = await page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element)
      let node: Element | null = element
      let background = 'rgba(0, 0, 0, 0)'
      while (node) {
        const candidate = getComputedStyle(node).backgroundColor
        if (candidate && !candidate.startsWith('rgba(0, 0, 0, 0)') && candidate !== 'transparent') {
          background = candidate
          break
        }
        node = node.parentElement
      }
      return { color: style.color, background }
    })
  const [foreground, background] = [parseRgb(pair.color), parseRgb(pair.background)]
  if (!foreground || !background) return null
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  ) as [number, number]
  return (lighter + 0.05) / (darker + 0.05)
}

/** Font size in CSS pixels, for the "too small to read" half of legibility. */
export const fontSizePx = async (page: Page, selector: string): Promise<number> =>
  Number.parseFloat(await computedStyle(page, selector, 'font-size'))

export interface Stack {
  readonly origin: string
  readonly apiBase: string
  readonly wsBase: string
  readonly close: () => Promise<void>
}

export interface StackPorts {
  readonly apiPort: number
  readonly wsPort: number
  readonly webPort: number
  /** Where the app will be served from, which the API needs for CORS before it starts. */
  readonly webOrigin: string
}

/**
 * Server, static app, and the addresses that tie them together.
 *
 * The app is served from a different port than the API, exactly as `make dev` serves it —
 * so the CORS and cookie arrangement under test is the deployed one rather than a
 * same-origin shortcut that would hide a misconfiguration.
 */
export const startStack = async (input: {
  /**
   * Starts the API and the realtime gateway on the ports it is given. Both, because
   * `/ws/client` is a separate service from the API in every deployment — a harness that
   * quietly folded them into one process would be testing a topology nobody runs, and the
   * app's first act after sign-in is to open that socket.
   */
  readonly start: (ports: StackPorts) => Promise<{ close: () => Promise<void> }>
  readonly log?: (message: string) => void
  readonly skipBuild?: boolean
}): Promise<Stack> => {
  const [apiPort, wsPort, webPort] = [await freePort(), await freePort(), await freePort()]
  const apiBase = `http://127.0.0.1:${apiPort}`
  const wsBase = `ws://127.0.0.1:${wsPort}`
  const origin = `http://127.0.0.1:${webPort}`

  const services = await input.start({ apiPort, wsPort, webPort, webOrigin: origin })

  if (input.skipBuild !== true) {
    await buildWebApp({
      rpcUrl: `${apiBase}/rpc`,
      wsUrl: `${wsBase}/ws/client`,
      authUrl: `${apiBase}/api/auth`,
      ...(input.log ? { log: input.log } : {}),
    })
  }
  const web = await serveBuiltApp(webPort)

  return {
    origin,
    apiBase,
    wsBase,
    close: async () => {
      await new Promise<void>((resolve) => web.close(() => resolve()))
      await services.close()
    },
  }
}

/** Kept so a caller can hold a Runner beside the stack without importing child_process. */
export const spawnRunner = (env: Record<string, string>): ChildProcess =>
  spawn('npx', ['tsx', 'apps/runner/src/main.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

// ---------------------------------------------------------------------------
// Seeding a surface that needs a run
// ---------------------------------------------------------------------------

/**
 * An authenticated client for whoever the browser signed in as.
 *
 * The cookies are lifted from the Playwright context rather than a second session being
 * minted, so the driver and the page are the *same* user looking at the same workspace —
 * which is the only arrangement in which seeding through the contract and then asserting on
 * what the page renders means anything.
 */
export const clientAsThePage = async (page: Page, apiBase: string): Promise<any> => {
  const cookies = await page.context().cookies()
  const cookie = cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ')
  return createORPCClient(new RPCLink({ url: `${apiBase}/rpc`, headers: { cookie } }))
}

/**
 * The platform's WebSocket, not the `ws` package — a driver helper should not add a dependency
 * the repository does not otherwise have, and Node has had this global since 22, which is the
 * floor `engines` already sets.
 */
const nextRunnerFrame = (socket: WebSocket, match: (frame: any) => boolean): Promise<any> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no matching frame within 20s')), 20_000)
    const onMessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data))
      if (!match(frame)) return
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      resolve(frame)
    }
    socket.addEventListener('message', onMessage)
  })

export interface ProsecutedBranch {
  readonly runId: string
  readonly branchName: string
  readonly personaName: string
  readonly close: () => Promise<void>
}

/**
 * A finished branch with a prosecution against it, seeded **through the real protocol**.
 *
 * Some surfaces cannot be reached by clicking: the Inbox's review lane needs a terminal run
 * with a branch nobody has decided about, and the prosecution card needs a prosecutor to have
 * reported a broken probe. Both of those normally cost a model.
 *
 * The alternative to this function was inserting `agent_run` and `run_prosecution` rows by
 * hand, and that is the thing worth *not* doing: a hand-built row is a guess about a shape the
 * platform owns, it drifts the first time a column moves, and a driver asserting on it ends up
 * describing a fixture rather than the product. So what is faked here is exactly one thing —
 * the model — and everything else is real. A Runner pairs over `/ws/runner` and speaks the
 * protocol; the run is started through the contract; the branch arrives as
 * `run_workspace_ready`; the terminal transition is an `agent_event`; and the *platform* then
 * starts the prosecutor on its own, which the fake answers with `prosecution_reported`. If any
 * of those shapes changes, this fails loudly rather than rendering a stale fixture.
 *
 * The verdict is deliberately left `pending`: running the repository's checks would need the
 * Runner to be real, and a card showing a verdict that is still coming is a state the Inbox
 * renders on purpose ("a blank where a verdict is coming reads as a pass").
 */
export const seedProsecutedBranch = async (input: {
  readonly client: any
  readonly apiBase: string
  readonly task: string
  readonly observations: readonly { name: string; outcome: 'held' | 'broke'; detail: string | null }[]
}): Promise<ProsecutedBranch> => {
  const { client, apiBase } = input
  /**
   * Everything named here is named uniquely, because the gate signs in to the *shared* default
   * workspace and cannot truncate it — so a fixed name collides with the previous run of the
   * same driver, and with the call two lines below it.
   */
  const tag = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
  const { runnerId, rawToken } = await client.runner.createPairingToken({ name: `seeded-${tag}` })

  const socket = new WebSocket(`${apiBase.replace(/^http/, 'ws')}/ws/runner`)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('the seeded Runner could not connect')), {
      once: true,
    })
  })
  socket.send(JSON.stringify({ type: 'hello', token: rawToken, allowedRoots: ['/tmp'] }))
  await nextRunnerFrame(socket, (frame) => frame.type === 'hello_ack')

  const checkPath = nextRunnerFrame(socket, (frame) => frame.type === 'check_path')
  const repository = client.repository.bindExisting({
    runnerId,
    path: `/tmp/seeded-repo-${tag}`,
    displayName: `seeded repo ${tag}`,
  })
  const asked = await checkPath
  socket.send(
    JSON.stringify({
      type: 'check_path_result',
      requestId: asked.requestId,
      ok: true,
      defaultBranch: 'main',
    }),
  )
  const repo = await repository
  /**
   * A definition of done, so the run gets a verification row and the card renders its verdict
   * beside the prosecution. It stays `pending` — running the checks would need the Runner to be
   * real — and pending is a state the Inbox draws on purpose, because a blank where a verdict
   * is coming reads as a pass. It is also the state a prosecution is usually read in: the
   * prosecutor starts when the run ends, which is when verification is merely enqueued.
   */
  await client.repository.setVerificationChecks({
    repositoryId: repo.id,
    checks: [{ name: 'tests', command: 'true' }],
  })

  const personas = await client.persona.list()
  const worker = personas.find((entry: any) => entry.name === 'swe') ?? personas[0]
  const channel = await client.channel.create({ name: `seeded-${tag}` })

  const started = nextRunnerFrame(socket, (frame) => frame.type === 'start_run')
  const run = await client.agentRun.start({
    threadId: channel.rootThread.id,
    repositoryId: repo.id,
    personaId: worker.id,
    task: input.task,
  })
  await started

  const branchName = `loom/run-${run.id}`
  socket.send(
    JSON.stringify({
      type: 'run_workspace_ready',
      runId: run.id,
      clonePath: `/tmp/seeded-clone-${run.id}`,
      branchName,
    }),
  )
  /**
   * The prosecutor's own `start_run` is awaited *before* the completion is sent, because the
   * platform starts it on the terminal transition and the frame would otherwise arrive while
   * nothing was listening.
   */
  const prosecutorStarted = nextRunnerFrame(
    socket,
    (frame) => frame.type === 'start_run' && frame.prosecute === true,
  )
  socket.send(
    JSON.stringify({
      type: 'agent_event',
      runId: run.id,
      seq: 1,
      event: { kind: 'run_completed', totalCostUsd: 0.21, result: 'Done.' },
    }),
  )
  const prosecutor = await prosecutorStarted

  socket.send(
    JSON.stringify({
      type: 'run_workspace_ready',
      runId: prosecutor.runId,
      clonePath: `/tmp/seeded-clone-${prosecutor.runId}`,
      branchName: `loom/run-${prosecutor.runId}`,
    }),
  )
  /**
   * Reported, and the acknowledgement **awaited** before the run is allowed to finish.
   *
   * Not politeness: the two frames race. A prosecutor's terminal transition closes an
   * unreported prosecution as `inconclusive`, so a completion that overtakes the report in the
   * server's handlers wins and the evidence is refused as a second report. The first version of
   * this helper sent both and got three `inconclusive` rows with no observations — which is the
   * platform behaving correctly about a Runner that lied about when it had finished.
   *
   * The real Runner does not have this problem, because the report is a *tool call*: the model
   * cannot end its turn until the tool has returned. Awaiting the ack is how a fake earns the
   * same ordering.
   */
  /**
   * Waited for, because the platform opens the prosecution row *after* it dispatches the run.
   *
   * `startProsecutor` calls `startAgentRun` — which sends `start_run` — and only then writes
   * the row that `recordProsecution` looks the report up by. A real prosecutor cannot lose that
   * race: it has to clone a repository and boot a container before its model sees anything, so
   * the row is microseconds old by then. A fake that answers the frame in the same tick gets
   * "this run is not prosecuting anything", which is the platform telling the truth about an
   * order of events no real Runner produces.
   *
   * Worth knowing rather than worth fixing, and written down here rather than worked around
   * silently: the hazard is real but the window is a database round trip against a clone.
   */
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [row] = await client.agentRun.listProsecutions({ agentRunIds: [run.id] })
    if (row) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const requestId = `seed-${tag}`
  const acked = nextRunnerFrame(
    socket,
    (frame) => frame.type === 'persona_prompt_result' && frame.requestId === requestId,
  )
  socket.send(
    JSON.stringify({
      type: 'prosecution_reported',
      runId: prosecutor.runId,
      requestId,
      observations: input.observations,
      inconclusive: null,
    }),
  )
  const ack = await acked
  if (ack.ok !== true) throw new Error(`the seeded prosecution was refused: ${String(ack.error)}`)

  socket.send(
    JSON.stringify({
      type: 'agent_event',
      runId: prosecutor.runId,
      seq: 1,
      event: { kind: 'run_completed', totalCostUsd: 0.13, result: 'Reported.' },
    }),
  )

  return {
    runId: run.id,
    branchName,
    personaName: worker.name,
    close: async () => {
      socket.close()
    },
  }
}
