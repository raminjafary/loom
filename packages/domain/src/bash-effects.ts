/**
 * Effect-based classification for `Bash`.
 *
 * effect-based classification's complaint about name-based gating is precise: `Bash` subsumes every risky
 * category, so gating on the name "either over-gates (approval fatigue) or
 * under-gates (a disallowed effect inside an allowed tool)". This module attacks
 * both ends, and is explicit about the middle it cannot fix.
 *
 * **What this is not.** Static analysis of shell is not sound and cannot be made
 * sound. `eval`, `$(…)`, backticks, a variable holding a command, a base64 blob
 * piped to `sh` — each defeats parsing completely, and an attacker writing the
 * command knows that. So this classifier is built so that being wrong is safe:
 *
 * - It only calls a command **safe** when every part of it is on a read-only
 * allowlist with no shell metacharacter that could redirect, chain or expand.
 * Anything it does not fully understand is not safe.
 * - It **denies** a small set of effects that are boundaries elsewhere in this
 * plan and should not become judgment calls just because they arrived through a
 * shell — pushing (the push policy says the agent never pushes), privilege escalation,
 * and reading host credentials (the credential broker says no credential enters a run).
 * - Everything else **gates**, exactly as before, and now says which effect it
 * gated on so the approval card can show more than a command string.
 *
 * The net change in exposure is one-directional: commands that used to gate can
 * now be denied outright, and commands that gate now say why. The only relaxation
 * is for provably read-only commands inside the run's own workspace, which is the
 * approval-fatigue half effect-based classification names.
 *
 * None of this replaces the sandbox. The sandbox spec is the boundary; this is triage in
 * front of it.
 */

export type BashEffect =
 | 'network'
 | 'write_outside_workspace'
 | 'privilege'
 | 'destructive'
 | 'credential_read'
 | 'vcs_publish'
 /** Contains a construct that cannot be analyzed at all — `eval`, `$(…)`, backticks. */
 | 'opaque'
 | 'unknown_command'

export type BashClassification =
 /** Provably read-only, within the workspace. May skip the human gate. */
 | { readonly kind: 'safe' }
 /** Needs a human decision, against the exact argv. */
 | { readonly kind: 'gate'; readonly effects: BashEffect[] }
 /** A boundary, not a judgment call — no human is asked. */
 | { readonly kind: 'deny'; readonly effect: BashEffect; readonly reason: string }

/**
 * Commands whose every invocation is a read. Deliberately short: each addition is
 * a claim that no flag of that command writes, executes, or reaches the network,
 * and that claim gets harder to make with every entry.
 *
 * `find` is here but `find -exec`/`-delete` are rejected below; `git` is here but
 * only for the read subcommands.
 */
const READ_ONLY_COMMANDS = new Set([
 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'egrep', 'fgrep',
 'find', 'file', 'stat', 'du', 'df', 'pwd', 'echo', 'which', 'basename',
 'dirname', 'realpath', 'sort', 'uniq', 'cut', 'tr', 'diff', 'tree',
 'date', 'env', 'printenv', 'whoami', 'id', 'uname', 'jq', 'true', 'false',
])

/** `git <sub>` that only reads. Everything else about git gates or denies. */
const READ_ONLY_GIT = new Set([
 'status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files',
 'blame', 'describe', 'remote', 'config', 'shortlog', 'tag',
])

/**
 * The push policy: "the agent never pushes and never holds git credentials". Pushing is a
 * host-side platform action, so a shell reaching for it is not a call a human
 * should be asked to weigh — it is the thing the architecture removed.
 */
const GIT_PUBLISH = new Set(['push', 'remote', 'submodule'])

const NETWORK_COMMANDS = new Set([
 'curl', 'wget', 'nc', 'netcat', 'ssh', 'scp', 'sftp', 'rsync', 'telnet',
 'ftp', 'dig', 'nslookup', 'host', 'ping', 'npm', 'pnpm', 'yarn', 'pip',
 'pip3', 'gem', 'cargo', 'go', 'brew', 'apt', 'apt-get', 'gh', 'glab',
])

const PRIVILEGE_COMMANDS = new Set(['sudo', 'su', 'doas', 'pkexec', 'chown', 'chgrp'])

/** Reads that are only meaningful as credential theft. */
const CREDENTIAL_COMMANDS = new Set(['security', 'keyctl', 'gpg', 'pass'])

const CREDENTIAL_PATHS = [
 '.ssh', '.aws', '.gnupg', '.netrc', '.npmrc', '.pypirc', '.docker/config',
 '.kube/config', '.config/gh', '.claude/.credentials', 'id_rsa', 'id_ed25519',
]

/**
 * Constructs that make the rest of the string unanalyzable. Their presence is not
 * itself suspicious — `&&` is in half of all shell — it just means the command
 * cannot be *proved* safe and therefore gates.
 */
const OPAQUE_PATTERNS: readonly RegExp[] = [
 /\$\(/, /`/, /\beval\b/, /\bexec\b/, /\bsource\b/, /^\s*\./,
 /\bbase64\b/, /\bxxd\b/, /\|\s*(sh|bash|zsh|python3?|node|perl|ruby)\b/,
]

/** Anything that could redirect, chain, background or expand. `|` is handled separately. */
const CONTROL_CHARS = /[;&<>{}\n\r`$]/

const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'env', 'nohup', 'xargs', 'time'])

