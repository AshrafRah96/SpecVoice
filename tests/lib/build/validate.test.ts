import { describe, it, expect } from 'vitest'
import { validateBuild } from '@/lib/build/validate'
import type { Session } from '@/lib/session/types'

// ── helpers ───────────────────────────────────────────────────────────────────

const passingPrereqs = () => ({ ok: true as const })
const failingPrereqs = (msg: string) => () => ({ ok: false as const, error: msg })

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString()
  return {
    id: 'test-session',
    repoUrl: 'https://github.com/owner/repo',
    repoLocalPath: undefined,
    decisions: [],
    openQuestions: [],
    filesRead: [],
    status: 'active',
    callDurationSecs: null,
    transcript: null,
    buildStatus: 'building',
    prUrl: null,
    complexityAssessment: null,
    specOutput: '# Spec',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

// ── blocked results ───────────────────────────────────────────────────────────

describe('validateBuild — blocked', () => {
  it('returns blocked when session has an open question', () => {
    const session = makeSession({
      openQuestions: [{ id: 'q1', question: 'Migrate?', context: '', timestamp: new Date().toISOString() }],
    })
    const result = validateBuild(session, passingPrereqs)
    expect(result.type).toBe('blocked')
    if (result.type === 'blocked') {
      expect(result.assessment.blocked).toBe(true)
      expect(result.assessment.blockReason).toBe('open_questions')
    }
  })

  it('returns not-blocked for a session with no open questions and a small repo', () => {
    const result = validateBuild(makeSession(), passingPrereqs)
    expect(result.type).not.toBe('blocked')
  })

  it('includes the full complexity assessment in the blocked result', () => {
    const session = makeSession({
      openQuestions: [{ id: 'q1', question: 'Q?', context: '', timestamp: new Date().toISOString() }],
    })
    const result = validateBuild(session, passingPrereqs)
    if (result.type === 'blocked') {
      expect(result.assessment.openQuestionCount).toBe(1)
    }
  })
})

// ── failed results ────────────────────────────────────────────────────────────

describe('validateBuild — failed', () => {
  it('returns failed when prereq check reports an error', () => {
    const result = validateBuild(makeSession(), failingPrereqs('claude CLI not found'))
    expect(result.type).toBe('failed')
    if (result.type === 'failed') {
      expect(result.error).toContain('claude CLI not found')
    }
  })

  it('returns failed when session has no repoUrl', () => {
    const session = makeSession({ repoUrl: undefined })
    const result = validateBuild(session, passingPrereqs)
    expect(result.type).toBe('failed')
    if (result.type === 'failed') {
      expect(result.error).toContain('no repository URL')
    }
  })

  it('checks complexity before prereqs (blocked takes priority over prereq failure)', () => {
    const session = makeSession({
      openQuestions: [{ id: 'q1', question: 'Q?', context: '', timestamp: new Date().toISOString() }],
    })
    const result = validateBuild(session, failingPrereqs('CLI missing'))
    expect(result.type).toBe('blocked')
  })
})

// ── ok result ─────────────────────────────────────────────────────────────────

describe('validateBuild — ok', () => {
  it('returns ok with repoUrl when all checks pass', () => {
    const session = makeSession({ repoUrl: 'https://github.com/owner/repo' })
    const result = validateBuild(session, passingPrereqs)
    expect(result.type).toBe('ok')
    if (result.type === 'ok') {
      expect(result.repoUrl).toBe('https://github.com/owner/repo')
      expect(result.assessment.blocked).toBe(false)
    }
  })

  it('also returns the complexity assessment on ok so caller can record it', () => {
    const session = makeSession()
    const result = validateBuild(session, passingPrereqs)
    if (result.type === 'ok') {
      expect(result.assessment).toBeDefined()
      expect(typeof result.assessment.fileCount).toBe('number')
    }
  })
})
