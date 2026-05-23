import { randomUUID } from 'crypto'
import type { Session, SessionEvent, BuildStatus, BuildPhase, ComplexityAssessment, Decision, FileRead, OpenQuestion } from '@/lib/session/types'
import { createHotReloadSafeSingleton } from '@/lib/singleton'
import { guardBuildTransition } from '@/lib/session/build-state-machine'

class SessionStore {
  private sessions = new Map<string, Session>()
  private listeners = new Map<string, Set<(event: SessionEvent) => void>>()

  createSession(data: Partial<Session> = {}): Session {
    const now = new Date().toISOString()
    const session: Session = {
      id: data.id ?? randomUUID(),
      repoUrl: data.repoUrl,
      repoLocalPath: data.repoLocalPath,
      decisions: [],
      openQuestions: [],
      filesRead: [],
      status: 'active',
      callDurationSecs: null,
      transcript: null,
      buildStatus: 'idle',
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

  addDecision(id: string, decision: Decision): Session {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    return this.updateSession(id, { decisions: [...session.decisions, decision] })
  }

  recordFileRead(id: string, fileRead: FileRead): Session {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    return this.updateSession(id, { filesRead: [...session.filesRead, fileRead] })
  }

  flagQuestion(id: string, question: OpenQuestion): Session {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    return this.updateSession(id, { openQuestions: [...session.openQuestions, question] })
  }

  setSpec(id: string, spec: string): Session {
    return this.updateSession(id, { specOutput: spec, status: 'complete', buildStatus: 'ready' })
  }

  endCall(id: string, callDurationSecs: number, transcript: string): Session {
    const session = this.updateSession(id, {
      status: 'complete',
      callDurationSecs,
      transcript,
      buildStatus: 'ready',
    })
    this.broadcastEvent(id, { type: 'call_ended', sessionId: id, callDurationSecs })
    return session
  }

  startBuild(id: string): Session {
    const session = this.setBuildStatus(id, 'building')
    this.broadcastEvent(id, { type: 'build_started', sessionId: id })
    return session
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

  private broadcastEvent(sessionId: string, event: SessionEvent): void {
    this.listeners.get(sessionId)?.forEach(listener => listener(event))
  }
}

export const sessionStore = createHotReloadSafeSingleton('__sessionStore', () => new SessionStore())
