import { describe, expect, it } from 'vitest'
import { classifyPushEffect } from './push-policy.js'

describe('classifyPushEffect', () => {
  it('allows a push that touches no CI config', () => {
    expect(classifyPushEffect(['src/index.ts', 'README.md'], false)).toEqual({ ok: true })
  })

  it('denies a push touching .github/workflows', () => {
    const result = classifyPushEffect(['.github/workflows/ci.yml'], false)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/CI config/)
  })

  it('denies a push touching .gitlab-ci.yml', () => {
    expect(classifyPushEffect(['.gitlab-ci.yml'], false).ok).toBe(false)
  })

  it('denies a push touching .circleci config', () => {
    expect(classifyPushEffect(['.circleci/config.yml'], false).ok).toBe(false)
  })

  it('allows a CI-touching push once acknowledgeCiChange is true', () => {
    expect(classifyPushEffect(['.github/workflows/ci.yml'], true)).toEqual({ ok: true })
  })

  it('allows an empty changeset', () => {
    expect(classifyPushEffect([], false)).toEqual({ ok: true })
  })
})
