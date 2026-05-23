import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { toolRegistry } from '@/lib/api/tool-registry'

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/tools/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── save-decision ─────────────────────────────────────────────────────────────

describe('POST /api/tools/save-decision', () => {
  it('creates a Decision and appends it to session.decisions', async () => {
    const session = sessionStore.createSession()
    const res = await toolRegistry.dispatch('save-decision', makeRequest({
      session_id: session.id,
      summary: 'Use Postgres for session storage',
      rationale: 'Supports ACID transactions',
      alternatives_considered: ['SQLite', 'MySQL'],
      relevant_files: ['src/lib/session/store.ts'],
    }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.decision.summary).toBe('Use Postgres for session storage')
    expect(data.decision.id).toMatch(/^[\w-]+$/)

    const updated = sessionStore.getSession(session.id)!
    expect(updated.decisions).toHaveLength(1)
    expect(updated.decisions[0].summary).toBe('Use Postgres for session storage')
    expect(updated.decisions[0].alternativesConsidered).toEqual(['SQLite', 'MySQL'])
    expect(updated.decisions[0].relevantFiles).toEqual(['src/lib/session/store.ts'])
  })

  it('accumulates multiple decisions', async () => {
    const session = sessionStore.createSession()
    const base = { session_id: session.id, rationale: 'r', alternatives_considered: [], relevant_files: [] }
    await toolRegistry.dispatch('save-decision', makeRequest({ ...base, summary: 'First' }))
    await toolRegistry.dispatch('save-decision', makeRequest({ ...base, summary: 'Second' }))
    expect(sessionStore.getSession(session.id)!.decisions).toHaveLength(2)
  })

  it('returns 400 when summary is missing', async () => {
    const session = sessionStore.createSession()
    const res = await toolRegistry.dispatch('save-decision', makeRequest({
      session_id: session.id,
      rationale: 'r',
    }))
    expect(res.status).toBe(400)
  })

  it('defaults alternatives_considered and relevant_files to empty arrays', async () => {
    const session = sessionStore.createSession()
    const res = await toolRegistry.dispatch('save-decision', makeRequest({
      session_id: session.id,
      summary: 'A decision',
      rationale: 'Good reason',
    }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.decision.alternativesConsidered).toEqual([])
    expect(data.decision.relevantFiles).toEqual([])
  })
})

// ── flag-question ──────────────────────────────────────────────────────────────

describe('POST /api/tools/flag-question', () => {
  it('creates an OpenQuestion and appends it to session.openQuestions', async () => {
    const session = sessionStore.createSession()
    const res = await toolRegistry.dispatch('flag-question', makeRequest({
      session_id: session.id,
      question: 'Should we migrate the DB schema before deploy?',
      context: 'The DB currently has stale records.',
    }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.question.question).toBe('Should we migrate the DB schema before deploy?')
    expect(data.question.id).toBeDefined()

    const updated = sessionStore.getSession(session.id)!
    expect(updated.openQuestions).toHaveLength(1)
    expect(updated.openQuestions[0].context).toBe('The DB currently has stale records.')
  })

  it('defaults context to empty string when omitted', async () => {
    const session = sessionStore.createSession()
    const res = await toolRegistry.dispatch('flag-question', makeRequest({
      session_id: session.id,
      question: 'What auth strategy?',
    }))
    expect(res.status).toBe(200)
    expect(sessionStore.getSession(session.id)!.openQuestions[0].context).toBe('')
  })

  it('returns 400 when question is missing', async () => {
    const session = sessionStore.createSession()
    const res = await toolRegistry.dispatch('flag-question', makeRequest({
      session_id: session.id,
    }))
    expect(res.status).toBe(400)
  })
})

// ── generate-spec ─────────────────────────────────────────────────────────────

describe('POST /api/tools/generate-spec', () => {
  it('generates a spec, stores it in session, sets buildStatus to ready', async () => {
    const session = sessionStore.createSession({
      decisions: [{
        id: 'd-1',
        summary: 'Add rate limiting',
        rationale: 'Prevent abuse',
        alternativesConsidered: [],
        relevantFiles: ['src/lib/rate-limiter.ts'],
        timestamp: new Date().toISOString(),
      }],
    })
    const res = await toolRegistry.dispatch('generate-spec', makeRequest({
      session_id: session.id,
    }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.spec).toContain('Add rate limiting')

    const updated = sessionStore.getSession(session.id)!
    expect(updated.specOutput).toBeDefined()
    expect(updated.buildStatus).toBe('ready')
    expect(updated.status).toBe('complete')
  })
})
