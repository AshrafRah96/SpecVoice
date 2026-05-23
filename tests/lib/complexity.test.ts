import { describe, it, expect } from 'vitest'
import { assessComplexity, charCountEstimator } from '@/lib/session/complexity'
import { makeSession } from '../fixtures'

describe('assessComplexity', () => {
  it('small session with no questions is not blocked', () => {
    const session = makeSession({
      filesRead: [
        { path: 'src/a.ts', timestamp: '', characterCount: 100 },
        { path: 'src/b.ts', timestamp: '', characterCount: 100 },
      ],
    })
    const result = assessComplexity(session)
    expect(result.fileCount).toBe(2)
    expect(result.lineEstimate).toBe(100) // 2 * 50
    expect(result.size).toBe('small')
    expect(result.blocked).toBe(false)
    expect(result.blockReason).toBeUndefined()
    expect(result.splitSuggestion).toBeUndefined()
  })

  it('session with open questions is blocked with reason open_questions', () => {
    const session = makeSession({
      openQuestions: [
        { id: 'q1', question: 'Migrate data?', context: '', timestamp: '' },
      ],
    })
    const result = assessComplexity(session)
    expect(result.blocked).toBe(true)
    expect(result.blockReason).toBe('open_questions')
    expect(result.openQuestionCount).toBe(1)
    expect(result.splitSuggestion).toBeUndefined()
  })

  it('session with 100+ files is too_large and blocked', () => {
    const filesRead = Array.from({ length: 101 }, (_, i) => ({
      path: `src/module-a/file${i}.ts`,
      timestamp: '',
      characterCount: 100,
    }))
    const session = makeSession({ filesRead })
    const result = assessComplexity(session)
    expect(result.size).toBe('too_large')
    expect(result.blocked).toBe(true)
    expect(result.blockReason).toBe('too_large')
  })

  it('open_questions takes priority over too_large as blockReason', () => {
    const filesRead = Array.from({ length: 101 }, (_, i) => ({
      path: `src/file${i}.ts`,
      timestamp: '',
      characterCount: 100,
    }))
    const session = makeSession({
      filesRead,
      openQuestions: [{ id: 'q1', question: '?', context: '', timestamp: '' }],
    })
    const result = assessComplexity(session)
    expect(result.blockReason).toBe('open_questions')
  })

  it('injected estimator returning large value makes session too_large', () => {
    const session = makeSession({ filesRead: [{ path: 'src/a.ts', timestamp: '', characterCount: 1 }] })
    const result = assessComplexity(session, () => 99999)
    expect(result.size).toBe('too_large')
    expect(result.blocked).toBe(true)
    expect(result.blockReason).toBe('too_large')
  })

  it('injected estimator returning small value keeps session small', () => {
    const filesRead = Array.from({ length: 200 }, (_, i) => ({
      path: `src/file${i}.ts`, timestamp: '', characterCount: 10000,
    }))
    const session = makeSession({ filesRead })
    const result = assessComplexity(session, () => 1)
    expect(result.size).toBe('small')
    expect(result.blocked).toBe(false)
  })

  it('charCountEstimator converts total chars to estimated lines (÷80)', () => {
    const session = makeSession({
      filesRead: [
        { path: 'a.ts', timestamp: '', characterCount: 50000 },
        { path: 'b.ts', timestamp: '', characterCount: 50000 },
      ],
    })
    const result = assessComplexity(session, charCountEstimator)
    expect(result.lineEstimate).toBe(1250) // 100000 / 80
    expect(result.size).toBe('medium')
  })

  it('charCountEstimator correctly classifies many tiny files as small', () => {
    const filesRead = Array.from({ length: 101 }, (_, i) => ({
      path: `config/file${i}.json`, timestamp: '', characterCount: 10,
    }))
    const session = makeSession({ filesRead })
    // filecountEstimator: 101 * 50 = 5050 → too_large
    // charCountEstimator: (101 * 10) / 80 ≈ 13 → small
    const result = assessComplexity(session, charCountEstimator)
    expect(result.size).toBe('small')
    expect(result.blocked).toBe(false)
  })

  it('splitSuggestion groups relevantFiles by top-level directory when too_large', () => {
    const filesRead = Array.from({ length: 101 }, (_, i) => ({
      path: `src/file${i}.ts`,
      timestamp: '',
      characterCount: 100,
    }))
    const session = makeSession({
      filesRead,
      decisions: [
        {
          id: 'd1',
          summary: 'Use Postgres',
          rationale: 'Already running',
          alternativesConsidered: [],
          relevantFiles: ['src/lib/session/store.ts', 'src/lib/session/types.ts'],
          timestamp: '',
        },
        {
          id: 'd2',
          summary: 'Use Tailwind',
          rationale: 'Design system',
          alternativesConsidered: [],
          relevantFiles: ['src/components/Dashboard.tsx', 'src/app/globals.css'],
          timestamp: '',
        },
      ],
    })
    const result = assessComplexity(session)
    expect(result.splitSuggestion).toBeDefined()
    expect(result.splitSuggestion!.length).toBeGreaterThan(0)
    result.splitSuggestion!.forEach(group => {
      expect(Array.isArray(group)).toBe(true)
    })
  })
})
