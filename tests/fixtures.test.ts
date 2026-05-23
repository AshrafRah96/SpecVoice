import { describe, it, expect } from 'vitest'
import { makeSession, makeDecision } from './fixtures'

describe('makeSession', () => {
  it('returns a valid Session with required fields', () => {
    const s = makeSession()
    expect(s.id).toBeTruthy()
    expect(s.decisions).toEqual([])
    expect(s.openQuestions).toEqual([])
    expect(s.filesRead).toEqual([])
    expect(s.buildStatus).toBe('idle')
    expect(s.status).toBe('active')
    expect(s.createdAt).toBeTruthy()
    expect(s.updatedAt).toBeTruthy()
  })

  it('applies overrides over the defaults', () => {
    const s = makeSession({ buildStatus: 'ready', repoUrl: 'https://github.com/x/y' })
    expect(s.buildStatus).toBe('ready')
    expect(s.repoUrl).toBe('https://github.com/x/y')
    expect(s.decisions).toEqual([])
  })
})

describe('makeDecision', () => {
  it('returns a valid Decision with required fields', () => {
    const d = makeDecision('Use Postgres')
    expect(d.id).toBeTruthy()
    expect(d.summary).toBe('Use Postgres')
    expect(d.rationale).toBeTruthy()
    expect(d.alternativesConsidered).toEqual([])
    expect(d.relevantFiles).toEqual([])
    expect(d.timestamp).toBeTruthy()
  })

  it('applies overrides over the defaults', () => {
    const d = makeDecision('Use Redis', { rationale: 'Low latency', alternativesConsidered: ['Memcached'] })
    expect(d.rationale).toBe('Low latency')
    expect(d.alternativesConsidered).toEqual(['Memcached'])
  })
})
