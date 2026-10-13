import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPool } from '@/lib/db/postgres'
import { migrate } from '@/lib/db/migrate'
import { PostgresBuildQueue, type BuildJob } from '@/lib/jobs/queue'
import { PostgresPostCallQueue, type PostCallInput } from '@/lib/jobs/post-call-queue'
import { PostgresSessionRepository } from '@/lib/session/postgres-repository'
import { PostgresRepositorySnapshotStore } from '@/lib/repo/snapshot-store'
import type { RepositoryProfile, Session } from '@/lib/session/types'

const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests')
if (!new URL(connectionString).pathname.endsWith('_test')) {
  throw new Error('Integration tests truncate data; TEST_DATABASE_URL must select a disposable database ending _test')
}

const pool = createPool(connectionString)
const repository = new PostgresSessionRepository(pool)
const builds = new PostgresBuildQueue(pool, 30)
const postCalls = new PostgresPostCallQueue(pool, 30)
const snapshots = new PostgresRepositorySnapshotStore(pool)
const repositorySha = 'a'.repeat(40)

it('saves a new Spec after a completed Build and waits for a new explicit request', async () => {
  const session = await createBuildSession()
  await seedProfile(session)
  await repository.tryStartBuild(session.id, 'original')
  const job = await claimBuild()
  await leasedRepository(job).completeBuild(session.id, 'https://github.com/example/repository/pull/1')
  const { SessionCalls } = await import('@/lib/session/calls')
  const calls = new SessionCalls(pool)
  const call = await calls.start(session.id)
  await repository.setSpec(session.id, 'A new approved Spec', call.id)
  expect((await repository.getSession(session.id))?.buildStatus).toBe('ready')
  expect(await builds.claim()).toBeUndefined()
  await calls.end(session.id, call.id, true)
  expect((await repository.tryStartBuild(session.id, 'next-spec')).status).toBe('started')
  const next = await claimBuild()
  expect(next.id).not.toBe(job.id)
  expect(next.input?.specOutput).toBe('A new approved Spec')
  expect(next.input?.repositorySha).toBe(repositorySha)
})

it('abandons a pending transcript durably and fences its delayed callback', async () => {
  const { SessionCalls } = await import('@/lib/session/calls')
  const calls = new SessionCalls(pool)
  const session = await createBuildSession()
  const call = await calls.start(session.id)
  await calls.end(session.id, call.id)
  await calls.end(session.id, call.id, true)
  const before = await repository.getSession(session.id)
  expect(before?.callState).toBe('failed')
  expect(before?.specOutput).toBe(session.specOutput)
  expect(await new SessionCalls(pool).get(call.id)).toMatchObject({ status: 'failed' })
  expect(
    await calls.complete({
      sessionId: session.id,
      callId: call.id,
      conversationId: 'lost-callback',
      transcript: 'late',
      callDurationSecs: 30,
    })
  ).toBe(false)
  expect(await repository.getSession(session.id)).toEqual(before)
})

beforeAll(async () => {
  await migrate(pool)
})

beforeEach(async () => {
  await pool.query('TRUNCATE sessions, webhook_receipts RESTART IDENTITY CASCADE')
})

afterAll(async () => {
  await pool.end()
})

function readyProfile(overrides: Partial<RepositoryProfile> = {}): RepositoryProfile {
  return {
    repositorySha,
    fileCount: 2,
    byteCount: 100,
    languages: { ts: 2 },
    packages: [],
    generatedRoots: [],
    vendorRoots: [],
    treeComplete: true,
    indexStatus: 'ready',
    tier: 'small',
    profiledAt: new Date().toISOString(),
    ...overrides,
  }
}

async function seedProfile(session: Session, overrides: Partial<RepositoryProfile> = {}) {
  const snapshot = await snapshots.ensureForSession(session, repositorySha)
  const claimed = await snapshots.claimPending()
  if (!claimed || claimed.id !== snapshot.id) throw new Error('Expected the Repository Profile claim')
  await snapshots.saveProfile(snapshot.id, readyProfile(overrides), claimed.profileLease)
  return snapshot
}

function scopeProposal(includedRoots = ['src']) {
  return {
    repositorySha,
    includedRoots,
    excludedRoots: ['src/vendor'],
    estimatedFiles: 2,
    estimatedBytes: 100,
    dependencyBoundaries: [],
    reason: 'Keep the change bounded.',
  }
}

