import { describe, it, expect, beforeEach } from 'vitest'
import { sessionStore } from '@/lib/session/store'
import type { BuildStatus, BuildPhase, SessionEvent, ComplexityAssessment } from '@/lib/session/types'

const stubAssessment: ComplexityAssessment = {
  fileCount: 10,
  openQuestionCount: 0,
  lineEstimate: 500,
  size: 'medium',
  blocked: false,
}

function captureEvents(sessionId: string): SessionEvent[] {
  const events: SessionEvent[] = []
  sessionStore.subscribe(sessionId, e => events.push(e))
  return events
}

function makeSession(buildStatus: BuildStatus = 'idle') {
  return sessionStore.createSession({ buildStatus })
}

describe('SessionStore BuildStatus state machine', () => {
  beforeEach(() => {
    // Each test creates its own session via makeSession — no shared state to reset.
  })

  it('allows idle → ready', () => {
    const s = makeSession('idle')
    expect(() => sessionStore.setBuildStatus(s.id, 'ready')).not.toThrow()
    expect(sessionStore.getSession(s.id)!.buildStatus).toBe('ready')
  })

  it('allows ready → building', () => {
    const s = makeSession('ready')
    expect(() => sessionStore.setBuildStatus(s.id, 'building')).not.toThrow()
  })

  it('allows building → complete', () => {
    const s = makeSession('building')
    expect(() => sessionStore.setBuildStatus(s.id, 'complete')).not.toThrow()
  })

  it('allows building → failed', () => {
    const s = makeSession('building')
    expect(() => sessionStore.setBuildStatus(s.id, 'failed')).not.toThrow()
  })

  it('allows building → ready (complexity blocked)', () => {
    const s = makeSession('building')
    expect(() => sessionStore.setBuildStatus(s.id, 'ready')).not.toThrow()
  })

  it('allows failed → ready (retry)', () => {
    const s = makeSession('failed')
    expect(() => sessionStore.setBuildStatus(s.id, 'ready')).not.toThrow()
  })

  it('is a no-op when transitioning to the same status', () => {
    const s = makeSession('ready')
    expect(() => sessionStore.setBuildStatus(s.id, 'ready')).not.toThrow()
    expect(sessionStore.getSession(s.id)!.buildStatus).toBe('ready')
  })

  it('throws on ready → complete (invalid skip)', () => {
    const s = makeSession('ready')
    expect(() => sessionStore.setBuildStatus(s.id, 'complete')).toThrow(
      /invalid buildstatus transition.*ready.*complete/i
    )
  })

  it('throws on idle → building (skips ready)', () => {
    const s = makeSession('idle')
    expect(() => sessionStore.setBuildStatus(s.id, 'building')).toThrow(
      /invalid buildstatus transition.*idle.*building/i
    )
  })

  it('throws on complete → building (terminal state)', () => {
    const s = makeSession('complete')
    expect(() => sessionStore.setBuildStatus(s.id, 'building')).toThrow(
      /invalid buildstatus transition.*complete.*building/i
    )
  })

  it('throws on complete → failed (terminal state)', () => {
    const s = makeSession('complete')
    expect(() => sessionStore.setBuildStatus(s.id, 'failed')).toThrow(
      /invalid buildstatus transition.*complete.*failed/i
    )
  })

  it('guard also fires when buildStatus is set via updateSession directly', () => {
    const s = makeSession('idle')
    expect(() => sessionStore.updateSession(s.id, { buildStatus: 'failed' })).toThrow(
      /invalid buildstatus transition/i
    )
  })
})

describe('SessionStore domain mutation methods', () => {
  it('addDecision appends a Decision and broadcasts session_updated', () => {
    const session = sessionStore.createSession()
    const events = captureEvents(session.id)
    const decision = {
      id: 'dec-1',
      summary: 'Use Postgres',
      rationale: 'ACID',
      alternativesConsidered: [],
      relevantFiles: [],
      timestamp: new Date().toISOString(),
    }

    sessionStore.addDecision(session.id, decision)

    const updated = sessionStore.getSession(session.id)!
    expect(updated.decisions).toHaveLength(1)
    expect(updated.decisions[0]).toEqual(decision)
    expect(events.some(e => e.type === 'session_updated')).toBe(true)
  })

  it('addDecision accumulates multiple decisions', () => {
    const session = sessionStore.createSession()
    const base = { rationale: 'r', alternativesConsidered: [], relevantFiles: [], timestamp: new Date().toISOString() }
    sessionStore.addDecision(session.id, { id: 'a', summary: 'First', ...base })
    sessionStore.addDecision(session.id, { id: 'b', summary: 'Second', ...base })
    expect(sessionStore.getSession(session.id)!.decisions).toHaveLength(2)
  })

  it('recordFileRead appends a FileRead and broadcasts session_updated', () => {
    const session = sessionStore.createSession()
    const events = captureEvents(session.id)
    const fileRead = { path: 'src/lib/foo.ts', timestamp: new Date().toISOString(), characterCount: 420 }

    sessionStore.recordFileRead(session.id, fileRead)

    const updated = sessionStore.getSession(session.id)!
    expect(updated.filesRead).toHaveLength(1)
    expect(updated.filesRead[0]).toEqual(fileRead)
    expect(events.some(e => e.type === 'session_updated')).toBe(true)
  })

  it('flagQuestion appends an OpenQuestion and broadcasts session_updated', () => {
    const session = sessionStore.createSession()
    const events = captureEvents(session.id)
    const question = { id: 'q-1', question: 'Migrate?', context: 'ctx', timestamp: new Date().toISOString() }

    sessionStore.flagQuestion(session.id, question)

    const updated = sessionStore.getSession(session.id)!
    expect(updated.openQuestions).toHaveLength(1)
    expect(updated.openQuestions[0]).toEqual(question)
    expect(events.some(e => e.type === 'session_updated')).toBe(true)
  })

  it('setSpec stores specOutput, marks session complete, transitions buildStatus to ready', () => {
    const session = sessionStore.createSession()

    sessionStore.setSpec(session.id, '# My Spec')

    const updated = sessionStore.getSession(session.id)!
    expect(updated.specOutput).toBe('# My Spec')
    expect(updated.status).toBe('complete')
    expect(updated.buildStatus).toBe('ready')
  })
})

