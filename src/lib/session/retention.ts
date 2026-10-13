import type { Pool } from 'pg'
import { transaction } from '@/lib/db/postgres'
import type { RepositorySnapshot, Session } from './types'

const DAY_MS = 86_400_000
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/

export function retentionPolicy() {
  const days = (name: string, fallback: number) => {
    const raw = process.env[name] ?? String(fallback)
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || value < 1 || !Number.isSafeInteger(value * DAY_MS))
      throw new Error(`${name} must be a positive whole number of days`)
    return value
  }
  return {
    transcriptDays: days('SPECVOICE_TRANSCRIPT_RETENTION_DAYS', 30),
    metricsDays: days('SPECVOICE_METRICS_RETENTION_DAYS', 180),
    indexDays: days('SPECVOICE_INDEX_RETENTION_DAYS', 7),
  }
}

export function retainedTranscript(text: string | null, recordedAt: string, now = new Date()): string | null {
  const age = now.getTime() - Date.parse(recordedAt)
  return TIMESTAMP.test(recordedAt) && Number.isFinite(age) && age < retentionPolicy().transcriptDays * DAY_MS
    ? text
    : null
}

/** Ages copied JSON by its original transcript timestamp; invalid metadata fails closed. */
function expiredTimestamp(expression: string) {
  return `CASE WHEN ${expression} ~ '${TIMESTAMP.source}' AND pg_input_is_valid(${expression}, 'timestamptz') THEN
    NOT isfinite((${expression})::timestamptz) OR (${expression})::timestamptz <= $2
    ELSE true END`
}