async function createBuildSession() {
  return repository.createSession({
    repoUrl: 'https://github.com/example/repository',
    repositorySha,
    status: 'complete',
    specOutput: 'Update the scoped module.',
    buildStatus: 'ready',
  })
}

async function enqueueBuild() {
  const session = await createBuildSession()
  await seedProfile(session)
  const plan = await snapshots.proposeScope(session.id, scopeProposal())
  await snapshots.confirmScope(session.id, plan.id)
  const result = await repository.tryStartBuild(session.id, 'request-1')
  expect(result.status).toBe('started')
  if (result.status !== 'started' || !result.session) throw new Error('Expected the queued Session')
  return result.session
}

async function claimBuild(): Promise<BuildJob> {
  const job = await builds.claim()
  if (!job) throw new Error('Expected a queued Build attempt')
  return job
}

function leasedRepository(job: BuildJob) {
  return new PostgresSessionRepository(pool, { id: job.id, token: job.leaseToken })
}

async function enqueuePostCall() {
  const session = await repository.createSession()
  const input: PostCallInput = {
    provider: 'elevenlabs',
    deliveryId: 'delivery-1',
    eventType: 'post_call_transcription',
    conversationId: 'conversation-1',
    eventTimestamp: '2026-10-13T10:00:00Z',
    body: '{"transcript":"fixture"}',
    sessionId: session.id,
    callDurationSecs: 42,
    transcript: 'A deterministic transcript.',
  }
  await postCalls.accept(input)
  return { session, input }
}

