import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/sessions/[id]/build/route'
import { sessionStore } from '@/lib/session/store'
import type { SessionEvent, ComplexityAssessment } from '@/lib/session/types'

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

  it('fires build_blocked and resets buildStatus to ready when open questions exist', async () => {
    const session = sessionStore.createSession({
      specOutput: '# Spec content',
      openQuestions: [
        { id: 'q1', question: 'Migrate?', context: 'context', timestamp: new Date().toISOString() },
      ],
    })

    // Collect all events fired synchronously during the POST call
    const events: SessionEvent[] = []
    const unsub = sessionStore.subscribe(session.id, e => events.push(e))

    const res = await POST(makeRequest(session.id), { params: { id: session.id } })
    unsub()

    expect(res.status).toBe(202)

    const types = events.map(e => e.type)
    expect(types).toContain('build_started')
    expect(types).toContain('build_blocked')

    const blocked = events.find(e => e.type === 'build_blocked') as Extract<SessionEvent, { type: 'build_blocked' }>
    expect(blocked.assessment.blocked).toBe(true)
    expect(blocked.assessment.blockReason).toBe('open_questions')
    expect(blocked.assessment.openQuestionCount).toBe(1)

    // buildStatus must reset to 'ready' so the "Build it" button stays visible
    const updated = sessionStore.getSession(session.id)!
    expect(updated.buildStatus).toBe('ready')
  })
})