describe('SessionStore build lifecycle mutations', () => {
  it('endCall persists call fields and emits call_ended', () => {
    const session = sessionStore.createSession()
    const events = captureEvents(session.id)

    sessionStore.endCall(session.id, 42, '[{"role":"user","message":"hi"}]')

    const updated = sessionStore.getSession(session.id)!
    expect(updated.status).toBe('complete')
    expect(updated.buildStatus).toBe('ready')
    expect(updated.callDurationSecs).toBe(42)
    expect(updated.transcript).toBe('[{"role":"user","message":"hi"}]')

    const callEnded = events.find(e => e.type === 'call_ended') as Extract<SessionEvent, { type: 'call_ended' }> | undefined
    expect(callEnded).toBeDefined()
    expect(callEnded!.callDurationSecs).toBe(42)
  })

  it('startBuild transitions to building and emits build_started', () => {
    const session = sessionStore.createSession({ buildStatus: 'ready' })
    const events = captureEvents(session.id)

    sessionStore.startBuild(session.id)

    expect(sessionStore.getSession(session.id)!.buildStatus).toBe('building')
    expect(events.some(e => e.type === 'build_started')).toBe(true)
  })

  it('blockBuild transitions to ready and emits build_blocked with assessment', () => {
    const session = sessionStore.createSession({ buildStatus: 'building' })
    const events = captureEvents(session.id)
    const assessment: ComplexityAssessment = { ...stubAssessment, blocked: true, blockReason: 'too_large' }

    sessionStore.blockBuild(session.id, assessment)

    expect(sessionStore.getSession(session.id)!.buildStatus).toBe('ready')
    const blocked = events.find(e => e.type === 'build_blocked') as Extract<SessionEvent, { type: 'build_blocked' }> | undefined
    expect(blocked).toBeDefined()
    expect(blocked!.assessment.blockReason).toBe('too_large')
  })

  it('failBuild transitions to failed and emits build_failed with error message', () => {
    const session = sessionStore.createSession({ buildStatus: 'building' })
    const events = captureEvents(session.id)

    sessionStore.failBuild(session.id, 'claude CLI not found')

    expect(sessionStore.getSession(session.id)!.buildStatus).toBe('failed')
    const failed = events.find(e => e.type === 'build_failed') as Extract<SessionEvent, { type: 'build_failed' }> | undefined
    expect(failed).toBeDefined()
    expect(failed!.error).toBe('claude CLI not found')
  })

  it('emitBuildProgress emits build_progress without mutating session state', () => {
    const session = sessionStore.createSession({ buildStatus: 'building' })
    const events = captureEvents(session.id)
    const before = sessionStore.getSession(session.id)!.updatedAt

    sessionStore.emitBuildProgress(session.id, 'analyzing', 'src/lib/foo.ts')

    expect(sessionStore.getSession(session.id)!.updatedAt).toBe(before)
    const progress = events.find(e => e.type === 'build_progress') as Extract<SessionEvent, { type: 'build_progress' }> | undefined
    expect(progress).toBeDefined()
    expect(progress!.phase).toBe('analyzing' as BuildPhase)
    expect(progress!.detail).toBe('src/lib/foo.ts')
  })

  it('completeBuild sets prUrl and buildStatus=complete and emits build_complete', () => {
    const session = sessionStore.createSession({ buildStatus: 'building' })
    const events = captureEvents(session.id)

    sessionStore.completeBuild(session.id, 'https://github.com/owner/repo/pull/42')

    const updated = sessionStore.getSession(session.id)!
    expect(updated.buildStatus).toBe('complete')
    expect(updated.prUrl).toBe('https://github.com/owner/repo/pull/42')
    const complete = events.find(e => e.type === 'build_complete') as Extract<SessionEvent, { type: 'build_complete' }> | undefined
    expect(complete).toBeDefined()
    expect(complete!.prUrl).toBe('https://github.com/owner/repo/pull/42')
  })
})
