import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { database, runtimePool } from '@/lib/db/postgres'
import { createHotReloadSafeSingleton } from '@/lib/singleton'
import { PostgresSessionRepository } from './postgres-repository'
import { SessionStore, sessionStore } from './store'
import { retainedTranscript } from './retention'

export const CALL_DURATION_SECS = 45 * 60
export interface SessionCall {
  id: string
  sessionId: string
  status: 'active' | 'awaiting_transcript' | 'complete' | 'failed'
  expiresAt: string
  createdAt: string
  conversationId?: string
  transcript?: string
}
export interface CallCompletion {
  sessionId: string
  callId?: string
  conversationId: string
  transcript: string | null
  transcriptRecordedAt?: string
  callDurationSecs: number
}

export class SessionCallError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 429
  ) {
    super(message)
    this.name = 'SessionCallError'
  }
}

/** Call identity owns provider correlation; Session identity alone cannot order callbacks. */
export class SessionCalls {
  private memory = new Map<string, SessionCall>()
  constructor(
    private pool?: Pool,
    private sessions: SessionStore = sessionStore
  ) {}

  private mutate<T>(sessionId: string, fn: (store: SessionStore, client?: PoolClient) => Promise<T>): Promise<T> {
    return this.pool ? new PostgresSessionRepository(this.pool).mutate(sessionId, fn) : fn(this.sessions)
  }

  async start(sessionId: string): Promise<SessionCall> {
    return this.mutate(sessionId, async (store, client) => {
      const session = store.getSession(sessionId)
      if (!session) throw new SessionCallError('Session not found', 404)
      if (session.callState === 'active' && Date.parse(session.callExpiresAt ?? '') > Date.now())
        throw new SessionCallError('A voice call is already active', 409)
      const recent = client
        ? Number(
            (
              await client.query<{ count: string }>(
                "SELECT count(*) FROM session_calls WHERE session_id = $1 AND created_at > clock_timestamp() - interval '15 minutes'",
                [sessionId]
              )
            ).rows[0].count
          )
        : [...this.memory.values()].filter(
            call => call.sessionId === sessionId && Date.parse(call.createdAt) > Date.now() - 15 * 60 * 1000
          ).length
      if (recent >= 5) throw new SessionCallError('Call start limit reached. Retry after 15 minutes.', 429)
      const call: SessionCall = {
        id: randomUUID(),
        sessionId,
        status: 'active',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CALL_DURATION_SECS * 1000).toISOString(),
      }
      if (client)
        await client.query(
          "INSERT INTO session_calls (id, session_id, status, expires_at) VALUES ($1, $2, 'active', $3)",
          [call.id, sessionId, call.expiresAt]
        )
      else this.memory.set(call.id, call)
      store.updateSession(sessionId, {
        currentCallId: call.id,
        callState: 'active',
        callExpiresAt: call.expiresAt,
        status: 'active',
      })
      return call
    })
  }

  async get(id: string): Promise<SessionCall | undefined> {
    const pool = this.pool
    if (!pool) return this.memory.get(id)
    const result = await database(() =>
      pool.query<{
        id: string
        session_id: string
        status: SessionCall['status']
        expires_at: Date
        created_at: Date
        provider_conversation_id: string | null
      }>(
        'SELECT id, session_id, status, expires_at, created_at, provider_conversation_id FROM session_calls WHERE id = $1',
        [id]
      )
    )
    const row = result.rows[0]
    return (
      row && {
        id: row.id,
        sessionId: row.session_id,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        conversationId: row.provider_conversation_id ?? undefined,
      }
    )
  }

  async end(sessionId: string, callId: string, failed = false) {
    return this.mutate(sessionId, async (store, client) => {
      const status = failed ? 'failed' : 'awaiting_transcript'
      if (client) {
        const result = await client.query(
          "UPDATE session_calls SET status = $3 WHERE id = $1 AND session_id = $2 AND (status = 'active' OR ($4 AND status = 'awaiting_transcript')) RETURNING id",
          [callId, sessionId, status, failed]
        )
        if (!result.rowCount) return
      } else {
        const call = this.memory.get(callId)
        if (
          !call ||
          call.sessionId !== sessionId ||
          (call.status !== 'active' && !(failed && call.status === 'awaiting_transcript'))
        )
          return
        call.status = status
      }
      if (store.getSession(sessionId)?.currentCallId === callId) store.updateSession(sessionId, { callState: status })
    })
  }

  async complete(input: CallCompletion, store?: SessionStore, client?: PoolClient): Promise<boolean> {
    if (!store)
      return this.mutate(input.sessionId, (sessionStore, transaction) =>
        this.complete(input, sessionStore, transaction)
      )
    const session = store.getSession(input.sessionId)
    if (!session) return false
    if (!input.callId) {
      // Legacy callbacks may finish legacy Sessions, but cannot be assigned to a new call.
      if (session.currentCallId) return false
      const origin = input.transcriptRecordedAt ?? new Date().toISOString()
      store.endCall(input.sessionId, input.callDurationSecs, retainedTranscript(input.transcript, origin), origin)
      return true
    }
    if (client) {
      const call = await client.query<{ status: string; provider_conversation_id: string | null; created_at: Date }>(
        'SELECT status, provider_conversation_id, created_at FROM session_calls WHERE id = $1 AND session_id = $2 FOR UPDATE',
        [input.callId, input.sessionId]
      )
      const row = call.rows[0]
      if (!row || row.status === 'complete' || row.status === 'failed') return false
      input = {
        ...input,
        transcriptRecordedAt: row.created_at.toISOString(),
        transcript: retainedTranscript(input.transcript, row.created_at.toISOString()),
      }
      if (row.provider_conversation_id && row.provider_conversation_id !== input.conversationId)
        throw new Error('Conversation does not match call')
      await client.query(
        "UPDATE session_calls SET status = 'complete', provider_conversation_id = $2, transcript = $3, duration_secs = $4, completed_at = now() WHERE id = $1",
        [input.callId, input.conversationId, input.transcript, input.callDurationSecs]
      )
    } else {
      const call = this.memory.get(input.callId)
      if (!call || call.sessionId !== input.sessionId || call.status === 'complete' || call.status === 'failed')
        return false
      input = {
        ...input,
        transcriptRecordedAt: call.createdAt,
        transcript: retainedTranscript(input.transcript, call.createdAt),
      }
      if (call.conversationId && call.conversationId !== input.conversationId)
        throw new Error('Conversation does not match call')
      if (
        [...this.memory.values()].some(other => other.id !== call.id && other.conversationId === input.conversationId)
      )
        throw new Error('Conversation already belongs to another call')
      Object.assign(call, { status: 'complete', conversationId: input.conversationId, transcript: input.transcript })
    }
    if (session.currentCallId === input.callId) {
      store.updateSession(input.sessionId, { callState: 'complete' })
      store.endCall(input.sessionId, input.callDurationSecs, input.transcript, input.transcriptRecordedAt)
    }
    return true
  }
}

export function getSessionCalls() {
  return process.env.DATABASE_URL
    ? new SessionCalls(runtimePool())
    : createHotReloadSafeSingleton('__sessionCalls', () => new SessionCalls())
}
