import { afterEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { StorageUnavailable } from '@/lib/db/postgres'
import { CALL_DURATION_SECS, SessionCalls } from '@/lib/session/calls'
import { SessionStore } from '@/lib/session/store'
import { makeDecision } from '../../fixtures'

function setup() {
  const store = new SessionStore()
  const session = store.createSession({ repoUrl: 'https://github.com/example/repository' })
  return { store, session, calls: new SessionCalls(undefined, store) }
}

afterEach(() => vi.restoreAllMocks())

describe('Session calls', () => {
  it('permits only one active call, including concurrent start requests', async () => {
    const { store, session, calls } = setup()
    const results = await Promise.allSettled([calls.start(session.id), calls.start(session.id)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
      name: 'SessionCallError',
      status: 409,
      message: 'A voice call is already active',
    })
    expect(store.getSession(session.id)).toMatchObject({ callState: 'active', status: 'active' })
  })

  it('reports missing Sessions and the five-start quota without changing Session state', async () => {
    const { store, session, calls } = setup()
    await expect(calls.start('missing')).rejects.toMatchObject({
      name: 'SessionCallError',
      status: 404,
      message: 'Session not found',
    })
    for (let index = 0; index < 5; index++) {
      const call = await calls.start(session.id)
      await calls.end(session.id, call.id, true)
    }
    const before = store.getSnapshot(session.id)
    await expect(calls.start(session.id)).rejects.toMatchObject({
      name: 'SessionCallError',
      status: 429,
      message: 'Call start limit reached. Retry after 15 minutes.',
    })
    expect(store.getSnapshot(session.id)).toEqual(before)

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15 * 60 * 1000 + 1)
    await expect(calls.start(session.id)).resolves.toMatchObject({ status: 'active' })
  })

  it('abandons a missing transcript once and rejects later callbacks or normal end requests', async () => {
    const { store, session, calls } = setup()
    const call = await calls.start(session.id)
    await calls.end(session.id, call.id)
    expect((await calls.get(call.id))?.status).toBe('awaiting_transcript')

    await calls.end(session.id, call.id, true)
    expect(store.getSession(session.id)?.callState).toBe('failed')
    const before = store.getSnapshot(session.id)
    const events = store.readEvents(session.id, '0')
    await calls.end(session.id, call.id, true)
    await calls.end(session.id, call.id)
    expect(
      await calls.complete({
        sessionId: session.id,
        callId: call.id,
        conversationId: 'abandoned',
        transcript: 'Too late',
        callDurationSecs: 25,
      })
    ).toBe(false)
    expect(await calls.get(call.id)).toMatchObject({ status: 'failed' })
    expect(store.getSnapshot(session.id)).toEqual(before)
    expect(store.readEvents(session.id, '0')).toEqual(events)
  })

  it('abandons an old awaiting call without affecting a newer active call', async () => {
    const { store, session, calls } = setup()
    const first = await calls.start(session.id)
    await calls.end(session.id, first.id)
    const second = await calls.start(session.id)
    const before = store.getSnapshot(session.id)
    const other = store.createSession()
    await calls.end(other.id, first.id, true)
    expect((await calls.get(first.id))?.status).toBe('awaiting_transcript')
    await calls.end(session.id, first.id, true)
    expect((await calls.get(first.id))?.status).toBe('failed')
    expect((await calls.get(second.id))?.status).toBe('active')
    expect(
      await calls.complete({
        sessionId: session.id,
        callId: first.id,
        conversationId: 'abandoned-before-new-call',
        transcript: 'Too late',
        callDurationSecs: 20,
      })
    ).toBe(false)
    expect(store.getSnapshot(session.id)).toEqual(before)
  })

  it('hides PostgreSQL connection details when reading a call fails', async () => {
    const pool = new Pool()
    vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('private connection details'))
    try {
      await expect(new SessionCalls(pool).get('missing')).rejects.toEqual(new StorageUnavailable())
    } finally {
      await pool.end()
    }
  })

  it('retains a late transcript for call A without closing or overwriting newer call B', async () => {
    const { store, session, calls } = setup()
    const first = await calls.start(session.id)
    await calls.end(session.id, first.id)
    const second = await calls.start(session.id)
    const before = store.getSnapshot(session.id)

    expect(
      await calls.complete({
        sessionId: session.id,
        callId: first.id,
        conversationId: 'conversation-a',
        transcript: 'Earlier conversation',
        callDurationSecs: 31,
      })
    ).toBe(true)
    expect(store.getSnapshot(session.id)).toEqual(before)
    expect(store.getSession(session.id)).toMatchObject({
      currentCallId: second.id,
      callState: 'active',
      transcript: null,
      callDurationSecs: null,
    })
    expect(await calls.get(first.id)).toMatchObject({ status: 'complete', transcript: 'Earlier conversation' })

    await calls.end(session.id, first.id)
    expect(store.getSession(session.id)?.callState).toBe('active')
    expect(
      await calls.complete({
        sessionId: session.id,
        callId: second.id,
        conversationId: 'conversation-b',
        transcript: 'Current conversation',
        callDurationSecs: 42,
      })
    ).toBe(true)
    expect(store.getSession(session.id)).toMatchObject({
      currentCallId: second.id,
      callState: 'complete',
      transcript: 'Current conversation',
      callDurationSecs: 42,
    })
  })

  it('does not replace B when its transcript arrives before the delayed transcript for A', async () => {
    const { store, session, calls } = setup()
    const first = await calls.start(session.id)
    await calls.end(session.id, first.id)
    const second = await calls.start(session.id)
    await calls.complete({
      sessionId: session.id,
      callId: second.id,
      conversationId: 'newer',
      transcript: 'Newer transcript',
      callDurationSecs: 21,
    })
    const before = store.getSnapshot(session.id)
    await calls.complete({
      sessionId: session.id,
      callId: first.id,
      conversationId: 'older',
      transcript: 'Older transcript',
      callDurationSecs: 99,
    })
    expect(store.getSnapshot(session.id)).toEqual(before)
    expect(await calls.get(first.id)).toMatchObject({ transcript: 'Older transcript' })
  })

  it('rejects every stale tool mutation at the Session store boundary', async () => {
    const { store, session, calls } = setup()
    const first = await calls.start(session.id)
    await calls.end(session.id, first.id)
    const second = await calls.start(session.id)
    const before = store.getSnapshot(session.id)
    const timestamp = new Date().toISOString()

    expect(() => store.addDecision(session.id, makeDecision('Stale decision'), first.id)).toThrow('no longer active')
    expect(() =>
      store.recordFileRead(session.id, { path: 'src/app.ts', timestamp, characterCount: 50 }, first.id)
    ).toThrow('no longer active')
    expect(() =>
      store.flagQuestion(session.id, { id: 'question', question: 'Stale?', context: '', timestamp }, first.id)
    ).toThrow('no longer active')
    expect(() => store.setSpec(session.id, 'Stale spec', first.id)).toThrow('no longer active')
    expect(store.getSnapshot(session.id)).toEqual(before)

    store.addDecision(session.id, makeDecision('Current decision'), second.id)
    store.setSpec(session.id, 'Current spec', second.id)
    expect(store.getSession(session.id)).toMatchObject({
      specOutput: 'Current spec',
      decisions: [expect.objectContaining({ summary: 'Current decision' })],
    })
  })

  it('completes once without duplicate events or transcript replacement', async () => {
    const { store, session, calls } = setup()
    const call = await calls.start(session.id)
    const completion = {
      sessionId: session.id,
      callId: call.id,
      conversationId: 'complete-once',
      transcript: 'Accepted',
      callDurationSecs: 15,
    }
    expect(await calls.complete(completion)).toBe(true)
    const before = store.getSnapshot(session.id)
    expect(await calls.complete({ ...completion, transcript: 'Replacement' })).toBe(false)
    expect(store.getSnapshot(session.id)).toEqual(before)
    expect(store.readEvents(session.id, '0').filter(record => record.event.type === 'call_ended')).toHaveLength(1)
    expect(await calls.get(call.id)).toMatchObject({ transcript: 'Accepted' })
  })

  it('allows legacy completion only before any correlated call exists', async () => {
    const { store, session, calls } = setup()
    const legacy = {
      sessionId: session.id,
      conversationId: 'legacy',
      transcript: 'Legacy transcript',
      callDurationSecs: 4,
    }
    expect(await calls.complete(legacy)).toBe(true)
    await calls.start(session.id)
    const before = store.getSnapshot(session.id)
    expect(await calls.complete({ ...legacy, transcript: 'Uncorrelated late callback' })).toBe(false)
    expect(store.getSnapshot(session.id)).toEqual(before)
  })

  it('refuses to reuse a provider conversation for a different call', async () => {
    const { store, session, calls } = setup()
    const first = await calls.start(session.id)
    await calls.complete({
      sessionId: session.id,
      callId: first.id,
      conversationId: 'shared-conversation',
      transcript: 'First',
      callDurationSecs: 10,
    })
    const second = await calls.start(session.id)
    const before = store.getSnapshot(session.id)
    await expect(
      calls.complete({
        sessionId: session.id,
        callId: second.id,
        conversationId: 'shared-conversation',
        transcript: 'Forged second',
        callDurationSecs: 99,
      })
    ).rejects.toThrow('another call')
    expect(store.getSnapshot(session.id)).toEqual(before)
    expect(await calls.get(second.id)).toMatchObject({ status: 'active' })
  })

  it('expires tool access and allows a replacement call at the deadline', async () => {
    const { store, session, calls } = setup()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const first = await calls.start(session.id)
    expect(Date.parse(first.expiresAt)).toBe(now + CALL_DURATION_SECS * 1000)
    clock.mockReturnValue(Date.parse(first.expiresAt) - 1)
    expect(() => store.assertCall(session.id, first.id)).not.toThrow()
    await expect(calls.start(session.id)).rejects.toThrow('already active')
    clock.mockReturnValue(Date.parse(first.expiresAt))
    expect(() => store.setSpec(session.id, 'Expired spec', first.id)).toThrow('no longer active')
    const second = await calls.start(session.id)
    expect(second.id).not.toBe(first.id)
    expect(store.getSession(session.id)?.currentCallId).toBe(second.id)
  })

  it('rejects completion for another Session and for failed calls', async () => {
    const { store, session, calls } = setup()
    const call = await calls.start(session.id)
    const other = store.createSession()
    const completion = {
      sessionId: other.id,
      callId: call.id,
      conversationId: 'wrong-session',
      transcript: 'Wrong target',
      callDurationSecs: 10,
    }
    expect(await calls.complete(completion)).toBe(false)
    expect(store.getSession(other.id)?.transcript).toBeNull()
    await calls.end(session.id, call.id, true)
    expect(await calls.complete({ ...completion, sessionId: session.id })).toBe(false)
    expect(store.getSession(session.id)).toMatchObject({ callState: 'failed', transcript: null })
  })
})
