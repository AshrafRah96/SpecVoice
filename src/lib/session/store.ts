import { randomUUID } from 'crypto'
import type { Session, SessionEvent } from '@/lib/session/types'

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
      createdAt: now,
      updatedAt: now,
      ...data,
    }
    this.sessions.set(session.id, session)
    this.broadcast(session.id, session)
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
    const updated: Session = {
      ...existing,
      ...updates,
      id,
      updatedAt: new Date().toISOString(),
    }
    this.sessions.set(id, updated)
    this.broadcast(id, updated)
    return updated
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

  private broadcast(sessionId: string, session: Session): void {
    const event: SessionEvent = { type: 'session_updated', session }
    this.listeners.get(sessionId)?.forEach(listener => listener(event))
  }
}

// Attach to globalThis so the singleton survives Next.js hot reloads and is
// shared across all route module contexts in the same Node.js process.
const g = globalThis as unknown as { __sessionStore?: SessionStore }
if (!g.__sessionStore) g.__sessionStore = new SessionStore()
export const sessionStore = g.__sessionStore
