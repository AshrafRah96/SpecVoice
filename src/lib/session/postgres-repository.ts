import { buildReadiness } from '@/lib/repo/readiness'
import { Client, type Pool, type PoolClient } from 'pg'
import { database, transaction } from '@/lib/db/postgres'
import { SessionStore } from './store'
import type { SessionRepository } from './repository'
import type {
  Session,
  SessionEvent,
  BuildStatus,
  BuildPhase,
  ComplexityAssessment,
  Decision,
  FileRead,
  OpenQuestion,
} from './types'

export interface AttemptLease {
  id: string
  token: string
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(
    readonly pool: Pool,
    private readonly lease?: AttemptLease
  ) {}

  private async save(client: PoolClient, session: Session, events: SessionEvent[]) {
    await database(() =>
      client.query('UPDATE sessions SET data = $2, updated_at = now() WHERE id = $1', [session.id, session])
    )
    for (const event of events) {
      await database(() =>
        client.query('INSERT INTO session_events (session_id, event) VALUES ($1, $2)', [session.id, event])
      )
    }
    if (events.length) await database(() => client.query("SELECT pg_notify('session_events', $1)", [session.id]))
  }

  async mutate<T>(id: string, operation: (store: SessionStore, client: PoolClient) => T | Promise<T>): Promise<T> {
    return transaction(this.pool, async client => {
      const row = await database(() =>
        client.query<{ data: Session }>('SELECT data FROM sessions WHERE id = $1 FOR UPDATE', [id])
      )
      if (this.lease) {
        const valid = await database(() =>
          client.query(
            "SELECT id FROM build_attempts WHERE id = $1 AND session_id = $2 AND lease_token = $3 AND status = 'running' AND lease_expires_at > clock_timestamp() FOR UPDATE",
            [this.lease!.id, id, this.lease!.token]
          )
        )
        if (!valid.rowCount) throw new Error('Build attempt lease lost')
      }
      const store = new SessionStore(row.rows[0]?.data)
      const events: SessionEvent[] = []
      store.subscribe(id, event => events.push(event))
      const result = await operation(store, client)
      const session = store.getSession(id)
      if (session && events.length) await this.save(client, session, events)
      return result
    })
  }

  async createSession(data: Partial<Session> = {}) {
    const session = new SessionStore().createSession(data)
    await transaction(this.pool, async client => {
      await database(() => client.query('INSERT INTO sessions (id, data) VALUES ($1, $2)', [session.id, session]))
      await this.save(client, session, [{ type: 'session_updated', session }])
    })
    return session
  }

  async getSession(id: string): Promise<Session | undefined> {
    const result = await database(() =>
      this.pool.query<{ data: Session }>('SELECT data FROM sessions WHERE id = $1', [id])
    )
    return result.rows[0]?.data
  }

  async listSessions(before?: string, limit = 20): Promise<Session[]> {
    const result = await database(() =>
      this.pool.query<{ data: Session }>(
        "SELECT data FROM sessions WHERE ($1::text IS NULL OR (data->>'createdAt') || '|' || id < $1) ORDER BY data->>'createdAt' DESC, id DESC LIMIT $2",
        [before ?? null, Math.min(100, Math.max(1, limit))]
      )
    )
    return result.rows.map(row => row.data)
  }

  async tryStartBuild(id: string, attemptKey: string) {
    return this.mutate(id, async (store, client) => {
      const previous = await database(() =>
        client.query('SELECT id FROM build_attempts WHERE session_id = $1 AND attempt_key = $2', [id, attemptKey])
      )
      if (previous.rowCount) return { status: 'replayed' as const, session: store.getSession(id) }
      const unresolved = await database(() =>
        client.query(
          "SELECT id FROM build_attempts WHERE session_id = $1 AND status IN ('queued', 'running', 'needs_reconciliation')",
          [id]
        )
      )
      if (unresolved.rowCount) return { status: 'conflict' as const, session: store.getSession(id) }
      const snapshotRow = await client.query<{ data: import('./types').RepositorySnapshot }>(
        'SELECT data FROM repo_snapshots WHERE session_id = $1 FOR UPDATE',
        [id]
      )
      const snapshot = snapshotRow.rows[0]?.data
      const session = store.getSession(id)
      if (buildReadiness(snapshot, session?.repositorySha)) return { status: 'not_ready' as const }
      store.updateSession(id, { scopePlan: snapshot!.scopePlan })
      const result = store.tryStartBuild(id, attemptKey)
      if (result.status === 'started') {
        const inserted = await database(() =>
          client.query<{ id: string }>(
            'INSERT INTO build_attempts (session_id, attempt_key, input) VALUES ($1, $2, $3) RETURNING id::text',
            [id, attemptKey, result.session]
          )
        )
        await database(() =>
          client.query('UPDATE build_attempts SET branch_name = $2 WHERE id = $1', [
            inserted.rows[0].id,
            `spec-voice/${id}/${inserted.rows[0].id}`,
          ])
        )
      }
      return result
    })
  }