describe('durable Build attempts', () => {
  it('allows only one concurrent worker to claim an attempt', async () => {
    const session = await enqueueBuild()
    const results = await Promise.all([builds.claim(), builds.claim(), builds.claim()])
    const claimed = results.filter(job => job !== undefined)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ sessionId: session.id, reconciliation: false, phase: 'queued' })
  })

  it('reclaims an expired generation without losing immutable inputs, branch, or checkpoint', async () => {
    const session = await enqueueBuild()
    const first = await claimBuild()
    expect(first.input).toMatchObject({
      repositorySha,
      specOutput: session.specOutput,
      scopePlan: session.scopePlan,
    })
    expect(first.branchName).toBe(`spec-voice/${session.id}/${first.id}`)
    await builds.checkpoint(first, 'generating')
    await repository.updateSession(session.id, { specOutput: 'Changed after enqueue.', scopePlan: null })
    await pool.query("UPDATE build_attempts SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [
      first.id,
    ])

    const recovered = await claimBuild()
    expect(recovered).toMatchObject({
      id: first.id,
      reconciliation: true,
      phase: 'generating',
      input: first.input,
      branchName: first.branchName,
    })
    expect(recovered.leaseToken).not.toBe(first.leaseToken)
    await expect(builds.renew(first)).rejects.toThrow('Build attempt lease lost')
    await expect(builds.checkpoint(first, 'pushed', 'b'.repeat(40))).rejects.toThrow('Build attempt lease lost')
    await expect(leasedRepository(first).failBuild(session.id, 'stale worker')).rejects.toThrow(
      'Build attempt lease lost'
    )
    await builds.renew(recovered)
    await builds.checkpoint(recovered, 'push_pending', 'c'.repeat(40))
    expect((await pool.query('SELECT phase, commit_sha FROM build_attempts WHERE id = $1', [first.id])).rows).toEqual([
      { phase: 'push_pending', commit_sha: 'c'.repeat(40) },
    ])
    expect((await repository.getSession(session.id))?.buildStatus).toBe('building')
  })

  it('rejects expired ownership before any replacement worker claims the attempt', async () => {
    const session = await enqueueBuild()
    const job = await claimBuild()
    await pool.query("UPDATE build_attempts SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id])
    await expect(builds.renew(job)).rejects.toThrow('Build attempt lease lost')
    await expect(builds.checkpoint(job, 'generating')).rejects.toThrow('Build attempt lease lost')
    await expect(leasedRepository(job).emitBuildProgress(session.id, 'writing', 'stale')).rejects.toThrow(
      'Build attempt lease lost'
    )
    expect((await repository.readEvents(session.id, '0')).some(record => record.event.type === 'build_progress')).toBe(
      false
    )
  })

  it('rechecks lease expiry after waiting for a locked Session', async () => {
    const session = await enqueueBuild()
    const job = await claimBuild()
    const before = await repository.getSnapshot(session.id)
    const locker = await pool.connect()
    let mutation: Promise<unknown> | undefined
    try {
      await locker.query('BEGIN')
      await locker.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [session.id])
      mutation = leasedRepository(job)
        .emitBuildProgress(session.id, 'writing', 'expired while blocked')
        .then(
          () => undefined,
          error => error
        )
      let blockedPid = 0
      await vi.waitFor(async () => {
        const waiting = await pool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'SELECT data FROM sessions%FOR UPDATE'"
        )
        expect(waiting.rows).toHaveLength(1)
        blockedPid = waiting.rows[0].pid
      })
      // Expiry remains after transaction start but before lock release; now() would accept it.
      await pool.query(
        "UPDATE build_attempts SET lease_expires_at = (SELECT xact_start + interval '1 microsecond' FROM pg_stat_activity WHERE pid = $2) WHERE id = $1",
        [job.id, blockedPid]
      )
      await locker.query('COMMIT')
      expect(await mutation).toEqual(new Error('Build attempt lease lost'))
      expect(await repository.getSnapshot(session.id)).toEqual(before)
    } finally {
      await locker.query('ROLLBACK')
      locker.release()
      await mutation
    }
  })

  it('commits terminal state and Session events together, once', async () => {
    const session = await enqueueBuild()
    const job = await claimBuild()
    const leased = leasedRepository(job)
    const cursor = (await repository.getSnapshot(session.id)).cursor
    const prUrl = 'https://github.com/example/repository/pull/1'
    await leased.completeBuild(session.id, prUrl)

    expect((await pool.query('SELECT status, lease_token FROM build_attempts WHERE id = $1', [job.id])).rows).toEqual([
      { status: 'complete', lease_token: null },
    ])
    expect(await repository.getSession(session.id)).toMatchObject({ buildStatus: 'complete', prUrl })
    expect((await repository.readEvents(session.id, cursor)).map(record => record.event.type)).toEqual([
      'session_updated',
      'build_complete',
    ])
    await expect(leased.completeBuild(session.id, prUrl)).rejects.toThrow('Build attempt lease lost')
    expect(await builds.claim()).toBeUndefined()
    expect(await repository.readEvents(session.id, cursor)).toHaveLength(2)
  })

  it.each(['complete', 'failed'] as const)(
    'preserves active Build state when regenerating a Spec, then finishes %s once',
    async status => {
      const session = await enqueueBuild()
      const job = await claimBuild()
      await builds.checkpoint(job, 'generating')
      const frozenInput = job.input
      await repository.setSpec(session.id, 'A replacement Spec for a later explicit Build.')
      expect(await repository.getSession(session.id)).toMatchObject({
        buildStatus: 'building',
        specOutput: 'A replacement Spec for a later explicit Build.',
      })
      const recorded = await pool.query<{ input: Session }>('SELECT input FROM build_attempts WHERE id = $1', [job.id])
      expect(recorded.rows[0].input).toEqual(frozenInput)
      expect(recorded.rows[0].input.specOutput).toBe(session.specOutput)

      const leased = leasedRepository(job)
      const cursor = (await repository.getSnapshot(session.id)).cursor
      const finish = () =>
        status === 'complete'
          ? leased.completeBuild(session.id, 'https://github.com/example/repository/pull/1')
          : leased.failBuild(session.id, 'A deterministic execution failure.')
      await finish()
      expect(await repository.getSession(session.id)).toMatchObject({ buildStatus: status })
      expect((await pool.query('SELECT status, lease_token FROM build_attempts WHERE id = $1', [job.id])).rows).toEqual(
        [{ status, lease_token: null }]
      )
      expect((await repository.readEvents(session.id, cursor)).map(record => record.event.type)).toEqual([
        'session_updated',
        status === 'complete' ? 'build_complete' : 'build_failed',
      ])
      await expect(finish()).rejects.toThrow('Build attempt lease lost')
      expect(await repository.readEvents(session.id, cursor)).toHaveLength(2)
    }
  )

  it('rolls back terminal state if event persistence fails', async () => {
    const session = await enqueueBuild()
    const job = await claimBuild()
    const before = await repository.getSnapshot(session.id)
    await pool.query(`CREATE FUNCTION test_reject_build_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event->>'type' = 'build_complete' THEN RAISE EXCEPTION 'injected event failure'; END IF;
        RETURN NEW;
      END $$`)
    await pool.query(
      'CREATE TRIGGER test_reject_build_event BEFORE INSERT ON session_events FOR EACH ROW EXECUTE FUNCTION test_reject_build_event()'
    )
    try {
      await expect(
        leasedRepository(job).completeBuild(session.id, 'https://github.com/example/repository/pull/1')
      ).rejects.toThrow()
      expect(await repository.getSnapshot(session.id)).toEqual(before)
      expect((await pool.query('SELECT status, lease_token FROM build_attempts WHERE id = $1', [job.id])).rows).toEqual(
        [{ status: 'running', lease_token: job.leaseToken }]
      )
    } finally {
      await pool.query('DROP TRIGGER test_reject_build_event ON session_events')
      await pool.query('DROP FUNCTION test_reject_build_event()')
    }
  })

  it('retries publication recovery five times, then permits recovery-only retry of the same branch', async () => {
    const session = await enqueueBuild()
    let job = await claimBuild()
    await builds.checkpoint(job, 'pushed', 'd'.repeat(40))
    const original = { id: job.id, branchName: job.branchName, input: job.input }
    for (let count = 1; count <= 5; count++) {
      await builds.recoverLater(job, 'PR creation unavailable')
      const persisted = (await pool.query('SELECT status, recovery_count FROM build_attempts WHERE id = $1', [job.id]))
        .rows[0]
      expect(persisted).toEqual({ status: count === 5 ? 'failed' : 'needs_reconciliation', recovery_count: count })
      if (count < 5) {
        expect(await builds.claim()).toBeUndefined()
        await pool.query('UPDATE build_attempts SET available_at = now() WHERE id = $1', [job.id])
        job = await claimBuild()
        expect(job).toMatchObject({ ...original, reconciliation: true, phase: 'pushed', commitSha: 'd'.repeat(40) })
      }
    }
    expect(await repository.getSession(session.id)).toMatchObject({
      buildStatus: 'failed',
      buildRecovery: { attemptId: job.id, retryable: true },
    })
    expect(await builds.retryRecovery(session.id, job.id)).toBe(true)
    expect(await claimBuild()).toMatchObject({ ...original, recoveryCount: 0, reconciliation: true, phase: 'pushed' })
  })

  it('retains legacy missing-input attempts as unsafe for recovery', async () => {
    const session = await repository.createSession({ buildStatus: 'building', repositorySha })
    await seedProfile(session)
    await pool.query("INSERT INTO build_attempts (session_id, attempt_key) VALUES ($1, 'legacy')", [session.id])
    const job = await claimBuild()
    expect(job.input).toBeNull()
    expect(job.branchName).toBeNull()
    await leasedRepository(job).failBuild(session.id, 'Legacy attempt requires a new Build request')
    expect(await builds.retryRecovery(session.id, job.id)).toBe(false)
    expect((await repository.tryStartBuild(session.id, 'explicit-new-request')).status).toBe('started')
    expect((await claimBuild()).input).not.toBeNull()
  })
})

