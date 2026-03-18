import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/agent/post-call/route'
import { sessionStore } from '@/lib/session/store'

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/agent/post-call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function validPayload(sessionId: string) {
  return {
    type: 'post_call_transcription',
    data: {
      metadata: { call_duration_secs: 42 },
      transcript: [{ role: 'agent', message: 'Hello there.', time_in_call_secs: 0 }],
      conversation_initiation_client_data: {
        dynamic_variables: { session_id: sessionId },
      },
    },
  }
}

describe('POST /api/agent/post-call', () => {
  it('valid payload updates session and returns received: true', async () => {
    const session = sessionStore.createSession()
    const req = makeRequest(validPayload(session.id))

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })

    const updated = sessionStore.getSession(session.id)!
    expect(updated.buildStatus).toBe('ready')
    expect(updated.callDurationSecs).toBe(42)
    expect(updated.transcript).toBe(
      JSON.stringify([{ role: 'agent', message: 'Hello there.', time_in_call_secs: 0 }])
    )
  })

  it('missing session_id returns 200 with ignored message and does not mutate store', async () => {
    const before = sessionStore.createSession()
    const req = makeRequest({
      type: 'post_call_transcription',
      data: {
        metadata: { call_duration_secs: 10 },
        transcript: [],
        conversation_initiation_client_data: { dynamic_variables: {} },
      },
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ignored: 'missing session_id' })
    // Unrelated session should be untouched
    expect(sessionStore.getSession(before.id)!.buildStatus).toBe('idle')
  })

  it('unknown session_id returns 200 with ignored message', async () => {
    const req = makeRequest(validPayload('nonexistent-00000000-0000-0000-0000-000000000000'))

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ignored: 'unknown session' })
  })
})