export async function runRetention(pool: Pool, now = new Date()): Promise<void> {
  const policy = retentionPolicy()
  if (!Number.isFinite(now.getTime())) throw new Error('Retention requires a valid current time')
  const transcriptCutoff = new Date(now.getTime() - policy.transcriptDays * DAY_MS)
  const metricsCutoff = new Date(now.getTime() - policy.metricsDays * DAY_MS)
  const profileCutoff = now.getTime() - policy.indexDays * DAY_MS
  let after = ''
  for (;;) {
    const page = await pool.query<{ id: string }>('SELECT id FROM sessions WHERE id > $1 ORDER BY id LIMIT 100', [
      after,
    ])
    if (!page.rowCount) break
    for (const { id } of page.rows) {
      // Writers take the Session lock before jobs, calls, attempts, and snapshot records.
      await transaction(pool, async client => {
        const row = await client.query<{ data: Session }>('SELECT data FROM sessions WHERE id = $1 FOR UPDATE', [id])
        if (!row.rows[0]) return
        const session = row.rows[0].data
        const transcript = retainedTranscript(session.transcript, session.transcriptRecordedAt ?? '', now)
        const changed = transcript !== session.transcript
        if (changed) {
          session.transcript = transcript
          session.updatedAt = now.toISOString()
          await client.query('UPDATE sessions SET data = $2, updated_at = $3 WHERE id = $1', [id, session, now])
        }
        await client.query(
          `UPDATE session_events SET event = jsonb_set(event, '{session,transcript}', 'null')
           WHERE session_id = $1 AND event->>'type' = 'session_updated'
           AND event#>>'{session,transcript}' IS NOT NULL
           AND (${expiredTimestamp("event#>>'{session,transcriptRecordedAt}'")})`,
          [id, transcriptCutoff]
        )
        await client.query(
          `UPDATE session_events SET event = jsonb_set(event,
             CASE WHEN event->>'type' = 'build_progress' THEN '{detail}'::text[] ELSE '{error}'::text[] END,
             '"[Expired under transcript retention policy]"')
           WHERE session_id = $1 AND created_at <= $2 AND event->>'type' IN ('build_progress', 'build_failed')
           AND coalesce(event->>'detail', event->>'error') <> '[Expired under transcript retention policy]'`,
          [id, transcriptCutoff]
        )
        await client.query(
          `UPDATE post_call_jobs j SET transcript = '', error = NULL
           WHERE session_id = $1 AND coalesce((SELECT created_at FROM session_calls WHERE id = j.call_id), j.created_at) <= $2
           AND (transcript <> '' OR error IS NOT NULL)`,
          [id, transcriptCutoff]
        )
        await client.query(
          'UPDATE session_calls SET transcript = NULL WHERE session_id = $1 AND created_at <= $2 AND transcript IS NOT NULL',
          [id, transcriptCutoff]
        )
        await client.query(
          `UPDATE build_attempts SET input = jsonb_set(input, '{transcript}', 'null')
           WHERE session_id = $1 AND status NOT IN ('queued', 'running', 'needs_reconciliation')
           AND input->>'transcript' IS NOT NULL AND (${expiredTimestamp("input->>'transcriptRecordedAt'")})`,
          [id, transcriptCutoff]
        )
        await client.query(
          `UPDATE build_attempts SET error = NULL WHERE session_id = $1 AND created_at <= $2
           AND status NOT IN ('queued', 'running', 'needs_reconciliation') AND error IS NOT NULL`,
          [id, transcriptCutoff]
        )
        const active = await client.query(
          `SELECT 1 FROM build_attempts WHERE session_id = $1 AND status IN ('queued', 'running', 'needs_reconciliation')
           UNION ALL SELECT 1 FROM session_calls WHERE session_id = $1 AND status = 'active' AND expires_at > $2 LIMIT 1`,
          [id, now]
        )
        if (!active.rowCount) {
          const snapshotRow = await client.query<{ data: RepositorySnapshot }>(
            'SELECT data FROM repo_snapshots WHERE session_id = $1 FOR UPDATE',
            [id]
          )
          const snapshot = snapshotRow.rows[0]?.data
          if (snapshot?.profile && !['pending', 'indexing', 'expired'].includes(snapshot.indexStatus)) {
            const profiled = Date.parse(snapshot.profile.profiledAt)
            if (!Number.isFinite(profiled) || profiled <= profileCutoff) {
              const expired: RepositorySnapshot = {
                ...snapshot,
                profile: null,
                indexStatus: 'expired',
                updatedAt: now.toISOString(),
              }
              delete expired.profileLease
              await client.query(
                "UPDATE repo_snapshots SET data = $2, index_status = 'expired', updated_at = $3 WHERE session_id = $1",
                [id, expired, now]
              )
            }
          }
        }
        if (changed) {
          await client.query('INSERT INTO session_events (session_id, event) VALUES ($1, $2)', [
            id,
            { type: 'session_updated', session },
          ])
          await client.query("SELECT pg_notify('session_events', $1)", [id])
        }
      })
    }
    after = page.rows.at(-1)!.id
  }
  // Preserve receipt identities and model-run budget tombstones: deletion would permit replay/reset.
  await pool.query(
    `DELETE FROM model_requests q WHERE q.created_at <= $1 AND (q.status <> 'pending'
     OR EXISTS (SELECT 1 FROM model_runs r WHERE r.attempt_id = q.attempt_id AND r.expires_at <= $2))`,
    [metricsCutoff, now]
  )
  await pool.query(
    `UPDATE model_runs SET spent_usd = 0, requests = 0, in_flight = false, state = 'revoked'
     WHERE created_at <= $1 AND expires_at <= $2 AND (spent_usd <> 0 OR requests <> 0 OR in_flight OR state <> 'revoked')`,
    [metricsCutoff, now]
  )
  await pool.query(
    "DELETE FROM operational_runs WHERE status <> 'running' AND coalesce(finished_at, started_at) <= $1",
    [metricsCutoff]
  )
  await pool.query('DELETE FROM operator_sessions WHERE expires_at <= $1', [now])
  await pool.query('DELETE FROM worker_heartbeats WHERE heartbeat_at <= $1', [metricsCutoff])
}
