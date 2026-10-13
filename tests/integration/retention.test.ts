import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPool } from '@/lib/db/postgres'
import { migrate } from '@/lib/db/migrate'
import { PostgresSessionRepository } from '@/lib/session/postgres-repository'
import { PostgresPostCallQueue, type PostCallInput } from '@/lib/jobs/post-call-queue'
import { PostgresRepositorySnapshotStore } from '@/lib/repo/snapshot-store'
import { ModelBudget } from '@/lib/security/model-budget'
import { retainedTranscript, retentionPolicy, runRetention } from '@/lib/session/retention'
import type { RepositoryProfile, Session } from '@/lib/session/types'

const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests')
if (!new URL(connectionString).pathname.endsWith('_test')) {
  throw new Error('Integration tests truncate data; TEST_DATABASE_URL must select a disposable database ending _test')
}
const pool = createPool(connectionString)
const sessions = new PostgresSessionRepository(pool)
const jobs = new PostgresPostCallQueue(pool)
const snapshots = new PostgresRepositorySnapshotStore(pool)
const sha = 'a'.repeat(40)
const raw = 'Raw transcript retention fixture'
let now: Date
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000)

beforeAll(async () => {
  await migrate(pool)
})
beforeEach(async () => {
  now = new Date()
  vi.stubEnv('SPECVOICE_TRANSCRIPT_RETENTION_DAYS', '30')
  vi.stubEnv('SPECVOICE_METRICS_RETENTION_DAYS', '180')
  vi.stubEnv('SPECVOICE_INDEX_RETENTION_DAYS', '7')
  await pool.query(
    'TRUNCATE sessions, webhook_receipts, operator_sessions, worker_heartbeats, operational_runs RESTART IDENTITY CASCADE'
  )
})
afterEach(() => vi.unstubAllEnvs())
afterAll(async () => {
  await pool.end()
})

async function oldSession() {
  return sessions.createSession({
    transcript: raw,
    transcriptRecordedAt: daysAgo(31).toISOString(),
    repositorySha: sha,
    specOutput: '# Preserve the reviewed Spec',
    status: 'complete',
    buildStatus: 'ready',
  })
}

async function call(sessionId: string, age: number, transcript: string | null = raw) {
  const id = randomUUID()
  await pool.query(
    `INSERT INTO session_calls (id, session_id, status, expires_at, transcript, created_at, completed_at)
     VALUES ($1, $2, 'complete', $3, $4, $3, $5)`,
    [id, sessionId, daysAgo(age), transcript, now]
  )
  return id
}

async function enqueue(sessionId: string, callId?: string): Promise<PostCallInput> {
  const input: PostCallInput = {
    provider: 'elevenlabs',
    deliveryId: randomUUID(),
    eventType: 'post_call_transcription',
    conversationId: randomUUID(),
    body: JSON.stringify({ transcript: raw }),
    sessionId,
    callId,
    callDurationSecs: 42,
    transcript: raw,
  }
  await jobs.accept(input)
  return input
}

async function build(session: Session, status = 'complete') {
  const leaseToken = randomUUID()
  const row = await pool.query<{ id: string }>(
    `INSERT INTO build_attempts (session_id, attempt_key, status, input, lease_token, lease_expires_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp() + interval '10 minutes') RETURNING id`,
    [session.id, randomUUID(), status, session, leaseToken]
  )
  return { id: row.rows[0].id, leaseToken }
}

function profile(age = 8): RepositoryProfile {
  return {
    repositorySha: sha,
    fileCount: 5,
    byteCount: 300,
    languages: { ts: 5 },
    packages: [{ path: 'packages/app', manifest: 'packages/app/package.json', fileCount: 5 }],
    generatedRoots: [],
    vendorRoots: [],
    treeComplete: true,
    indexStatus: 'ready',
    tier: 'small',
    profiledAt: daysAgo(age).toISOString(),
  }
}

async function seedProfile(session: Session) {
  const snapshot = await snapshots.ensureForSession(session, sha)
  const claimed = await snapshots.claimPending()
  if (!claimed || claimed.id !== snapshot.id) throw new Error('Expected profile claim')
  await snapshots.saveProfile(snapshot.id, profile(), claimed.profileLease)
  const proposed = await snapshots.proposeScope(session.id, {
    repositorySha: sha,
    includedRoots: ['packages/app/src'],
    excludedRoots: [],
    estimatedFiles: 5,
    estimatedBytes: 300,
    dependencyBoundaries: [],
    reason: 'Preserve the accepted scope.',
  })
  const plan = await snapshots.confirmScope(session.id, proposed.id)
  await sessions.updateSession(session.id, { scopePlan: plan })
  return plan
}

