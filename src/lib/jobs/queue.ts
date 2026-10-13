import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { database, transaction } from '@/lib/db/postgres'
import { PostgresSessionRepository } from '@/lib/session/postgres-repository'
import type { Session } from '@/lib/session/types'

export type AttemptPhase = 'queued' | 'generating' | 'push_pending' | 'pushed'
export interface BuildJob {
  id: string
  sessionId: string
  attemptKey: string
  leaseToken: string
  reconciliation: boolean
  input: Session | null
  branchName: string | null
  phase: AttemptPhase
  commitSha: string | null
  recoveryCount: number
}

export class PostgresBuildQueue {
  constructor(
    private readonly pool: Pool,
    private readonly leaseSeconds = 900
  ) {}

  async claim(): Promise<BuildJob | undefined> {
    return transaction(this.pool, async client => {
      await client.query(
        "UPDATE build_attempts SET status = 'needs_reconciliation', lease_token = NULL, lease_expires_at = NULL, updated_at = now() WHERE status = 'running' AND lease_expires_at < now()"
      )
      const result = await client.query<{
        id: string
        session_id: string
        attempt_key: string
        status: string
        input: Session | null
        branch_name: string | null
        phase: AttemptPhase
        commit_sha: string | null
        recovery_count: number
      }>(
        "SELECT * FROM build_attempts WHERE status IN ('queued', 'needs_reconciliation') AND available_at <= now() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED"
      )
      const row = result.rows[0]
      if (!row) return undefined
      const leaseToken = randomUUID()
      await client.query(
        "UPDATE build_attempts SET status = 'running', lease_token = $2, lease_expires_at = now() + ($3 * interval '1 second'), updated_at = now() WHERE id = $1",
        [row.id, leaseToken, this.leaseSeconds]
      )
      return {
        id: String(row.id),
        sessionId: row.session_id,
        attemptKey: row.attempt_key,
        leaseToken,
        reconciliation: row.status === 'needs_reconciliation',
        input: row.input,
        branchName: row.branch_name,
        phase: row.phase,
        commitSha: row.commit_sha,
        recoveryCount: row.recovery_count,
      }
    })
  }

  async renew(job: BuildJob): Promise<void> {
    const result = await database(() =>
      this.pool.query(
        "UPDATE build_attempts SET lease_expires_at = now() + ($3 * interval '1 second') WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_expires_at > clock_timestamp() RETURNING id",
        [job.id, job.leaseToken, this.leaseSeconds]
      )
    )
    if (!result.rowCount) throw new Error('Build attempt lease lost')
  }

  async checkpoint(job: BuildJob, phase: AttemptPhase, commitSha?: string) {
    const result = await database(() =>
      this.pool.query(
        "UPDATE build_attempts SET phase = $3, commit_sha = coalesce($4, commit_sha), updated_at = now() WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_expires_at > clock_timestamp() RETURNING id",
        [job.id, job.leaseToken, phase, commitSha ?? null]
      )
    )
    if (!result.rowCount) throw new Error('Build attempt lease lost')
    job.phase = phase
    if (commitSha) job.commitSha = commitSha
  }

  async recoverLater(job: BuildJob, error: string, reconciled = true) {
    const repository = new PostgresSessionRepository(this.pool, { id: job.id, token: job.leaseToken })
    await repository.mutate(job.sessionId, async (store, client) => {
      const count = job.recoveryCount + (reconciled ? 1 : 0)
      const exhausted = count >= 5
      if (exhausted) store.failBuild(job.sessionId, error)
      store.updateSession(job.sessionId, { buildRecovery: { attemptId: job.id, error, retryable: exhausted } })
      await client.query(
        "UPDATE build_attempts SET status = $3, recovery_count = $4, error = $5, available_at = now() + ($6 * interval '1 second'), lease_token = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND lease_token = $2",
        [job.id, job.leaseToken, exhausted ? 'failed' : 'needs_reconciliation', count, error, Math.min(60, 2 ** count)]
      )
    })
  }

  async retryRecovery(sessionId: string, attemptId: string): Promise<boolean> {
    return new PostgresSessionRepository(this.pool).mutate(sessionId, async (store, client) => {
      const active = await client.query(
        "SELECT id FROM build_attempts WHERE session_id = $1 AND status IN ('queued', 'running', 'needs_reconciliation')",
        [sessionId]
      )
      if (active.rowCount) return false
      const result = await client.query(
        "UPDATE build_attempts SET status = 'needs_reconciliation', recovery_count = 0, available_at = now() WHERE id = $1 AND session_id = $2 AND status = 'failed' AND phase IN ('push_pending', 'pushed') AND commit_sha IS NOT NULL AND input IS NOT NULL RETURNING id",
        [attemptId, sessionId]
      )
      if (!result.rowCount) return false
      store.updateSession(sessionId, { buildStatus: 'building', buildRecovery: null })
      return true
    })
  }
}
