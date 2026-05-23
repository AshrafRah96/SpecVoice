import type { Session, Decision } from '@/lib/session/types'

let _sessionSeq = 0
let _decisionSeq = 0

export function makeSession(overrides: Partial<Session> = {}): Session {
  const seq = ++_sessionSeq
  return {
    id: `test-session-${seq}`,
    repoUrl: 'https://github.com/octocat/Hello-World',
    decisions: [],
    openQuestions: [],
    filesRead: [],
    specOutput: undefined,
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

export function makeDecision(summary: string, overrides: Partial<Decision> = {}): Decision {
  const seq = ++_decisionSeq
  return {
    id: `dec-${seq}`,
    summary,
    rationale: 'Good reason',
    alternativesConsidered: [],
    relevantFiles: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}