describe('durable Repository Profiles and Scope Plans', () => {
  it('does not enqueue or emit Build events before a pinned profile is ready', async () => {
    const session = await createBuildSession()
    const before = await repository.getSnapshot(session.id)
    expect((await repository.tryStartBuild(session.id, 'missing-profile')).status).toBe('not_ready')
    await snapshots.ensureForSession(session, repositorySha)
    expect((await repository.tryStartBuild(session.id, 'pending-profile')).status).toBe('not_ready')
    expect(await repository.getSnapshot(session.id)).toEqual(before)
    expect(await builds.claim()).toBeUndefined()
  })

  it.each<Partial<RepositoryProfile>>([
    { tier: 'mid' },
    { tier: 'small', treeComplete: false, indexStatus: 'partial' },
  ])('requires confirmation for a bounded profile: %j', async profile => {
    const session = await createBuildSession()
    await seedProfile(session, profile)
    expect((await repository.tryStartBuild(session.id, 'missing-scope')).status).toBe('not_ready')
    const proposed = await snapshots.proposeScope(session.id, scopeProposal())
    expect((await repository.tryStartBuild(session.id, 'unconfirmed-scope')).status).toBe('not_ready')
    const confirmed = await snapshots.confirmScope(session.id, proposed.id)
    expect((await repository.tryStartBuild(session.id, 'confirmed-scope')).status).toBe('started')
    expect((await claimBuild()).input?.scopePlan).toEqual(confirmed)
  })

  it('freezes the canonical confirmed scope rather than stale Session data', async () => {
    const session = await createBuildSession()
    await seedProfile(session, { tier: 'mid' })
    const oldPlan = await snapshots.proposeScope(session.id, scopeProposal(['old']))
    const oldConfirmed = await snapshots.confirmScope(session.id, oldPlan.id)
    await repository.updateSession(session.id, { scopePlan: oldConfirmed })
    const currentPlan = await snapshots.proposeScope(session.id, scopeProposal(['current']))
    const confirmed = await snapshots.confirmScope(session.id, currentPlan.id, {
      estimatedFiles: 1,
      estimatedBytes: 50,
    })
    expect((await repository.tryStartBuild(session.id, 'freeze-current')).status).toBe('started')
    const job = await claimBuild()
    expect(job.input).toMatchObject({ repositorySha, scopePlan: confirmed, specOutput: session.specOutput })
    const laterPlan = await snapshots.proposeScope(session.id, scopeProposal(['later']))
    await snapshots.confirmScope(session.id, laterPlan.id)
    await repository.updateSession(session.id, { specOutput: 'Changed after enqueue.', scopePlan: null })
    await pool.query("UPDATE build_attempts SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id])
    expect((await claimBuild()).input).toEqual(job.input)
  })

  it('fences a stale profiler and preserves the pinned SHA through failed-profile retry', async () => {
    const session = await createBuildSession()
    const snapshot = await snapshots.ensureForSession(session, repositorySha)
    const first = await snapshots.claimPending()
    if (!first) throw new Error('Expected the Repository Profile claim')
    await pool.query("UPDATE repo_snapshots SET updated_at = now() - interval '6 minutes' WHERE id = $1", [snapshot.id])
    const reclaimed = await snapshots.claimPending()
    if (!reclaimed) throw new Error('Expected the expired Repository Profile claim')
    expect(reclaimed.profileLease).not.toBe(first.profileLease)
    await expect(
      snapshots.saveProfile(snapshot.id, readyProfile({ repositorySha: 'b'.repeat(40) }), first.profileLease)
    ).rejects.toThrow('Repository profile lease lost')
    await snapshots.saveProfile(
      snapshot.id,
      readyProfile({ indexStatus: 'failed', treeComplete: false }),
      reclaimed.profileLease
    )
    await snapshots.retryProfile(session.id)
    expect(await snapshots.getForSession(session.id)).toMatchObject({ repositorySha, indexStatus: 'pending' })
    expect((await snapshots.ensureForSession(session, 'b'.repeat(40))).repositorySha).toBe(repositorySha)
    const retry = await snapshots.claimPending()
    if (!retry) throw new Error('Expected the retried Repository Profile claim')
    await expect(snapshots.saveProfile(snapshot.id, readyProfile(), reclaimed.profileLease)).rejects.toThrow(
      'Repository profile lease lost'
    )
    await snapshots.saveProfile(snapshot.id, readyProfile(), retry.profileLease)
    expect(await snapshots.getForSession(session.id)).toMatchObject({ repositorySha, indexStatus: 'ready' })
  })

  it('rejects a profile that would repin an immutable snapshot even with a valid lease', async () => {
    const session = await createBuildSession()
    const snapshot = await snapshots.ensureForSession(session, repositorySha)
    const claim = await snapshots.claimPending()
    if (!claim) throw new Error('Expected the Repository Profile claim')
    const before = await snapshots.getForSession(session.id)
    await expect(
      snapshots.saveProfile(snapshot.id, readyProfile({ repositorySha: 'b'.repeat(40) }), claim.profileLease)
    ).rejects.toThrow()
    expect(await snapshots.getForSession(session.id)).toEqual(before)
  })
})

describe('durable post-call receipts', () => {
  it('deduplicates concurrent deliveries and rejects a reused ID with a different body', async () => {
    const { input } = await enqueuePostCall()
    expect(await Promise.all([postCalls.accept(input), postCalls.accept(input)])).toEqual([
      { duplicate: true },
      { duplicate: true },
    ])
    await expect(postCalls.accept({ ...input, body: 'different' })).rejects.toThrow('different body')
    expect((await pool.query('SELECT count(*)::int AS count FROM post_call_jobs')).rows[0].count).toBe(1)
    expect((await pool.query('SELECT count(*)::int AS count FROM webhook_receipts')).rows[0].count).toBe(1)
  })

  it('fences stale workers and finalizes Session, events, job, and receipt once', async () => {
    const { session } = await enqueuePostCall()
    const first = await postCalls.claim()
    if (!first) throw new Error('Expected a post-call job')
    await pool.query("UPDATE post_call_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [
      first.id,
    ])
    expect(await postCalls.finalize(first)).toBe(false)
    const reclaimed = await postCalls.claim()
    if (!reclaimed) throw new Error('Expected the expired post-call job')
    expect(reclaimed.leaseToken).not.toBe(first.leaseToken)
    expect(await postCalls.finalize(first)).toBe(false)
    expect((await repository.getSession(session.id))?.status).toBe('active')

    expect(await postCalls.finalize(reclaimed)).toBe(true)
    expect(await postCalls.finalize(reclaimed)).toBe(false)
    expect(await repository.getSession(session.id)).toMatchObject({
      status: 'complete',
      callDurationSecs: 42,
      transcript: reclaimed.transcript,
      buildStatus: 'ready',
    })
    expect(
      (await repository.readEvents(session.id, '0')).filter(record => record.event.type === 'call_ended')
    ).toHaveLength(1)
    expect((await pool.query('SELECT status FROM post_call_jobs WHERE id = $1', [reclaimed.id])).rows[0].status).toBe(
      'complete'
    )
    expect(
      (
        await pool.query('SELECT status, processed_at FROM webhook_receipts WHERE receipt_key = $1', [
          reclaimed.receiptKey,
        ])
      ).rows[0]
    ).toMatchObject({ status: 'processed', processed_at: expect.any(Date) })
    expect(await postCalls.claim()).toBeUndefined()
  })

  it('rolls back Session changes, events, and job completion when receipt persistence fails', async () => {
    const { session } = await enqueuePostCall()
    const job = await postCalls.claim()
    if (!job) throw new Error('Expected a post-call job')
    const before = await repository.getSnapshot(session.id)
    await pool.query(`CREATE FUNCTION test_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'processed' THEN RAISE EXCEPTION 'injected receipt failure'; END IF;
        RETURN NEW;
      END $$`)
    await pool.query(
      'CREATE TRIGGER test_reject_receipt BEFORE UPDATE ON webhook_receipts FOR EACH ROW EXECUTE FUNCTION test_reject_receipt()'
    )
    try {
      await expect(postCalls.finalize(job)).rejects.toThrow('injected receipt failure')
      expect(await repository.getSnapshot(session.id)).toEqual(before)
      expect((await pool.query('SELECT status, lease_token FROM post_call_jobs WHERE id = $1', [job.id])).rows).toEqual(
        [{ status: 'running', lease_token: job.leaseToken }]
      )
      expect(
        (await pool.query('SELECT status FROM webhook_receipts WHERE receipt_key = $1', [job.receiptKey])).rows[0]
          .status
      ).toBe('processing')
    } finally {
      await pool.query('DROP TRIGGER test_reject_receipt ON webhook_receipts')
      await pool.query('DROP FUNCTION test_reject_receipt()')
    }
    expect(await postCalls.finalize(job)).toBe(true)
    expect(
      (await repository.readEvents(session.id, '0')).filter(record => record.event.type === 'call_ended')
    ).toHaveLength(1)
  })
})