const tokenize = (segment: string): string[] =>
 segment.trim.split(/\s+/).filter((token) => token.length > 0)

/** Strips leading `VAR=value` assignments, which precede the real command. */
const commandOf = (tokens: readonly string[]): { name: string; args: string[] } => {
 let i = 0
 while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i += 1
 const name = (tokens[i] ?? '').split('/').pop ?? ''
 return { name, args: tokens.slice(i + 1) }
}

const mentionsCredentialPath = (command: string): boolean =>
 CREDENTIAL_PATHS.some((needle) => command.includes(needle))

/**
 * Absolute-looking path arguments, and `~`. Used to decide whether a read stays
 * inside the workspace — a relative path cannot leave it without `..`, which is
 * checked alongside.
 */
export const absolutePathArguments = (command: string): string[] =>
 (command.match(/(?:^|\s)(~?\/[^\s;|&<>]*)/g) ?? []).map((match) => match.trim)

const hasParentTraversal = (command: string): boolean => /(^|[\s"'=])\.\.\//.test(command)

/**
 * Classifies without touching the filesystem, so it stays a pure domain function.
 * The caller resolves any absolute paths this reports against the run's clone —
 * see `classifyToolEffect`, which is where the two halves meet.
 */
export const classifyBashCommand = (rawCommand: string): BashClassification => {
 const command = rawCommand.trim
 if (command.length === 0) return { kind: 'safe' }

 // Hard denials first. These are boundaries stated elsewhere in the plan, and
 // arriving through a shell must not turn them into questions.
 const segments = command.split('|')
 const parsed = segments.map((segment) => commandOf(tokenize(segment)))

 for (const { name, args } of parsed) {
 if (PRIVILEGE_COMMANDS.has(name)) {
 return {
 kind: 'deny',
 effect: 'privilege',
 reason: `Refused: ${name} escalates privilege, which no run may do.`,
 }
 }
 if (name === 'chmod' && args.some((arg) => /[+=].*s/.test(arg))) {
 return {
 kind: 'deny',
 effect: 'privilege',
 reason: 'Refused: setting a setuid/setgid bit escalates privilege.',
 }
 }
 if (name === 'git' && GIT_PUBLISH.has(args[0] ?? '') && (args[0] !== 'remote' || args[1] !== 'get-url')) {
 // `git remote get-url` is a read the push path itself uses; the rest of
 // `remote` rewrites where work would be published to.
 if (args[0] !== 'remote' || args.some((a) => ['add', 'set-url', 'remove', 'rename'].includes(a))) {
 return {
 kind: 'deny',
 effect: 'vcs_publish',
 reason:
 'Refused: publishing is a host-side platform action and the agent never pushes ' +
 '. Use the run\'s push/merge controls instead.',
 }
 }
 }
 if (CREDENTIAL_COMMANDS.has(name)) {
 return {
 kind: 'deny',
 effect: 'credential_read',
 reason: `Refused: ${name} reads stored credentials, and no run may hold one.`,
 }
 }
 }

 if (mentionsCredentialPath(command)) {
 return {
 kind: 'deny',
 effect: 'credential_read',
 reason: 'Refused: the command references a credential store.',
 }
 }

 // Then the effects a human may legitimately weigh.
 const effects = new Set<BashEffect>

 if (OPAQUE_PATTERNS.some((pattern) => pattern.test(command))) effects.add('opaque')
 if (CONTROL_CHARS.test(command)) effects.add('opaque')

 for (const { name, args } of parsed) {
 if (NETWORK_COMMANDS.has(name)) effects.add('network')
 if (name === 'rm' || name === 'rmdir' || name === 'shred') effects.add('destructive')
 if (name === 'find' && args.some((arg) => arg === '-exec' || arg === '-delete')) {
 effects.add('destructive')
 }
 if (SHELL_WRAPPERS.has(name)) effects.add('opaque')
 if (!READ_ONLY_COMMANDS.has(name) && name !== 'git') effects.add('unknown_command')
 if (name === 'git' && !READ_ONLY_GIT.has(args[0] ?? '')) effects.add('unknown_command')
 }

 if (hasParentTraversal(command)) effects.add('write_outside_workspace')

 if (effects.size === 0) return { kind: 'safe' }
 return { kind: 'gate', effects: [...effects].sort }
}

/** One line for the approval card, so a human sees the effect and not only the argv. */
export const describeBashEffects = (effects: readonly BashEffect[]): string => {
 const names: Record<BashEffect, string> = {
 network: 'reaches the network',
 write_outside_workspace: 'may write outside the workspace',
 privilege: 'escalates privilege',
 destructive: 'deletes files',
 credential_read: 'reads credentials',
 vcs_publish: 'publishes to a remote',
 opaque: 'contains shell constructs that cannot be analyzed',
 unknown_command: 'runs a command with unknown effects',
 }
 return effects.map((effect) => names[effect]).join('; ')
}