describe('retention policy', () => {
  it('uses independent defaults and rejects invalid configuration', () => {
    vi.stubEnv('SPECVOICE_TRANSCRIPT_RETENTION_DAYS', undefined)
    vi.stubEnv('SPECVOICE_METRICS_RETENTION_DAYS', undefined)
    vi.stubEnv('SPECVOICE_INDEX_RETENTION_DAYS', undefined)
    expect(retentionPolicy()).toEqual({ transcriptDays: 30, metricsDays: 180, indexDays: 7 })
    vi.stubEnv('SPECVOICE_TRANSCRIPT_RETENTION_DAYS', '14')
    expect(retentionPolicy().transcriptDays).toBe(14)
    for (const value of ['0', '-1', '1.5', 'NaN', '', '999999999999999999']) {
      vi.stubEnv('SPECVOICE_TRANSCRIPT_RETENTION_DAYS', value)
      expect(() => retentionPolicy()).toThrow('positive whole number')
    }
  })

  it('fails closed for missing, invalid, and expired transcript origins', () => {
    expect(retainedTranscript(raw, daysAgo(29).toISOString(), now)).toBe(raw)
    for (const origin of ['', 'invalid', 'infinity', 'now', daysAgo(30).toISOString()])
      expect(retainedTranscript(raw, origin, now)).toBeNull()
  })
})

