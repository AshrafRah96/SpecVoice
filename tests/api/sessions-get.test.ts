import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { GET as getSession } from '@/app/api/sessions/[id]/route'
import { GET as getSpec } from '@/app/api/sessions/[id]/spec/route'
import { sessionStore } from '@/lib/session/store'

function makeRequest(url: string): NextRequest {
  return new NextRequest(url)
}

describe('GET /api/sessions/[id]', () => {
  it('returns 404 for unknown session', async () => {
    const res = await getSession(makeRequest('http://localhost/api/sessions/no-such'), {
      params: Promise.resolve({ id: 'no-such' }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('no-such')
  })

  it('returns 200 with { session } for a known session', async () => {
    const session = sessionStore.createSession({ repoUrl: 'https://github.com/owner/repo' })
    const res = await getSession(makeRequest(`http://localhost/api/sessions/${session.id}`), {
      params: Promise.resolve({ id: session.id }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.session).toBeDefined()
    expect(body.session.id).toBe(session.id)
  })
})

describe('GET /api/sessions/[id]/spec', () => {
  it('returns 404 for unknown session', async () => {
    const res = await getSpec(makeRequest('http://localhost/api/sessions/no-such/spec'), {
      params: Promise.resolve({ id: 'no-such' }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('no-such')
  })

  it('returns 404 when session exists but spec not yet generated', async () => {
    const session = sessionStore.createSession()
    const res = await getSpec(makeRequest(`http://localhost/api/sessions/${session.id}/spec`), {
      params: Promise.resolve({ id: session.id }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('generate-spec')
  })

  it('returns 200 with { spec } when specOutput is present', async () => {
    const session = sessionStore.createSession({ specOutput: '# My Spec\n\n- step 1' })
    const res = await getSpec(makeRequest(`http://localhost/api/sessions/${session.id}/spec`), {
      params: Promise.resolve({ id: session.id }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.spec).toBe('# My Spec\n\n- step 1')
  })
})
