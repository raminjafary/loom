import { describe, expect, it } from 'vitest'
import { applicationServerKey, toPushRegistration } from './push.js'

describe('applicationServerKey', () => {
  it('decodes a base64url key that standard base64 would reject', () => {
    // A real VAPID public key: 65 bytes, uncompressed P-256 point (leading 0x04),
    // base64url-encoded and unpadded — the shape `atob` cannot take directly.
    const key =
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
    const bytes = applicationServerKey(key)
    expect(bytes).toHaveLength(65)
    expect(bytes[0]).toBe(0x04)
  })

  it('rejects a key that is not base64url rather than passing garbage to the browser', () => {
    expect(() => applicationServerKey('not base64!!')).toThrow(/base64url/)
  })
})

describe('toPushRegistration', () => {
  it('extracts the endpoint and both encryption keys', () => {
    expect(
      toPushRegistration({
        endpoint: 'https://push.example/abc',
        keys: { p256dh: 'p', auth: 'a' },
      }),
    ).toEqual({ endpoint: 'https://push.example/abc', credentials: { p256dh: 'p', auth: 'a' } })
  })

  it('refuses a subscription missing a key, rather than storing a target that can never receive', () => {
    expect(() =>
      toPushRegistration({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p' } }),
    ).toThrow(/p256dh\/auth/)
    expect(() => toPushRegistration({ keys: { p256dh: 'p', auth: 'a' } })).toThrow(/endpoint/)
  })
})