  updateSession(id: string, updates: Partial<Session>) {
    return this.mutate(id, store => store.updateSession(id, updates))
  }
  setBuildStatus(id: string, status: BuildStatus) {
    return this.mutate(id, store => store.setBuildStatus(id, status))
  }
  setPrUrl(id: string, url: string) {
    return this.mutate(id, store => store.setPrUrl(id, url))
  }
  setComplexityAssessment(id: string, assessment: ComplexityAssessment) {
    return this.mutate(id, store => store.setComplexityAssessment(id, assessment))
  }
  addDecision(id: string, decision: Decision, callId?: string) {
    return this.mutate(id, store => store.addDecision(id, decision, callId))
  }
  recordFileRead(id: string, read: FileRead, callId?: string) {
    return this.mutate(id, store => store.recordFileRead(id, read, callId))
  }
  flagQuestion(id: string, question: OpenQuestion, callId?: string) {
    return this.mutate(id, store => store.flagQuestion(id, question, callId))
  }
  setSpec(id: string, spec: string, callId?: string) {
    return this.mutate(id, store => store.setSpec(id, spec, callId))
  }
  endCall(id: string, duration: number, transcript: string | null, transcriptRecordedAt?: string) {
    return this.mutate(id, store => store.endCall(id, duration, transcript, transcriptRecordedAt))
  }
  blockBuild(id: string, assessment: ComplexityAssessment) {
    return this.mutate(id, async (store, client) => {
      const result = store.blockBuild(id, assessment)
      await this.finishAttempt(client, 'blocked')
      return result
    })
  }
  failBuild(id: string, error: string) {
    return this.mutate(id, async (store, client) => {
      const result = store.failBuild(id, error)
      await this.finishAttempt(client, 'failed', error)
      return result
    })
  }
  emitBuildProgress(id: string, phase: BuildPhase, detail: string) {
    return this.mutate(id, store => store.emitBuildProgress(id, phase, detail))
  }
  completeBuild(id: string, prUrl: string) {
    return this.mutate(id, async (store, client) => {
      const result = store.completeBuild(id, prUrl)
      await this.finishAttempt(client, 'complete')
      return result
    })
  }

  private async finishAttempt(client: PoolClient, status: string, error?: string) {
    if (!this.lease) return
    await client.query(
      'UPDATE build_attempts SET status = $3, error = $4, lease_token = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND lease_token = $2',
      [this.lease.id, this.lease.token, status, error ?? null]
    )
  }

  async getSnapshot(id: string) {
    const result = await database(() =>
      this.pool.query<{ data: Session; cursor: string }>(
        'SELECT data, (SELECT coalesce(max(id), 0)::text FROM session_events WHERE session_id = $1) AS cursor FROM sessions WHERE id = $1',
        [id]
      )
    )
    return { session: result.rows[0]?.data, cursor: result.rows[0]?.cursor ?? '0' }
  }

  async readEvents(id: string, after: string, limit = 100) {
    const result = await database(() =>
      this.pool.query<{ id: string; event: SessionEvent }>(
        'SELECT id::text, event FROM session_events WHERE session_id = $1 AND id > $2 ORDER BY id LIMIT $3',
        [id, after, limit]
      )
    )
    return result.rows
  }

  async watch(id: string, wake: () => void) {
    // Dedicated connection: a slow SSE reader must not exhaust the query pool.
    const client = new Client(this.pool.options)
    client.on('error', wake)
    client.on('notification', message => {
      if (message.payload === id) wake()
    })
    try {
      await database(() => client.connect())
      await database(() => client.query('LISTEN session_events'))
    } catch (error) {
      await client.end().catch(() => {})
      throw error
    }
    return () => {
      void client.end().catch(() => {})
    }
  }
}
