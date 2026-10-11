import { describe, it, expect, afterEach, vi } from 'vitest'
import { POST } from '@/app/api/sessions/route'
import { NextRequest } from 'next/server'

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost:3000/api/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('POST /api/sessions', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('accepts repoUrl (camelCase) and returns 201 with session', async () => {
    const res = await POST(makeRequest({ repoUrl: 'https://github.com/test/repo' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.session.repoUrl).toBe('https://github.com/test/repo')
    expect(body.session.buildStatus).toBe('idle')
    expect(body.session.status).toBe('active')
    expect(body.session.decisions).toEqual([])
  })

  it('rejects a request with neither repoUrl nor repoLocalPath', async () => {
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(400)
  })

  it('rejects requests that provide both repository sources', async () => {
    const res = await POST(makeRequest({ repoUrl: 'https://github.com/test/repo', repoLocalPath: '/tmp/my-repo' }))
    expect(res.status).toBe(400)
  })

  it('rejects local paths outside the configured repository root', async () => {
    vi.stubEnv('SPECVOICE_LOCAL_REPO_ROOT', '/tmp/allowed')
    const res = await POST(makeRequest({ repoLocalPath: '/tmp/other-repo' }))
    expect(res.status).toBe(400)
  })

  it('requires explicit opt-in for the in-memory store in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SPECVOICE_ALLOW_IN_MEMORY_SESSIONS', 'false')
    const res = await POST(makeRequest({ repoUrl: 'https://github.com/test/repo' }))
    expect(res.status).toBe(503)
  })

  it('accepts repoLocalPath as an alternative to repoUrl', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('SPECVOICE_LOCAL_REPO_ROOT', '/tmp')
    const res = await POST(makeRequest({ repoLocalPath: '/tmp/my-repo' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.session.repoLocalPath).toBe('/tmp/my-repo')
  })
})
