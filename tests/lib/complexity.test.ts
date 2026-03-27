import { describe, it, expect } from 'vitest'
import { assessComplexity } from '@/lib/session/complexity'
import type { Session } from '@/lib/session/types'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-id',
    decisions: [],
    openQuestions: [],
    filesRead: [],
    status: 'active',
    callDurationSecs: null,
    transcript: null,
    buildStatus: 'idle',
    prUrl: null,
    complexityAssessment: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

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
