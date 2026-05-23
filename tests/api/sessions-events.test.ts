import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/sessions/[id]/events/route'
import { sessionStore } from '@/lib/session/store'

function makeRequest(id: string, signal?: AbortSignal): NextRequest {
  return new NextRequest(`http://localhost/api/sessions/${id}/events`, { signal })
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read()
  return new TextDecoder().decode(value)
}

function parseEvent(raw: string): unknown {
  const line = raw.split('\n').find(l => l.startsWith('data: '))
  if (!line) throw new Error(`No data line in SSE chunk: ${JSON.stringify(raw)}`)
  return JSON.parse(line.slice('data: '.length))
}

describe('GET /api/sessions/[id]/events', () => {
  it('returns 404 for unknown session', async () => {
    const controller = new AbortController()
    const res = await GET(makeRequest('no-such', controller.signal), { params: Promise.resolve({ id: 'no-such' }) })
    controller.abort()
    expect(res.status).toBe(404)
  })

  it('sends initial session snapshot immediately as session_updated', async () => {
    const session = sessionStore.createSession()
    const controller = new AbortController()
    const res = await GET(makeRequest(session.id, controller.signal), { params: Promise.resolve({ id: session.id }) })

    expect(res.headers.get('Content-Type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const event = parseEvent(await readChunk(reader)) as { type: string; session: { id: string } }

    expect(event.type).toBe('session_updated')
    expect(event.session.id).toBe(session.id)

    controller.abort()
    reader.cancel()
  })

  it('forwards broadcasted events to the stream after the initial snapshot', async () => {
    const session = sessionStore.createSession()
    const controller = new AbortController()
    const res = await GET(makeRequest(session.id, controller.signal), { params: Promise.resolve({ id: session.id }) })

    const reader = res.body!.getReader()
    // Consume initial snapshot
    await readChunk(reader)

    // Emit a build_started event
    sessionStore.broadcastEvent(session.id, { type: 'build_started', sessionId: session.id })

    const event = parseEvent(await readChunk(reader)) as { type: string }
    expect(event.type).toBe('build_started')

    controller.abort()
    reader.cancel()
  })

  it('closes the stream and unsubscribes when the request is aborted', async () => {
    const session = sessionStore.createSession()
    const controller = new AbortController()
    const res = await GET(makeRequest(session.id, controller.signal), { params: Promise.resolve({ id: session.id }) })

    const reader = res.body!.getReader()
    // Consume initial snapshot so the reader is past the first write
    await readChunk(reader)

    controller.abort()

    const { done } = await reader.read()
    expect(done).toBe(true)
  })
})
