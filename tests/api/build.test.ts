import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/sessions/[id]/build/route'
import { sessionStore } from '@/lib/session/store'

function makeRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/sessions/${id}/build`, { method: 'POST' })
}

describe('POST /api/sessions/[id]/build', () => {
  it('returns 404 for unknown session', async () => {
    const res = await POST(makeRequest('no-such-session'), { params: { id: 'no-such-session' } })
    expect(res.status).toBe(404)
  })

  it('returns 400 when session has no specOutput', async () => {
    const session = sessionStore.createSession()
    // specOutput is undefined by default — build must be refused
    const res = await POST(makeRequest(session.id), { params: { id: session.id } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'No spec to build from.' })
  })

  it('returns 409 when build already in progress', async () => {
    const session = sessionStore.createSession({ specOutput: '# Spec\n- step 1' })
    sessionStore.setBuildStatus(session.id, 'building')
    const res = await POST(makeRequest(session.id), { params: { id: session.id } })
    expect(res.status).toBe(409)
  })

  it('returns 202 and accepts build when session has a spec', async () => {
    const session = sessionStore.createSession({ specOutput: '# Spec\n- step 1' })
    const res = await POST(makeRequest(session.id), { params: { id: session.id } })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ accepted: true })
  })
})
