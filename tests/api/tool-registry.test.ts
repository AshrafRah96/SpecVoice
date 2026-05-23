import { describe, it, expect, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { toolRegistry } from '@/lib/api/tool-registry'
import { InMemoryCodeSource, registerCodeSource } from '@/lib/code/index'

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/tools/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── unknown tools ──────────────────────────────────────────────────────────────

describe('toolRegistry.dispatch — unknown tool', () => {
  it('returns 404 for a tool name not in the registry', async () => {
    const session = sessionStore.createSession()
    const res = await toolRegistry.dispatch('no-such-tool', makeRequest({ session_id: session.id }))
    expect(res.status).toBe(404)
  })
})

// ── session mutations ──────────────────────────────────────────────────────────

describe('toolRegistry.dispatch — save-decision', () => {
  it('stores a decision and returns it', async () => {
    const session = sessionStore.createSession()
    const res = await toolRegistry.dispatch('save-decision', makeRequest({
      session_id: session.id,
      summary: 'Use Postgres',
      rationale: 'ACID transactions',
    }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.decision.summary).toBe('Use Postgres')
    expect(sessionStore.getSession(session.id)!.decisions).toHaveLength(1)
  })

  it('returns 400 when summary is missing', async () => {
    const session = sessionStore.createSession()
    const res = await toolRegistry.dispatch('save-decision', makeRequest({
      session_id: session.id,
      rationale: 'r',
    }))
    expect(res.status).toBe(400)
  })
})

describe('toolRegistry.dispatch — flag-question', () => {
  it('stores a question and returns it', async () => {
    const session = sessionStore.createSession()
    const res = await toolRegistry.dispatch('flag-question', makeRequest({
      session_id: session.id,
      question: 'Should we use Redis?',
    }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.question.question).toBe('Should we use Redis?')
    expect(sessionStore.getSession(session.id)!.openQuestions).toHaveLength(1)
  })

  it('defaults context to empty string when omitted', async () => {
    const session = sessionStore.createSession()
    await toolRegistry.dispatch('flag-question', makeRequest({
      session_id: session.id,
      question: 'What auth?',
    }))
    expect(sessionStore.getSession(session.id)!.openQuestions[0].context).toBe('')
  })
})

describe('toolRegistry.dispatch — generate-spec', () => {
  it('generates and stores spec, sets buildStatus to ready', async () => {
    const session = sessionStore.createSession({
      decisions: [{
        id: 'd-1',
        summary: 'Add rate limiting',
        rationale: 'Prevent abuse',
        alternativesConsidered: [],
        relevantFiles: [],
        timestamp: new Date().toISOString(),
      }],
    })
    const res = await toolRegistry.dispatch('generate-spec', makeRequest({ session_id: session.id }))
    expect(res.status).toBe(200)
    const updated = sessionStore.getSession(session.id)!
    expect(updated.specOutput).toBeDefined()
    expect(updated.buildStatus).toBe('ready')
    expect(updated.status).toBe('complete')
  })
})

// ── code tools ─────────────────────────────────────────────────────────────────

describe('toolRegistry.dispatch — list-files', () => {
  let deregister: (() => void) | undefined
  afterEach(() => { deregister?.(); deregister = undefined })

  it('returns files from the code source', async () => {
    const session = sessionStore.createSession()
    deregister = registerCodeSource(session.id, new InMemoryCodeSource({ 'src/a.ts': 'hello' }))
    const res = await toolRegistry.dispatch('list-files', makeRequest({ session_id: session.id }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.files)).toBe(true)
    expect(data.files.some((f: { path: string }) => f.path === 'src/a.ts')).toBe(true)
  })
})

describe('toolRegistry.dispatch — read-file', () => {
  let deregister: (() => void) | undefined
  afterEach(() => { deregister?.(); deregister = undefined })

  it('returns file content and records the read', async () => {
    const session = sessionStore.createSession()
    deregister = registerCodeSource(session.id, new InMemoryCodeSource({ 'src/a.ts': 'export const x = 1' }))
    const res = await toolRegistry.dispatch('read-file', makeRequest({
      session_id: session.id,
      path: 'src/a.ts',
    }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.content.content).toContain('export const x = 1')
    expect(sessionStore.getSession(session.id)!.filesRead).toHaveLength(1)
  })
})

describe('toolRegistry.dispatch — search-code', () => {
  let deregister: (() => void) | undefined
  afterEach(() => { deregister?.(); deregister = undefined })

  it('returns matching search results', async () => {
    const session = sessionStore.createSession()
    deregister = registerCodeSource(session.id, new InMemoryCodeSource({ 'src/a.ts': 'export const hello = 1' }))
    const res = await toolRegistry.dispatch('search-code', makeRequest({
      session_id: session.id,
      query: 'hello',
    }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data.results)).toBe(true)
  })
})
