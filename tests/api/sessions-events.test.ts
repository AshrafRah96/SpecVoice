import { afterEach, describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/sessions/[id]/events/route'
import { sessionStore } from '@/lib/session/store'
import { operatorHeaders } from '../helpers/operator'
import { getOperatorAuth, OPERATOR_COOKIE } from '@/lib/security/operator'
import { TEST_OPERATOR_PASSPHRASE } from '../helpers/operator-fixture'

function makeRequest(id: string, signal?: AbortSignal): NextRequest {
  return new NextRequest(`http://localhost/api/sessions/${id}/events`, {
    signal,
    headers: { ...operatorHeaders() },
  })
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
  it('closes an existing stream when its login is revoked', async () => {
    const auth = getOperatorAuth()
    const { token } = await auth.login(TEST_OPERATOR_PASSPHRASE)
    vi.useFakeTimers()
    const session = sessionStore.createSession()
    const request = new NextRequest(`http://localhost/api/sessions/${session.id}/events`, {
      headers: { Cookie: `${OPERATOR_COOKIE}=${token}` },
    })
    const response = await GET(request, { params: Promise.resolve({ id: session.id }) })
    const reader = response.body!.getReader()
    await readChunk(reader)
    await auth.logout(token)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(vi.getTimerCount()).toBe(0)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('returns 404 for unknown session', async () => {
    const controller = new AbortController()
    const res = await GET(makeRequest('no-such', controller.signal), {
      params: Promise.resolve({ id: 'no-such' }),
    })
    controller.abort()
    expect(res.status).toBe(404)
  })

  it('sends initial session snapshot immediately as session_updated', async () => {
    const session = sessionStore.createSession()
    const controller = new AbortController()
    const res = await GET(makeRequest(session.id, controller.signal), {
      params: Promise.resolve({ id: session.id }),
    })

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
    const res = await GET(makeRequest(session.id, controller.signal), {
      params: Promise.resolve({ id: session.id }),
    })

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
    const res = await GET(makeRequest(session.id, controller.signal), {
      params: Promise.resolve({ id: session.id }),
    })

    const reader = res.body!.getReader()
    // Consume initial snapshot so the reader is past the first write
    await readChunk(reader)

    controller.abort()

    const { done } = await reader.read()
    expect(done).toBe(true)
  })

  it('replays events after Last-Event-ID', async () => {
    const session = sessionStore.createSession()
    const cursor = sessionStore.getSnapshot(session.id).cursor
    sessionStore.broadcastEvent(session.id, { type: 'build_started', sessionId: session.id })
    const controller = new AbortController()
    const request = new NextRequest(`http://localhost/api/sessions/${session.id}/events`, {
      headers: {
        ...operatorHeaders(),
        'Last-Event-ID': cursor,
      },
      signal: controller.signal,
    })
    const res = await GET(request, { params: Promise.resolve({ id: session.id }) })
    const reader = res.body!.getReader()
    const event = parseEvent(await readChunk(reader)) as { type: string }
    expect(event.type).toBe('build_started')
    controller.abort()
    reader.cancel()
  })

  it('drains replay across multiple pages without another notification', async () => {
    const session = sessionStore.createSession()
    const cursor = sessionStore.getSnapshot(session.id).cursor
    for (let index = 0; index < 205; index++) {
      sessionStore.broadcastEvent(session.id, { type: 'build_progress', phase: 'writing', detail: String(index) })
    }
    const controller = new AbortController()
    const request = makeRequest(session.id, controller.signal)
    request.headers.set('Last-Event-ID', cursor)
    const response = await GET(request, { params: Promise.resolve({ id: session.id }) })
    const reader = response.body!.getReader()
    let previous = BigInt(cursor)
    try {
      for (let index = 0; index < 205; index++) {
        const chunk = await readChunk(reader)
        const eventId = BigInt(chunk.split('\n')[0].slice('id: '.length))
        expect(eventId).toBeGreaterThan(previous)
        expect(parseEvent(chunk)).toEqual({ type: 'build_progress', phase: 'writing', detail: String(index) })
        previous = eventId
      }
    } finally {
      controller.abort()
      await reader.cancel()
    }
  })

  it('polls for events when the notification is lost', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    vi.spyOn(sessionStore, 'watch').mockReturnValue(unsubscribe)
    const session = sessionStore.createSession()
    const controller = new AbortController()
    const response = await GET(makeRequest(session.id, controller.signal), {
      params: Promise.resolve({ id: session.id }),
    })
    const reader = response.body!.getReader()
    try {
      await readChunk(reader)
      await vi.advanceTimersByTimeAsync(0)
      sessionStore.broadcastEvent(session.id, { type: 'build_started', sessionId: session.id })
      await vi.advanceTimersByTimeAsync(1000)
      expect(parseEvent(await readChunk(reader))).toEqual({ type: 'build_started', sessionId: session.id })
    } finally {
      controller.abort()
      await reader.cancel()
    }
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rechecks a notification received while an empty replay page is being read', async () => {
    vi.useFakeTimers()
    const session = sessionStore.createSession()
    vi.spyOn(sessionStore, 'readEvents').mockImplementationOnce(() => {
      sessionStore.broadcastEvent(session.id, { type: 'build_started', sessionId: session.id })
      // Simulate the in-flight query returning the state from before the notification.
      return []
    })
    const controller = new AbortController()
    const response = await GET(makeRequest(session.id, controller.signal), {
      params: Promise.resolve({ id: session.id }),
    })
    const reader = response.body!.getReader()
    try {
      await readChunk(reader)
      expect(parseEvent(await readChunk(reader))).toEqual({ type: 'build_started', sessionId: session.id })
    } finally {
      controller.abort()
      await reader.cancel()
    }
  })

  it('cleans subscriptions and polling when the consumer cancels a blocked initial write', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    vi.spyOn(sessionStore, 'watch').mockReturnValue(unsubscribe)
    const session = sessionStore.createSession()
    const response = await GET(makeRequest(session.id), { params: Promise.resolve({ id: session.id }) })
    await response.body!.cancel()
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes and cleans up after a replay read failure', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    vi.spyOn(sessionStore, 'watch').mockReturnValue(unsubscribe)
    vi.spyOn(sessionStore, 'readEvents').mockImplementationOnce(() => {
      throw new Error('database unavailable')
    })
    const session = sessionStore.createSession()
    const response = await GET(makeRequest(session.id), { params: Promise.resolve({ id: session.id }) })
    const reader = response.body!.getReader()
    await readChunk(reader)
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
