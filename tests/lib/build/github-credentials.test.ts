import { describe, it, expect } from 'vitest'
import { buildCloneArgs } from '@/lib/build/clone'

describe('git clone credential boundary', () => {
  it('keeps credentials out of clone arguments', () => {
    const args = buildCloneArgs('https://github.com/owner/repo', '/tmp/clone')
    expect(args).not.toContain('ghp_secret')
    expect(args).toEqual(['clone', '--depth', '1', 'https://github.com/owner/repo', '/tmp/clone'])
  })

  it('supports SSH URLs without credential rewriting', () => {
    const args = buildCloneArgs('git@github.com:owner/repo.git', '/tmp/clone')
    // SSH URLs pass through unchanged; authentication stays outside argv.
    expect(args[3]).toBe('git@github.com:owner/repo.git')
  })
})
