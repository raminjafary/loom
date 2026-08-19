import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Reads the operator's Claude OAuth access token from wherever Claude Code keeps it on
 * this host, so the egress proxy can present it upstream.
 *
 * This is the piece that makes "sandboxed, and no credential inside the sandbox"
 * actually achievable for the Claude backend. The run presents its lease token in the
 * position a credential would occupy; the proxy replaces it with this. Nothing real ever
 * crosses into a container.
 *
 * Read *here*, on the host, because that is the only place it exists: on macOS it is in
 * the login keychain, which no container can reach.
 *
 * Licensing, stated because it is a real constraint and not a technical one: the SDK's
 * terms prohibit exposing claude.ai subscription limits to *your users*. A single
 * operator running their own Loom is one reading; a team workspace on one person's
 * subscription is the case the term is about. An API key remains supported for that
 * reason.
 */

const KEYCHAIN_SERVICE = 'Claude Code-credentials'

interface ClaudeOAuth {
  readonly accessToken: string
  /** Epoch ms. Used only to warn — refreshing is Claude Code's job, not the Runner's. */
  readonly expiresAt: number | null
}

const parseCredentials = (raw: string): ClaudeOAuth | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
  if (typeof oauth !== 'object' || oauth === null) return null
  const { accessToken, expiresAt } = oauth as { accessToken?: unknown; expiresAt?: unknown }
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null
  return { accessToken, expiresAt: typeof expiresAt === 'number' ? expiresAt : null }
}

/**
 * Returns null rather than throwing when the host is not signed in — that is a normal
 * configuration (an operator using an API key instead), not an error.
 */
export const hostClaudeAuthEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.LOOM_USE_HOST_CLAUDE_AUTH === '1'

export const readHostClaudeOAuth = async (): Promise<ClaudeOAuth | null> => {
  // Reading an operator's keychain is a capability the Runner should not take
  // silently, so it is explicit opt-in — the same reasoning as the API-key
  // passthrough it replaces. Off by default even though it is the safer of the two
  // credential paths.
  if (!hostClaudeAuthEnabled()) return null

  if (platform() === 'darwin') {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-w',
      ])
      return parseCredentials(stdout)
    } catch {
      return null
    }
  }

  try {
    return parseCredentials(await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * The shape Claude Code's CLI expects to find at `$HOME/.claude/.credentials.json`.
 *
 * Written into a run's sandbox carrying the **lease token**, not a credential. Its only
 * job is to make the CLI believe it is signed in so it proceeds to call
 * `ANTHROPIC_BASE_URL`; the proxy then replaces the token. Verified by experiment: the
 * CLI forwards this value byte-exact in `Authorization: Bearer`, unlike
 * `ANTHROPIC_API_KEY`, which it validates offline and rewrites.
 */
export const sandboxCredentialsFile = (leaseToken: string): string =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: leaseToken,
      refreshToken: leaseToken,
      // Far enough out that the CLI does not try to refresh mid-run. Refreshing is the
      // host's job — the sandbox has nothing to refresh with.
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      refreshTokenExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
  })
