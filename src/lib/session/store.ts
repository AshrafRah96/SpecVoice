import { randomUUID } from 'crypto'
import type {
  Session,
  SessionEvent,
  BuildStatus,
  BuildPhase,
  ComplexityAssessment,
  Decision,
  FileRead,
  OpenQuestion,
} from '@/lib/session/types'
import { createHotReloadSafeSingleton } from '@/lib/singleton'
import { guardBuildTransition } from '@/lib/session/build-state-machine'

export class SessionStore {
  private sessions = new Map<string, Session>()
  private listeners = new Map<string, Set<(event: SessionEvent) => void>>()
  private events = new Map<string, { id: string; event: SessionEvent }[]>()
  private attempts = new Set<string>()
  private eventSequence = 0

  constructor(initial?: Session) {
    if (initial) this.sessions.set(initial.id, initial)
  }

  createSession(data: Partial<Session> = {}): Session {
    const now = new Date().toISOString()
    const session: Session = {
      id: data.id ?? randomUUID(),
      repoUrl: data.repoUrl,
      repoLocalPath: data.repoLocalPath,
      repositorySha: data.repositorySha ?? null,
      scopePlan: data.scopePlan ?? null,
      decisions: [],
      openQuestions: [],
      filesRead: [],
      status: 'active',
      callDurationSecs: null,
      transcript: null,
      buildStatus: 'idle',
      buildAttemptKey: null,
      prUrl: null,
      complexityAssessment: null,
      createdAt: now,
      updatedAt: now,
      ...data,
    }
    this.sessions.set(session.id, session)
    this.broadcastEvent(session.id, { type: 'session_updated', session })
    return session
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  listSessions(before?: string, limit = 20): Session[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .filter(session => !before || `${session.createdAt}|${session.id}` < before)
      .slice(0, Math.min(100, Math.max(1, limit)))
  }

  assertCall(id: string, callId?: string) {
    if (!callId) return
    const session = this.getSession(id)
    if (
      session?.currentCallId !== callId ||
      session.callState !== 'active' ||
      !(Date.parse(session.callExpiresAt ?? '') > Date.now())
    )
      throw new Error('Voice call is no longer active')
  }

  updateSession(id: string, updates: Partial<Session>): Session {
    const existing = this.sessions.get(id)
    if (!existing) {
      throw new Error(`Session not found: ${id}. Create it first via POST /api/sessions.`)
    }
    if (updates.buildStatus !== undefined) {
      guardBuildTransition(existing.buildStatus, updates.buildStatus, id)
    }
    const updated: Session = {
      ...existing,
      ...updates,
      id,
      updatedAt: new Date().toISOString(),
    }
    this.sessions.set(id, updated)
    this.broadcastEvent(id, { type: 'session_updated', session: updated })
    return updated
  }

  setBuildStatus(id: string, status: BuildStatus): Session {
    return this.updateSession(id, { buildStatus: status })
  }

  setPrUrl(id: string, url: string): Session {
    return this.updateSession(id, { prUrl: url })
  }

  setComplexityAssessment(id: string, assessment: ComplexityAssessment): Session {
    return this.updateSession(id, { complexityAssessment: assessment })
  }

  addDecision(id: string, decision: Decision, callId?: string): Session {
    this.assertCall(id, callId)
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    return this.updateSession(id, { decisions: [...session.decisions, decision] })
  }

  recordFileRead(id: string, fileRead: FileRead, callId?: string): Session {
    this.assertCall(id, callId)
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    return this.updateSession(id, { filesRead: [...session.filesRead, fileRead] })
  }

  flagQuestion(id: string, question: OpenQuestion, callId?: string): Session {
    this.assertCall(id, callId)
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    return this.updateSession(id, { openQuestions: [...session.openQuestions, question] })
  }

  setSpec(id: string, spec: string, callId?: string): Session {
    this.assertCall(id, callId)
    return this.updateSession(id, {
      specOutput: spec,
      status: 'complete',
      ...(this.getSession(id)?.buildStatus === 'building' ? {} : { buildStatus: 'ready' as const }),
    })
  }

  endCall(
    id: string,
    callDurationSecs: number,
    transcript: string | null,
    transcriptRecordedAt = new Date().toISOString()
  ): Session {
    const current = this.getSession(id)
    const session = this.updateSession(id, {
      status: 'complete',
      callDurationSecs,
      transcript,
      transcriptRecordedAt,
      ...(current?.buildStatus === 'idle' ? { buildStatus: 'ready' as const } : {}),
    })
    this.broadcastEvent(id, { type: 'call_ended', sessionId: id, callDurationSecs })
    return session
  }

  tryStartBuild(
    id: string,
    attemptKey: string
  ): { status: 'started' | 'replayed' | 'conflict' | 'not_found' | 'not_ready'; session?: Session } {
    const current = this.sessions.get(id)
    if (!current) return { status: 'not_found' }
    if (current.callState === 'active' || current.callState === 'awaiting_transcript')
      return { status: 'not_ready', session: current }
    if (this.attempts.has(JSON.stringify([id, attemptKey]))) return { status: 'replayed', session: current }
    if (current.buildStatus === 'building') {
      return current.buildAttemptKey === attemptKey
        ? { status: 'replayed', session: current }
        : { status: 'conflict', session: current }
    }

    const session = this.updateSession(id, {
      buildStatus: 'building',
      buildAttemptKey: attemptKey,
      buildRecovery: null,
    })
    this.attempts.add(JSON.stringify([id, attemptKey]))
    this.broadcastEvent(id, { type: 'build_started', sessionId: id })
    return { status: 'started', session }
  }

  startBuild(id: string, attemptKey = randomUUID()): Session {
    const result = this.tryStartBuild(id, attemptKey)
    if (result.status !== 'started' || !result.session) {
      throw new Error(`Build cannot start for session ${id}: ${result.status}`)
    }
    return result.session
  }

  blockBuild(id: string, assessment: ComplexityAssessment): Session {
    const session = this.setBuildStatus(id, 'ready')
    this.broadcastEvent(id, { type: 'build_blocked', sessionId: id, assessment })
    return session
  }

  failBuild(id: string, error: string): Session {
    const session = this.setBuildStatus(id, 'failed')
    this.broadcastEvent(id, { type: 'build_failed', sessionId: id, error })
    return session
  }

  emitBuildProgress(id: string, phase: BuildPhase, detail: string): void {
    this.broadcastEvent(id, { type: 'build_progress', phase, detail })
  }

  completeBuild(id: string, prUrl: string): Session {
    const session = this.updateSession(id, { prUrl, buildStatus: 'complete' })
    this.broadcastEvent(id, { type: 'build_complete', sessionId: id, prUrl })
    return session
  }

  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Set())
    }
    this.listeners.get(sessionId)!.add(listener)
    return () => {
      const set = this.listeners.get(sessionId)
      if (!set) return
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(sessionId)
    }
  }

  broadcastEvent(sessionId: string, event: SessionEvent): void {
    const records = this.events.get(sessionId) ?? []
    records.push({ id: String(++this.eventSequence), event })
    this.events.set(sessionId, records)
    this.listeners.get(sessionId)?.forEach(listener => listener(event))
  }

  getSnapshot(id: string) {
    return { session: this.getSession(id), cursor: this.events.get(id)?.at(-1)?.id ?? '0' }
  }

  readEvents(id: string, after: string, limit = 100) {
    return (this.events.get(id) ?? []).filter(record => BigInt(record.id) > BigInt(after)).slice(0, limit)
  }

  watch(id: string, wake: () => void): () => void {
    return this.subscribe(id, wake)
  }
}

export const sessionStore = createHotReloadSafeSingleton('__sessionStore', () => new SessionStore())