describe('PostgreSQL retention', () => {
  it('backfills legacy copies from the earliest proven origin without changing identities or planning records', async () => {
    const session = await sessions.createSession({
      transcript: raw,
      repositorySha: sha,
      specOutput: '# Preserve legacy Spec',
    })
    const plan = await seedProfile(session)
    const current = (await sessions.getSession(session.id))!
    const attempt = await build(current)
    await call(session.id, 35)
    await pool.query('INSERT INTO session_events (session_id, event, created_at) VALUES ($1, $2, $3)', [
      session.id,
      { type: 'session_updated', session: current },
      daysAgo(40),
    ])
    const ids = (await sessions.readEvents(session.id, '0')).map(event => event.id)
    const existing = await sessions.createSession({
      transcript: 'Known origin',
      transcriptRecordedAt: daysAgo(1).toISOString(),
    })
    const sql = await readFile(join(process.cwd(), 'migrations/008_retention.sql'), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    const updated = (await sessions.getSession(session.id))!
    expect(Date.parse(updated.transcriptRecordedAt!)).toBe(daysAgo(40).getTime())
    expect(updated).toMatchObject({
      id: session.id,
      transcript: raw,
      specOutput: session.specOutput,
      repositorySha: sha,
      scopePlan: plan,
    })
    const events = await sessions.readEvents(session.id, '0')
    expect(events.map(event => event.id)).toEqual(ids)
    for (const { event } of events) {
      if (event.type === 'session_updated')
        expect(Date.parse(event.session.transcriptRecordedAt!)).toBe(daysAgo(40).getTime())
    }
    const frozen = (
      await pool.query<{ input: Session }>('SELECT input FROM build_attempts WHERE id = $1', [attempt.id])
    ).rows[0].input
    expect(Date.parse(frozen.transcriptRecordedAt!)).toBe(daysAgo(40).getTime())
    expect(frozen).toMatchObject({ specOutput: session.specOutput, scopePlan: plan, repositorySha: sha })
    expect((await sessions.getSession(existing.id))?.transcriptRecordedAt).toBe(existing.transcriptRecordedAt)
  })

  it('scrubs every old raw copy despite fresh updates, preserving planning data, event IDs and receipt identity', async () => {
    const session = await oldSession()
    const plan = await seedProfile(session)
    const callId = await call(session.id, 0)
    const input = await enqueue(session.id, callId)
    await pool.query('UPDATE session_calls SET created_at = $2 WHERE id = $1', [callId, daysAgo(31)])
    const attempt = await build((await sessions.getSession(session.id))!)
    await sessions.updateSession(session.id, { specOutput: '# Preserve this newly reviewed Spec' })
    await pool.query('INSERT INTO session_events (session_id, event, created_at) VALUES ($1, $2, $3), ($1, $4, $3)', [
      session.id,
      { type: 'build_progress', phase: 'reviewing', detail: raw },
      daysAgo(31),
      { type: 'build_failed', sessionId: session.id, error: raw },
    ])
    await pool.query('UPDATE post_call_jobs SET error = $2 WHERE session_id = $1', [session.id, raw])
    const ids = (await sessions.readEvents(session.id, '0')).map(event => event.id)
    await runRetention(pool, now)
    expect(await sessions.getSession(session.id)).toMatchObject({
      transcript: null,
      transcriptRecordedAt: session.transcriptRecordedAt,
      repositorySha: sha,
      specOutput: '# Preserve this newly reviewed Spec',
      scopePlan: plan,
    })
    const events = await sessions.readEvents(session.id, '0')
    expect(events.slice(0, ids.length).map(event => event.id)).toEqual(ids)
    expect(JSON.stringify(events)).not.toContain(raw)
    expect(events.at(-1)?.event).toMatchObject({ type: 'session_updated', session: { transcript: null } })
    expect(
      (await pool.query('SELECT transcript FROM session_calls WHERE id = $1', [callId])).rows[0].transcript
    ).toBeNull()
    expect(
      (await pool.query('SELECT transcript, error FROM post_call_jobs WHERE session_id = $1', [session.id])).rows[0]
    ).toEqual({ transcript: '', error: null })
    expect(
      (await pool.query('SELECT input FROM build_attempts WHERE id = $1', [attempt.id])).rows[0].input
    ).toMatchObject({ transcript: null, specOutput: session.specOutput, repositorySha: sha, scopePlan: plan })
    expect(await jobs.accept(input)).toEqual({ duplicate: true })
    const count = events.length
    await runRetention(pool, now)
    expect(await sessions.readEvents(session.id, '0')).toHaveLength(count)
  })

  it('ages calls independently, retaining a newer transcript and its fresh event copies', async () => {
    const session = await oldSession()
    const older = await call(session.id, 31)
    const recent = await call(session.id, 1, 'Recent call transcript')
    await sessions.updateSession(session.id, {
      currentCallId: recent,
      transcript: 'Recent call transcript',
      transcriptRecordedAt: daysAgo(1).toISOString(),
    })
    await runRetention(pool, now)
    expect((await sessions.getSession(session.id))?.transcript).toBe('Recent call transcript')
    expect(
      (await pool.query('SELECT transcript FROM session_calls WHERE id = $1', [older])).rows[0].transcript
    ).toBeNull()
    expect((await pool.query('SELECT transcript FROM session_calls WHERE id = $1', [recent])).rows[0].transcript).toBe(
      'Recent call transcript'
    )
    const events = JSON.stringify(await sessions.readEvents(session.id, '0'))
    expect(events).not.toContain(raw)
    expect(events).toContain('Recent call transcript')
  })

  it.each(['queued', 'running', 'needs_reconciliation'])(
    'preserves %s frozen input, then scrubs only its transcript after completion',
    async status => {
      const session = await oldSession()
      const attempt = await build(session, status)
      await runRetention(pool, now)
      expect((await sessions.getSession(session.id))?.transcript).toBeNull()
      expect((await pool.query('SELECT input FROM build_attempts WHERE id = $1', [attempt.id])).rows[0].input).toEqual(
        session
      )
      await pool.query("UPDATE build_attempts SET status = 'complete' WHERE id = $1", [attempt.id])
      await runRetention(pool, now)
      expect((await pool.query('SELECT input FROM build_attempts WHERE id = $1', [attempt.id])).rows[0].input).toEqual({
        ...session,
        transcript: null,
      })
    }
  )

  it.each([false, true])(
    'cannot resurrect a previously claimed expired transcript (call identity: %s)',
    async withCall => {
      const session = await sessions.createSession()
      const callId = withCall ? await call(session.id, 0, null) : undefined
      if (callId) {
        await pool.query("UPDATE session_calls SET status = 'awaiting_transcript' WHERE id = $1", [callId])
        await sessions.updateSession(session.id, { currentCallId: callId, callState: 'awaiting_transcript' })
      }
      await enqueue(session.id, callId)
      if (callId) await pool.query('UPDATE session_calls SET created_at = $2 WHERE id = $1', [callId, daysAgo(31)])
      await pool.query('UPDATE post_call_jobs SET created_at = $2 WHERE session_id = $1', [session.id, daysAgo(31)])
      const claimed = await jobs.claim()
      if (!claimed) throw new Error('Expected post-call claim')
      expect(claimed.transcript).toBe(raw)
      await runRetention(pool, now)
      expect(await jobs.finalize(claimed)).toBe(true)
      expect((await sessions.getSession(session.id))?.transcript).toBeNull()
      expect(JSON.stringify(await sessions.readEvents(session.id, '0'))).not.toContain(raw)
      if (callId)
        expect(
          (await pool.query('SELECT transcript FROM session_calls WHERE id = $1', [callId])).rows[0].transcript
        ).toBeNull()
    }
  )

  it('serializes cleanup with Session updates without extending the transcript origin', async () => {
    const session = await oldSession()
    await Promise.all([
      runRetention(pool, now),
      sessions.updateSession(session.id, { specOutput: '# Concurrent reviewed Spec' }),
    ])
    expect(await sessions.getSession(session.id)).toMatchObject({
      transcript: null,
      transcriptRecordedAt: session.transcriptRecordedAt,
      specOutput: '# Concurrent reviewed Spec',
    })
    expect(JSON.stringify(await sessions.readEvents(session.id, '0'))).not.toContain(raw)
  })

  it('preserves writes recorded after the sweep selected its cutoff time', async () => {
    const session = await sessions.createSession({
      transcript: raw,
      transcriptRecordedAt: now.toISOString(),
      repositorySha: sha,
    })
    const attempt = await build(session)
    const snapshot = await snapshots.ensureForSession(session, sha)
    const claimed = await snapshots.claimPending()
    await snapshots.saveProfile(snapshot.id, profile(0), claimed!.profileLease)
    await runRetention(pool, daysAgo(1))
    expect((await sessions.getSession(session.id))?.transcript).toBe(raw)
    expect(JSON.stringify(await sessions.readEvents(session.id, '0'))).toContain(raw)
    expect(
      (await pool.query('SELECT input FROM build_attempts WHERE id = $1', [attempt.id])).rows[0].input.transcript
    ).toBe(raw)
    expect((await snapshots.getForSession(session.id))?.indexStatus).toBe('ready')
  })

  it('redacts invalid origin metadata in copied JSON without aborting cleanup', async () => {
    const session = await sessions.createSession({ transcript: raw, transcriptRecordedAt: 'not-a-timestamp' })
    const attempt = await build(session)
    await runRetention(pool, now)
    expect((await sessions.getSession(session.id))?.transcript).toBeNull()
    expect(JSON.stringify(await sessions.readEvents(session.id, '0'))).not.toContain(raw)
    expect(
      (await pool.query('SELECT input FROM build_attempts WHERE id = $1', [attempt.id])).rows[0].input.transcript
    ).toBeNull()
  })

  it('rolls back a Session and its copies if redaction notification persistence fails', async () => {
    const session = await oldSession()
    const callId = await call(session.id, 0)
    await enqueue(session.id, callId)
    await pool.query('UPDATE session_calls SET created_at = $2 WHERE id = $1', [callId, daysAgo(31)])
    await pool.query(`CREATE FUNCTION retention_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected retention event failure'; END $$`)
    await pool.query(
      'CREATE TRIGGER retention_reject_event BEFORE INSERT ON session_events FOR EACH ROW EXECUTE FUNCTION retention_reject_event()'
    )
    try {
      await expect(runRetention(pool, now)).rejects.toThrow('injected retention event failure')
      expect((await sessions.getSession(session.id))?.transcript).toBe(raw)
      expect(
        (await pool.query('SELECT transcript FROM session_calls WHERE id = $1', [callId])).rows[0].transcript
      ).toBe(raw)
      expect(
        (await pool.query('SELECT transcript FROM post_call_jobs WHERE session_id = $1', [session.id])).rows[0]
          .transcript
      ).toBe(raw)
    } finally {
      await pool.query('DROP TRIGGER retention_reject_event ON session_events')
      await pool.query('DROP FUNCTION retention_reject_event()')
    }
  })

  it('expires only rebuildable profile data and reprofiles explicitly at the same pinned commit', async () => {
    const session = await sessions.createSession({ repositorySha: sha, specOutput: '# Keep this Spec' })
    const plan = await seedProfile(session)
    await runRetention(pool, now)
    expect(await snapshots.getForSession(session.id)).toMatchObject({
      repositorySha: sha,
      scopePlan: plan,
      indexStatus: 'expired',
      profile: null,
    })
    expect((await snapshots.getForSession(session.id))?.profileLease).toBeUndefined()
    expect(await snapshots.claimPending()).toBeUndefined()
    expect((await pool.query('SELECT data FROM scope_plans WHERE id = $1', [plan!.id])).rows[0].data).toEqual(plan)
    await snapshots.retryProfile(session.id)
    const claimed = await snapshots.claimPending()
    if (!claimed) throw new Error('Expected explicit profile rebuild')
    expect(claimed.repositorySha).toBe(sha)
    await snapshots.saveProfile(claimed.id, profile(0), claimed.profileLease)
    expect(await snapshots.getForSession(session.id)).toMatchObject({
      repositorySha: sha,
      scopePlan: plan,
      indexStatus: 'ready',
    })
    expect((await sessions.getSession(session.id))?.specOutput).toBe('# Keep this Spec')
  })

  it.each(['call', 'build'])('defers profile expiry during an active %s', async activity => {
    const session = await sessions.createSession({ repositorySha: sha })
    await seedProfile(session)
    if (activity === 'call') {
      const id = await call(session.id, 0, null)
      await pool.query(
        "UPDATE session_calls SET status = 'active', expires_at = clock_timestamp() + interval '45 minutes' WHERE id = $1",
        [id]
      )
    } else await build(session, 'running')
    await runRetention(pool, now)
    expect((await snapshots.getForSession(session.id))?.indexStatus).toBe('ready')
  })

  it('expires settled metrics and old liveness/login rows without resetting budgets or pending reservations', async () => {
    const session = await sessions.createSession()
    const attempt = await build(session, 'running')
    const budget = new ModelBudget(pool)
    const { token } = await budget.issue(attempt.id, attempt.leaseToken)
    const settled = await budget.reserve(token, 0.25)
    await budget.finish(settled)
    const pending = await budget.reserve(token, 0.5)
    await pool.query('UPDATE model_requests SET created_at = $1', [daysAgo(181)])
    await pool.query(
      'INSERT INTO operator_sessions (token_hash, fingerprint, expires_at) VALUES ($1, $1, $2), ($3, $3, $4)',
      ['expired-test-token-hash', daysAgo(1), 'active-test-token-hash', daysAgo(-1)]
    )
    await pool.query(
      "INSERT INTO worker_heartbeats (id, state, heartbeat_at) VALUES ('old-worker', 'stopping', $1), ('current-worker', 'running', $2)",
      [daysAgo(181), now]
    )
    await pool.query(
      `INSERT INTO operational_runs (kind, status, started_at, finished_at)
       VALUES ('backup', 'complete', $1, $1), ('restore_drill', 'running', $1, NULL), ('restore', 'complete', $1, $2)`,
      [daysAgo(181), now]
    )
    await runRetention(pool, now)
    expect((await pool.query('SELECT id FROM model_requests')).rows).toEqual([{ id: pending.id }])
    expect(
      (await pool.query('SELECT spent_usd, requests, in_flight FROM model_runs WHERE attempt_id = $1', [attempt.id]))
        .rows[0]
    ).toEqual({ spent_usd: '0.75', requests: 2, in_flight: true })
    await expect(new ModelBudget(pool).issue(attempt.id, attempt.leaseToken)).rejects.toMatchObject({ status: 409 })
    expect((await pool.query('SELECT token_hash FROM operator_sessions')).rows).toEqual([
      { token_hash: 'active-test-token-hash' },
    ])
    expect((await pool.query('SELECT id FROM worker_heartbeats')).rows).toEqual([{ id: 'current-worker' }])
    expect((await pool.query('SELECT kind FROM operational_runs ORDER BY id')).rows).toEqual([
      { kind: 'restore_drill' },
      { kind: 'restore' },
    ])
  })

  it('expires old pending usage only after credential expiry, preserving the permanent no-reissue tombstone', async () => {
    const session = await sessions.createSession()
    const attempt = await build(session, 'running')
    const budget = new ModelBudget(pool)
    const { token } = await budget.issue(attempt.id, attempt.leaseToken)
    const reservation = await budget.reserve(token, 0.5)
    await pool.query('UPDATE model_runs SET created_at = $2, expires_at = $2 WHERE attempt_id = $1', [
      attempt.id,
      daysAgo(181),
    ])
    await pool.query('UPDATE model_requests SET created_at = $2 WHERE id = $1', [reservation.id, daysAgo(181)])
    await runRetention(pool, now)
    expect((await pool.query('SELECT id FROM model_requests')).rowCount).toBe(0)
    expect(
      (
        await pool.query('SELECT spent_usd, requests, in_flight, state FROM model_runs WHERE attempt_id = $1', [
          attempt.id,
        ])
      ).rows[0]
    ).toEqual({ spent_usd: '0', requests: 0, in_flight: false, state: 'revoked' })
    expect(await budget.active(token)).toBe(false)
    await expect(budget.reserve(token, 0.1)).rejects.toMatchObject({ status: 401 })
    await expect(budget.issue(attempt.id, attempt.leaseToken)).rejects.toMatchObject({ status: 409 })
    await budget.finish(reservation, { input_tokens: 100, output_tokens: 100 })
    expect(
      (await pool.query('SELECT spent_usd FROM model_runs WHERE attempt_id = $1', [attempt.id])).rows[0].spent_usd
    ).toBe('0')
  })
})
