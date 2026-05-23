import { describe, it, expect } from 'vitest'
import os from 'os'
import { resolveCodeSource } from '@/lib/code/index'
import { makeSession } from '../fixtures'

describe('resolveCodeSource', () => {
  it('returns a fresh instance on each call — no stale cache', () => {
    const session = makeSession()
    const a = resolveCodeSource(session)
    const b = resolveCodeSource(session)
    expect(a).not.toBe(b)
  })

  it('returns a GitHubCodeSource when session has repoUrl', () => {
    const session = makeSession({ repoUrl: 'https://github.com/owner/repo' })
    const source = resolveCodeSource(session)
    expect(source.constructor.name).toBe('GitHubCodeSource')
  })

  it('returns a LocalCodeSource when session has repoLocalPath and no repoUrl', () => {
    const session = makeSession({ repoUrl: undefined, repoLocalPath: os.tmpdir() })
    const source = resolveCodeSource(session)
    expect(source.constructor.name).toBe('LocalCodeSource')
  })

  it('throws when session has neither repoUrl nor repoLocalPath', () => {
    const session = makeSession({ repoUrl: undefined, repoLocalPath: undefined })
    expect(() => resolveCodeSource(session)).toThrow('no code source configured')
  })
})
