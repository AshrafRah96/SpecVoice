import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Session } from '@/lib/session/types'
import type { RestoreResult } from '@/lib/ops/backups'

const IMAGE = 'specvoice-backup:test'
const DATABASE = 'specvoice_backup_test'
const TARGET = 'specvoice_restore_smoke'
const USER = 'specvoice'
const PASSWORD = 'synthetic-backup-postgres-password'
const VOLUME = 'synthetic-backup-volume'
const TRANSCRIPT =
  'SYNTHETIC_TRANSCRIPT_ONLY: this deliberately long fictional conversation must be encrypted on disk and removed from restored Session history after thirty days.'
const SHA = 'a'.repeat(40)
const SPEC = '# Synthetic approved Spec\nPreserve this evidence across backup and restore.'

function docker(args: string[], input?: string, timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      args,
      { timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`docker ${args[0]} failed: ${stderr.trim().slice(0, 2000) || error.message.slice(0, 2000)}`))
        else resolve(stdout.trim())
      }
    )
    child.stdin?.on('error', () => {
      // execFile reports an early container exit.
    })
    child.stdin?.end(input)
  })
}

export async function main() {
  await docker(['version', '--format', '{{.Server.Version}}'])
  const image = await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE])
  const postgresImage = await docker(['image', 'inspect', '--format', '{{.Id}}', 'postgres:16-alpine'])
  assert.match(image, /^sha256:[a-f0-9]{64}$/)
  assert.match(postgresImage, /^sha256:[a-f0-9]{64}$/)
  const network = `sv-backup-${randomUUID()}`
  const postgres = `${network}-postgres`
  const directory = await mkdtemp(join(tmpdir(), 'specvoice-backup-smoke-'))
  const destination = join(directory, 'backup')
  const repository = join(destination, 'repository')
  const marker = join(destination, '.specvoice-backup-volume')
  const password = join(directory, 'password')
  const wrongPassword = join(directory, 'wrong-password')
  const containers = new Set<string>()
  let sequence = 0
  let networkCreated = false
  let interrupted = false
  const cleanup = async () => {
    const failures: string[] = []
    for (const name of [...containers].reverse()) {
      try {
        await docker(['rm', '--force', name])
        containers.delete(name)
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('No such container')) failures.push(name)
      }
    }
    if (networkCreated) {
      try {
        await docker(['network', 'rm', network])
        networkCreated = false
      } catch (error) {
        if (!(error instanceof Error) || !/not found|No such network/.test(error.message)) failures.push(network)
      }
    }
    if (failures.length)
      throw new Error(`Synthetic backup cleanup failed: ${failures.join(', ')}; files retained at ${directory}`)
    await rm(directory, { recursive: true, force: true })
  }
  const interrupt = () => {
    interrupted = true
    void cleanup().catch(() => {})
  }
  const check = () => {
    if (interrupted) throw new Error('Synthetic backup verification interrupted')
  }
  process.once('SIGTERM', interrupt)
  process.once('SIGINT', interrupt)
  const databaseUrl = `postgres://${USER}:${PASSWORD}@${postgres}:5432/${DATABASE}`
  const run = async (args: string[], options: { entrypoint?: string; passwordFile?: string } = {}) => {
    check()
    const name = `${network}-run-${++sequence}`
    containers.add(name)
    const output = await docker(
      [
        'run',
        '--rm',
        '--pull=never',
        '--name',
        name,
        '--network',
        network,
        '--read-only',
        '--user',
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit',
        '128',
        '--memory',
        String(512 * 1024 ** 2),
        '--memory-swap',
        String(512 * 1024 ** 2),
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=67108864,mode=1777',
        '--mount',
        `type=bind,source=${destination},target=/backup`,
        '--mount',
        `type=bind,source=${options.passwordFile ?? password},target=/run/secrets/backup_password,readonly`,
        '--env',
        `DATABASE_URL=${databaseUrl}`,
        '--env',
        'HOME=/tmp',
        '--env',
        'RESTIC_REPOSITORY=/backup/repository',
        '--env',
        'RESTIC_PASSWORD_FILE=/run/secrets/backup_password',
        '--env',
        'RESTIC_CACHE_DIR=/tmp/restic-cache',
        '--env',
        `SPECVOICE_BACKUP_VOLUME_ID=${VOLUME}`,
        ...(options.entrypoint ? ['--entrypoint', options.entrypoint] : []),
        image,
        ...args,
      ],
      undefined,
      180_000
    )
    containers.delete(name)
    check()
    return output
  }
  const sql = async (query: string, database = DATABASE) => {
    check()
    return docker(
      [
        'exec',
        '-i',
        '--env',
        `PGPASSWORD=${PASSWORD}`,
        postgres,
        'psql',
        '-XAt',
        '--host',
        '127.0.0.1',
        '--set',
        'ON_ERROR_STOP=1',
        '--username',
        USER,
        '--dbname',
        database,
      ],
      query
    )
  }
  const snapshots = async () => {
    const value: Array<{ id: string }> = JSON.parse(await run(['snapshots', '--json'], { entrypoint: 'restic' }))
    return value.map(snapshot => snapshot.id).sort()
  }
  try {
    await mkdir(repository, { recursive: true, mode: 0o700 })
    await writeFile(marker, `${VOLUME}\n`, { mode: 0o600 })
    await writeFile(password, 'synthetic-restic-password-not-for-real-backups\n', { mode: 0o600 })
    await writeFile(wrongPassword, 'deliberately-wrong-synthetic-password\n', { mode: 0o600 })
    check()
    networkCreated = true
    await docker([
      'network',
      'create',
      '--internal',
      '--opt',
      'com.docker.network.bridge.gateway_mode_ipv4=isolated',
      network,
    ])
    check()
    containers.add(postgres)
    await docker([
      'run',
      '--detach',
      '--pull=never',
      '--name',
      postgres,
      '--network',
      network,
      '--tmpfs',
      '/var/lib/postgresql/data:rw,nosuid,nodev,size=536870912',
      '--env',
      `POSTGRES_USER=${USER}`,
      '--env',
      `POSTGRES_PASSWORD=${PASSWORD}`,
      '--env',
      `POSTGRES_DB=${DATABASE}`,
      postgresImage,
    ])
    let ready = false
    for (let attempt = 0; attempt < 40 && !interrupted; attempt++) {
      try {
        await sql('SELECT 1')
        ready = true
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL did not become ready')
    await run(['--import', 'tsx', 'src/scripts/migrate.ts'], { entrypoint: 'node' })

    const recordedAt = new Date(Date.now() - 31 * 86_400_000).toISOString()
    const session: Session = {
      id: 'synthetic-backup-session',
      repoUrl: 'https://github.com/example/synthetic',
      repositorySha: SHA,
      decisions: [],
      openQuestions: [],
      filesRead: [],
      specOutput: SPEC,
      status: 'complete',
      callDurationSecs: 20,
      transcript: TRANSCRIPT,
      transcriptRecordedAt: recordedAt,
      buildStatus: 'building',
      buildAttemptKey: 'synthetic-attempt',
      prUrl: null,
      complexityAssessment: null,
      createdAt: recordedAt,
      updatedAt: recordedAt,
    }
    await sql(`
      INSERT INTO sessions (id, data, updated_at) VALUES ('${session.id}', $fixture$${JSON.stringify(session)}$fixture$::jsonb, '${recordedAt}');
      INSERT INTO session_events (session_id, event, created_at)
        SELECT id, jsonb_build_object('type', 'session_updated', 'session', data), '${recordedAt}' FROM sessions;
      INSERT INTO session_events (session_id, event, created_at)
        SELECT id, jsonb_build_object('type', 'build_started', 'sessionId', id), '${recordedAt}' FROM sessions;
      INSERT INTO operator_sessions (token_hash, fingerprint, expires_at)
        VALUES ('synthetic-cookie-hash', 'synthetic-fingerprint', now() + interval '1 day');
      INSERT INTO build_attempts (session_id, attempt_key, input, branch_name)
        SELECT id, 'synthetic-attempt', data, 'spec-voice/synthetic/1' FROM sessions;
    `)
    const eventIds = await sql('SELECT json_agg(id ORDER BY id) FROM session_events')
    await run(['init'])
    const config = await readFile(join(repository, 'config'))
    const backup: { snapshotId: string; elapsedMs: number } = JSON.parse(await run(['once']))
    assert.match(backup.snapshotId, /^[a-f0-9]{8,64}$/)
    assert.ok(backup.elapsedMs >= 0 && backup.elapsedMs < 30 * 60_000)
    const originalSnapshots = await snapshots()
    assert.equal(originalSnapshots.length, 1)
    assert.ok(originalSnapshots[0].startsWith(backup.snapshotId))

    const drill: RestoreResult = JSON.parse(await run(['drill']))
    assert.equal(drill.drill, true)
    assert.equal(drill.sessions, 1)
    assert.equal(drill.events, 3)
    assert.ok(drill.elapsedMs >= 0 && drill.elapsedMs < 30 * 60_000)
    assert.match(drill.database, /^specvoice_drill_[a-z0-9_]+$/)
    assert.equal(await sql(`SELECT count(*) FROM pg_database WHERE datname = '${drill.database}'`), '0')

    const restored: RestoreResult = JSON.parse(await run(['restore', 'latest', TARGET]))
    assert.equal(restored.database, TARGET)
    assert.equal(restored.drill, false)
    assert.equal(restored.sessions, 1)
    assert.equal(restored.events, 3)
    assert.ok(restored.elapsedMs >= 0 && restored.elapsedMs < 30 * 60_000)
    const stateQuery = `SELECT jsonb_build_object(
      'session', (SELECT data FROM sessions WHERE id = '${session.id}'),
      'events', (SELECT jsonb_agg(jsonb_build_object('id', id, 'event', event) ORDER BY id) FROM session_events),
      'operators', (SELECT count(*) FROM operator_sessions),
      'attempt', (SELECT jsonb_build_object('status', status, 'phase', phase, 'sha', input->>'repositorySha',
        'lease', lease_token, 'leaseExpiresAt', lease_expires_at) FROM build_attempts)
    )`
    const restoredState = await sql(stateQuery, TARGET)
    const state = JSON.parse(restoredState)
    assert.equal(state.session.transcript, null)
    assert.equal(state.session.specOutput, SPEC)
    assert.equal(state.session.repositorySha, SHA)
    assert.deepEqual(
      state.events.slice(0, 2).map((event: { id: number }) => event.id),
      JSON.parse(eventIds)
    )
    assert.ok(
      state.events.every(
        (event: { event: { type: string; session?: Session } }) =>
          event.event.type !== 'session_updated' || event.event.session?.transcript === null
      )
    )
    assert.equal(state.operators, 0)
    assert.deepEqual(state.attempt, {
      status: 'needs_reconciliation',
      phase: 'generating',
      sha: SHA,
      lease: null,
      leaseExpiresAt: null,
    })
    await assert.rejects(run(['restore', 'latest', TARGET]))
    assert.equal(await sql(stateQuery, TARGET), restoredState, 'Existing restore database was changed')
    assert.equal(await sql(`SELECT data->>'transcript' FROM sessions WHERE id = '${session.id}'`), TRANSCRIPT)

    await assert.rejects(run(['init'], { passwordFile: wrongPassword }))
    await assert.rejects(run(['once'], { passwordFile: wrongPassword }))
    assert.deepEqual(await readFile(join(repository, 'config')), config)
    assert.deepEqual(await snapshots(), originalSnapshots, 'Failed backup changed existing snapshots')
    await rename(marker, `${marker}.missing`)
    try {
      await assert.rejects(run(['once']))
    } finally {
      await rename(`${marker}.missing`, marker)
    }
    assert.deepEqual(await snapshots(), originalSnapshots)
    await run(['check', '--read-data'], { entrypoint: 'restic' })
    for (const path of await readdir(repository, { recursive: true })) {
      const file = join(repository, path)
      if ((await stat(file)).isFile())
        assert.equal((await readFile(file)).includes(TRANSCRIPT), false, 'Backup contains plaintext transcript bytes')
    }
    console.log(
      JSON.stringify({
        backup: 'passed',
        image,
        snapshotId: backup.snapshotId,
        sessions: restored.sessions,
        events: restored.events,
        drillMs: drill.elapsedMs,
        restoreMs: restored.elapsedMs,
        retentionVerified: true,
        existingDatabasePreserved: true,
        wrongPasswordRejected: true,
        missingVolumeRejected: true,
        paidProviderCalls: 0,
      })
    )
  } finally {
    await cleanup()
    process.removeListener('SIGTERM', interrupt)
    process.removeListener('SIGINT', interrupt)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Synthetic backup verification failed')
    process.exitCode = 1
  })