// Calls and login use the same disposable database as the durable runtime.
describe('durable operator and call boundaries', () => {
  it('stores only opaque token hashes, persists revocation, and expires logins', async () => {
    const { OperatorAuth } = await import('@/lib/security/operator')
    const { TEST_OPERATOR_HASH, TEST_OPERATOR_PASSPHRASE } = await import('../helpers/operator-fixture')
    vi.stubEnv('SPECVOICE_OPERATOR_PASSWORD_HASH', TEST_OPERATOR_HASH)
    await pool.query('TRUNCATE operator_sessions, operator_login_limit')
    try {
      const first = new OperatorAuth(pool)
      const login = await first.login(TEST_OPERATOR_PASSPHRASE)
      const restarted = new OperatorAuth(pool)
      expect(await restarted.valid(login.token)).toBe(true)
      const rows = (await pool.query('SELECT * FROM operator_sessions')).rows
      expect(JSON.stringify(rows)).not.toContain(login.token)
      await restarted.logout(login.token)
      expect(await first.valid(login.token)).toBe(false)
      const next = await first.login(TEST_OPERATOR_PASSPHRASE)
      await pool.query("UPDATE operator_sessions SET expires_at = clock_timestamp() - interval '1 second'")
      expect(await restarted.valid(next.token)).toBe(false)
      const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => restarted.login('wrong')))
      expect(attempts.every(result => result.status === 'rejected')).toBe(true)
      expect((await pool.query('SELECT attempts FROM operator_login_limit')).rows[0].attempts).toBe(10)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('orders history by creation and resumes Sessions after repository reconstruction', async () => {
    const first = await repository.createSession({ createdAt: '2026-01-01T00:00:00.000Z' })
    const second = await repository.createSession({ createdAt: '2026-01-02T00:00:00.000Z' })
    await repository.updateSession(first.id, { specOutput: 'Retained Spec' })
    const resumed = new PostgresSessionRepository(pool)
    expect((await resumed.listSessions(undefined, 1)).map(session => session.id)).toEqual([second.id])
    expect((await resumed.listSessions(`${second.createdAt}|${second.id}`, 1)).map(session => session.id)).toEqual([
      first.id,
    ])
    expect((await resumed.getSession(first.id))?.specOutput).toBe('Retained Spec')
  })

  it('correlates late receipts without changing the current call or duplicating events', async () => {
    const { SessionCalls } = await import('@/lib/session/calls')
    const calls = new SessionCalls(pool)
    const session = await repository.createSession()
    const first = await calls.start(session.id)
    await expect(calls.start(session.id)).rejects.toThrow('already active')
    await calls.end(session.id, first.id)
    const second = await calls.start(session.id)
    await expect(repository.setSpec(session.id, 'Stale Spec', first.id)).rejects.toThrow('no longer active')
    const before = await repository.getSnapshot(session.id)
    const input: PostCallInput = {
      provider: 'elevenlabs',
      eventType: 'post_call_transcription',
      conversationId: 'first-call',
      callId: first.id,
      body: 'first body',
      sessionId: session.id,
      callDurationSecs: 1,
      transcript: 'First transcript',
    }
    await postCalls.accept(input)
    const job = (await postCalls.claim())!
    expect(await postCalls.finalize(job)).toBe(true)
    expect(await repository.getSnapshot(session.id)).toEqual(before)
    expect(await calls.get(first.id)).toMatchObject({ status: 'complete', conversationId: 'first-call' })
    expect(await postCalls.finalize(job)).toBe(false)
    await postCalls.accept({
      ...input,
      callId: second.id,
      conversationId: 'second-call',
      body: 'second body',
      transcript: 'Second transcript',
    })
    const final = (await postCalls.claim())!
    expect(await postCalls.finalize(final)).toBe(true)
    expect(await repository.getSession(session.id)).toMatchObject({
      currentCallId: second.id,
      callState: 'complete',
      transcript: 'Second transcript',
    })
    expect(
      (await repository.readEvents(session.id, before.cursor)).filter(row => row.event.type === 'call_ended')
    ).toHaveLength(1)
  })

  it('rolls call completion back when receipt persistence fails, then retries once', async () => {
    const { SessionCalls } = await import('@/lib/session/calls')
    const calls = new SessionCalls(pool)
    const session = await repository.createSession()
    const call = await calls.start(session.id)
    await postCalls.accept({
      provider: 'elevenlabs',
      eventType: 'post_call_transcription',
      conversationId: 'rollback-call',
      callId: call.id,
      body: 'body',
      sessionId: session.id,
      callDurationSecs: 3,
      transcript: 'Transcript',
    })
    const job = (await postCalls.claim())!
    const before = await repository.getSnapshot(session.id)
    await pool.query(
      `CREATE FUNCTION test_reject_call_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt failed'; END $$`
    )
    await pool.query(
      'CREATE TRIGGER test_reject_call_receipt BEFORE UPDATE ON webhook_receipts FOR EACH ROW EXECUTE FUNCTION test_reject_call_receipt()'
    )
    try {
      await expect(postCalls.finalize(job)).rejects.toThrow('receipt failed')
      expect(await calls.get(call.id)).toMatchObject({ status: 'active' })
      expect(await repository.getSnapshot(session.id)).toEqual(before)
    } finally {
      await pool.query('DROP TRIGGER test_reject_call_receipt ON webhook_receipts')
      await pool.query('DROP FUNCTION test_reject_call_receipt()')
    }
    expect(await postCalls.finalize(job)).toBe(true)
    expect(await postCalls.finalize(job)).toBe(false)
  })

  it('refuses expired post-call failure writes before another worker reclaims the job', async () => {
    await enqueuePostCall()
    const job = (await postCalls.claim())!
    await pool.query(
      "UPDATE post_call_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [job.id]
    )
    await postCalls.finish(job, 'failed', 'stale failure')
    expect((await pool.query('SELECT status, error FROM post_call_jobs WHERE id = $1', [job.id])).rows[0]).toEqual({
      status: 'running',
      error: null,
    })
  })
})

describe('worker scheduling and readiness', () => {
  it('delays failed receipt retries and stops after five owned failures', async () => {
    await enqueuePostCall()
    for (let attempt = 1; attempt <= 5; attempt++) {
      const job = (await postCalls.claim())!
      expect(job).toBeDefined()
      await postCalls.finish(job, 'failed', 'Retryable storage error')
      expect(await postCalls.claim()).toBeUndefined()
      const row = (
        await pool.query(
          'SELECT status, available_at > clock_timestamp() AS delayed FROM post_call_jobs WHERE id = $1',
          [job.id]
        )
      ).rows[0]
      expect(row).toEqual({ status: attempt === 5 ? 'failed' : 'queued', delayed: true })
      await pool.query('UPDATE post_call_jobs SET available_at = clock_timestamp() WHERE id = $1', [job.id])
    }
    expect(await postCalls.claim()).toBeUndefined()
    expect((await pool.query('SELECT status FROM webhook_receipts')).rows[0].status).toBe('failed')
  })

  it('requires a recent running heartbeat for readiness', async () => {
    const { workerHeartbeat, workerReady } = await import('@/lib/jobs/health')
    await pool.query('TRUNCATE worker_heartbeats')
    expect(await workerReady(pool)).toBe(false)
    await workerHeartbeat(pool, 'worker-a')
    expect(await workerReady(pool, 'worker-a')).toBe(true)
    expect(await workerReady(pool, 'worker-b')).toBe(false)
    await pool.query("UPDATE worker_heartbeats SET heartbeat_at = clock_timestamp() - interval '16 seconds'")
    expect(await workerReady(pool)).toBe(false)
    await workerHeartbeat(pool, 'worker-a', 'stopping')
    expect(await workerReady(pool)).toBe(false)
  })

  it('starts the actual worker, processes a receipt, and shuts down gracefully', async () => {
    const { spawn } = await import('node:child_process')
    const { session } = await enqueuePostCall()
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/workers/build-worker.ts'], {
      env: {
        ...process.env,
        DATABASE_URL: connectionString,
        NODE_ENV: 'production',
        GITHUB_TOKEN: '',
        ANTHROPIC_API_KEY: '',
        ELEVENLABS_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise<[number | null, string | null]>((resolve, reject) => {
      child.once('exit', (code, signal) => resolve([code, signal]))
      child.once('error', reject)
    })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      output += chunk.toString()
    })
    try {
      await vi.waitFor(
        async () => {
          expect(child.exitCode, output).toBeNull()
          expect((await repository.getSession(session.id))?.status).toBe('complete')
        },
        { timeout: 10000, interval: 50 }
      )
      child.kill('SIGTERM')
      const result = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))])
      expect(result, output).toEqual([0, null])
      expect(
        (await pool.query("SELECT count(*)::int AS count FROM worker_heartbeats WHERE state = 'stopping'")).rows[0]
          .count
      ).toBeGreaterThan(0)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await exited
    }
  }, 15000)
})
