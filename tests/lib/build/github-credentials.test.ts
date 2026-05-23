import { describe, it, expect } from 'vitest'
import { injectTokenIntoUrl } from '@/lib/build/clone'

describe('injectTokenIntoUrl', () => {
  it('prepends oauth2 credentials when a token is provided', () => {
    const url = injectTokenIntoUrl('https://github.com/owner/repo', 'ghp_secret')
    expect(url).toBe('https://oauth2:ghp_secret@github.com/owner/repo')
  })

  it('returns the original URL when token is undefined', () => {
    const url = injectTokenIntoUrl('https://github.com/owner/repo', undefined)
    expect(url).toBe('https://github.com/owner/repo')
  })

  it('returns the original URL when token is an empty string', () => {
    const url = injectTokenIntoUrl('https://github.com/owner/repo', '')
    expect(url).toBe('https://github.com/owner/repo')
  })

  it('handles SSH-style URLs without modification (no https:// prefix)', () => {
    const url = injectTokenIntoUrl('git@github.com:owner/repo.git', 'ghp_secret')
    // SSH URLs cannot accept token injection — returned as-is
    expect(url).toBe('git@github.com:owner/repo.git')
  })
})
