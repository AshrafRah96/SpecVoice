import { describe, expect, it } from 'vitest'
import { allowedHost } from '@/lib/security/egress'

describe('worker egress allowlist', () => {
  it('allows configured domains and their subdomains', () => {
    expect(allowedHost('api.github.com', ['github.com'])).toBe(true)
    expect(allowedHost('codeload.github.com', ['github.com'])).toBe(true)
  })

  it('rejects unconfigured domains', () => {
    expect(allowedHost('example.com', ['github.com', 'api.anthropic.com'])).toBe(false)
  })
})
