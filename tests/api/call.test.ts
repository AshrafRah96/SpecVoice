import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST, DELETE } from '@/app/api/sessions/[id]/call/route'
import { sessionStore } from '@/lib/session/store'
import { CALL_DURATION_SECS, getSessionCalls } from '@/lib/session/calls'
import { verifySessionCapability } from '@/lib/session/capability'
import { getRepositorySnapshotStore } from '@/lib/repo/snapshot-store'
import { profileRepository } from '@/lib/repo/profile'
import { InMemoryCodeSource } from '@/lib/code/in-memory-source'
import { toolRegistry } from '@/lib/api/tool-registry'
import { operatorHeaders } from '../helpers/operator'

const signedUrl = 'wss://voice.example.test/conversation?token=public-test-token'
const providerFetch = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('ELEVENLABS_AGENT_ID', 'private-test-agent')
  vi.stubEnv('ELEVENLABS_API_KEY', 'public-test-provider-key')
  vi.stubEnv('SPECVOICE_OPERATOR_ORIGIN', '')
  providerFetch.mockReset().mockImplementation(async () => Response.json({ signed_url: signedUrl }))
  vi.stubGlobal('fetch', providerFetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function setup(status: 'missing' | 'pending' | 'ready' | 'partial' | 'failed' = 'ready') {
  const session = sessionStore.createSession({ repositorySha: 'pinned' })
  if (status === 'missing') return session
  const snapshots = getRepositorySnapshotStore()
  const snapshot = await snapshots.ensureForSession(session, 'pinned')
  if (status !== 'pending') {
    const source = new InMemoryCodeSource({ 'src/index.ts': 'export const ready = true' }, 'pinned')
    const profile = await profileRepository(source, 'pinned')
    await snapshots.saveProfile(snapshot.id, { ...profile, indexStatus: status, treeComplete: status === 'ready' })
  }
  return session
}

function request(sessionId: string, method = 'POST', body?: unknown) {
  return new NextRequest(`http://localhost:3000/api/sessions/${sessionId}/call`, {
    method,
    headers: { ...operatorHeaders(), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const context = (id: string) => ({ params: Promise.resolve({ id }) })

function saveDecision(sessionId: string, capability: string, summary: string) {
  return toolRegistry.dispatch(
    'save-decision',
    new NextRequest('http://localhost:3000/api/tools/save-decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, session_token: capability, summary, rationale: 'Test rationale' }),
    })
  )
}

describe('private voice call route', () => {
  it('distinguishes an active call from the start quota and permits explicit lost-callback recovery', async () => {
    const session = await setup()
    for (let index = 0; index < 5; index++) {
      const response = await POST(request(session.id), context(session.id))
      expect(response.status).toBe(200)
      const { callId } = await response.json()
      expect((await POST(request(session.id), context(session.id))).status).toBe(409)
      await DELETE(request(session.id, 'DELETE', { callId }), context(session.id))
      expect(sessionStore.getSession(session.id)?.callState).toBe('awaiting_transcript')
      await DELETE(request(session.id, 'DELETE', { callId, failed: true }), context(session.id))
      expect(sessionStore.getSession(session.id)?.callState).toBe('failed')
    }
    expect((await POST(request(session.id), context(session.id))).status).toBe(429)
    expect(providerFetch).toHaveBeenCalledTimes(5)
  })

  it('uses the real provider SDK transport and issues a capability bound to the fresh call', async () => {
    const session = await setup()
    const response = await POST(request(session.id), context(session.id))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body).toMatchObject({ signedUrl, maxDurationSecs: CALL_DURATION_SECS })
    expect(verifySessionCapability(body.capability, session.id, Date.now(), body.callId)).toBe(true)
    expect(verifySessionCapability(body.capability, session.id, Date.now(), 'another-call')).toBe(false)
    expect(verifySessionCapability(body.capability, 'another-session', Date.now(), body.callId)).toBe(false)
    expect(await getSessionCalls().get(body.callId)).toMatchObject({
      id: body.callId,
      sessionId: session.id,
      status: 'active',
    })
    expect(sessionStore.getSession(session.id)).toMatchObject({ currentCallId: body.callId, callState: 'active' })
    expect(providerFetch).toHaveBeenCalledOnce()
    const upstream = new Request(...providerFetch.mock.calls[0])
    const url = new URL(upstream.url)
    expect(url.origin).toBe('https://api.elevenlabs.io')
    expect(url.pathname).toBe('/v1/convai/conversation/get-signed-url')
    expect(url.searchParams.get('agent_id')).toBe('private-test-agent')
    expect(url.searchParams.get('include_conversation_id')).toBe('true')
    expect(upstream.headers.get('xi-api-key')).toBe('public-test-provider-key')
    expect(JSON.stringify(body)).not.toContain('public-test-provider-key')
  })

  it.each(['missing', 'pending', 'failed'] as const)('blocks calls while the profile is %s', async status => {
    const session = await setup(status)
    expect((await POST(request(session.id), context(session.id))).status).toBe(409)
    expect(sessionStore.getSession(session.id)?.currentCallId).toBeUndefined()
    expect(providerFetch).not.toHaveBeenCalled()
  })

  it('permits bounded discovery with a partial profile before scope confirmation', async () => {
    const session = await setup('partial')
    expect((await POST(request(session.id), context(session.id))).status).toBe(200)
    expect((await getRepositorySnapshotStore().getForSession(session.id))?.scopePlan).toBeNull()
  })

  it('marks failed provider starts as failed without retrying or leaving an active call', async () => {
    providerFetch.mockResolvedValueOnce(Response.json({ detail: 'Unavailable' }, { status: 503 }))
    const session = await setup()
    const response = await POST(request(session.id), context(session.id))
    expect(response.status).toBe(502)
    const updated = sessionStore.getSession(session.id)!
    expect(updated.callState).toBe('failed')
    expect(await getSessionCalls().get(updated.currentCallId!)).toMatchObject({ status: 'failed' })
    expect(providerFetch).toHaveBeenCalledOnce()
    expect((await POST(request(session.id), context(session.id))).status).toBe(200)
  })

  it('rejects overlapping calls without fetching another signed URL', async () => {
    const session = await setup()
    const first = await (await POST(request(session.id), context(session.id))).json()
    expect((await POST(request(session.id), context(session.id))).status).toBe(409)
    expect(sessionStore.getSession(session.id)?.currentCallId).toBe(first.callId)
    expect(providerFetch).toHaveBeenCalledOnce()
  })

  it('ends only the specified call and cannot end another Session or a newer call', async () => {
    const session = await setup()
    const other = await setup()
    const first = await (await POST(request(session.id), context(session.id))).json()
    const otherCall = await (await POST(request(other.id), context(other.id))).json()
    await DELETE(request(session.id, 'DELETE', { callId: otherCall.callId }), context(session.id))
    expect((await getSessionCalls().get(first.callId))?.status).toBe('active')
    expect((await getSessionCalls().get(otherCall.callId))?.status).toBe('active')
    expect((await DELETE(request(session.id, 'DELETE', { callId: first.callId }), context(session.id))).status).toBe(
      200
    )
    expect((await getSessionCalls().get(first.callId))?.status).toBe('awaiting_transcript')
    const next = await (await POST(request(session.id), context(session.id))).json()
    await DELETE(request(session.id, 'DELETE', { callId: first.callId, failed: true }), context(session.id))
    expect(sessionStore.getSession(session.id)).toMatchObject({ currentCallId: next.callId, callState: 'active' })
    expect((await getSessionCalls().get(otherCall.callId))?.status).toBe('active')
  })

  it('issues fresh call credentials after ending a call and rejects old tool writes', async () => {
    const session = await setup()
    const first = await (await POST(request(session.id), context(session.id))).json()
    expect((await saveDecision(session.id, first.capability, 'First call decision')).status).toBe(200)
    await DELETE(request(session.id, 'DELETE', { callId: first.callId }), context(session.id))
    expect((await saveDecision(session.id, first.capability, 'After ending')).status).toBe(409)
    const next = await (await POST(request(session.id), context(session.id))).json()
    expect(next.callId).not.toBe(first.callId)
    expect(next.capability).not.toBe(first.capability)
    expect((await saveDecision(session.id, first.capability, 'Stale call write')).status).toBe(401)
    expect((await saveDecision(session.id, next.capability, 'Next call decision')).status).toBe(200)
    expect(sessionStore.getSession(session.id)?.decisions.map(decision => decision.summary)).toEqual([
      'First call decision',
      'Next call decision',
    ])
  })

  it.each(['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID'])('fails closed without %s', async name => {
    vi.stubEnv(name, '')
    const session = await setup()
    expect((await POST(request(session.id), context(session.id))).status).toBe(503)
    expect(sessionStore.getSession(session.id)?.currentCallId).toBeUndefined()
    expect(providerFetch).not.toHaveBeenCalled()
  })

  it('requires operator authentication before starting or ending calls', async () => {
    const session = await setup()
    const url = `http://localhost:3000/api/sessions/${session.id}/call`
    expect((await POST(new NextRequest(url, { method: 'POST' }), context(session.id))).status).toBe(401)
    expect((await DELETE(new NextRequest(url, { method: 'DELETE' }), context(session.id))).status).toBe(401)
    expect(providerFetch).not.toHaveBeenCalled()
  })
})
