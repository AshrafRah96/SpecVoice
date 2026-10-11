import { describe, expect, it } from 'vitest'
import { issueSessionCapability, verifySessionCapability } from '@/lib/session/capability'

describe('session capability', () => {
  it('round-trips for the session it was issued to', () => {
    const now = Date.now()
    const token = issueSessionCapability('session-1', now)
    expect(verifySessionCapability(token, 'session-1', now + 1)).toBe(true)
    expect(verifySessionCapability(token, 'session-2', now + 1)).toBe(false)
  })

  it('rejects tampering and expiry', () => {
    const now = Date.now()
    const token = issueSessionCapability('session-1', now)
    const [payload, signature] = token.split('.')
    expect(verifySessionCapability(`${payload}x.${signature}`, 'session-1', now + 1)).toBe(false)
    expect(verifySessionCapability(token, 'session-1', now + 60 * 60 * 1000 + 1)).toBe(false)
  })
})
