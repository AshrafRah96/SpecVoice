import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Pool } from 'pg'
import { migrate } from '@/lib/db/migrate'
import { createPool, transaction } from '@/lib/db/postgres'
import { runRetention } from '@/lib/session/retention'

const TIMEOUT_MS = 30 * 60 * 1000
const OUTPUT_LIMIT = 4 * 1024 * 1024

async function repository(initializing = false): Promise<NodeJS.ProcessEnv> {
  const directory = process.env.RESTIC_REPOSITORY
  const password = process.env.RESTIC_PASSWORD_FILE
  if (!directory || !password || !isAbsolute(directory) || !isAbsolute(password))
    throw new Error('Backup repository and password file must be absolute local paths')
  if (initializing) await mkdir(directory, { recursive: true })
  const [root, secret] = await Promise.all([realpath(directory), realpath(password)])
  const relativeSecret = relative(root, secret)
  if (!relativeSecret || (relativeSecret !== '..' && !relativeSecret.startsWith(`..${sep}`)))
    throw new Error('Backup password must be stored outside the repository')
  if (!(await stat(root)).isDirectory() || !(await stat(secret)).isFile())
    throw new Error('Backup repository or password file is unavailable')
  const configured = await access(join(root, 'config')).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return false
    }
  )
  if (initializing === configured)
    throw new Error(
      configured ? 'Backup repository is already initialized' : 'Initialize the backup repository explicitly'
    )
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: process.env.NODE_ENV,
    LANG: 'C.UTF-8',
    RESTIC_REPOSITORY: root,
    RESTIC_PASSWORD_FILE: secret,
    RESTIC_CACHE_DIR: process.env.RESTIC_CACHE_DIR,
  }
}

function postgres(): { url: URL; env: Record<string, string> } {
  const url = new URL(process.env.DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2)
    throw new Error('PostgreSQL connection configuration is required')
  const sslmode = url.searchParams.get('sslmode') ?? 'prefer'
  if (!['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(sslmode))
    throw new Error('Unsupported PostgreSQL SSL mode')
  return {
    url,
    env: {
      PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGSSLMODE: sslmode,
      PGCONNECT_TIMEOUT: '10',
    },
  }
}

// Restic can spawn pg_dump; terminate the whole process group and await every close before cleanup.
function commands() {
  const running = new Map<ChildProcessWithoutNullStreams, Promise<void>>()
  let failure: Error | undefined
  let escalation: ReturnType<typeof setTimeout> | undefined
  const kill = (signal: NodeJS.Signals) => {
    for (const child of running.keys()) {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        // A child may have exited between the close notification and its group signal.
      }
    }
  }
  const stop = () => {
    if (failure) return
    failure = new Error('Backup subprocess failed or exceeded its deadline')
    kill('SIGTERM')
    escalation = setTimeout(() => kill('SIGKILL'), 5000)
    escalation.unref()
  }
  const timeout = setTimeout(stop, TIMEOUT_MS)
  timeout.unref()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const start = (binary: string, args: string[], env: NodeJS.ProcessEnv, capture: boolean) => {
    if (failure) throw failure
    const child = spawn(binary, args, { env, detached: process.platform !== 'win32', stdio: 'pipe' })
    let output = ''
    let bytes = 0
    if (capture)
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > OUTPUT_LIMIT) stop()
        else output += chunk.toString('utf8')
      })
    child.stderr.resume()
    child.stdin.on('error', stop)
    child.stdout.on('error', stop)
    child.stderr.on('error', stop)
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', stop)
      child.once('close', code => {
        running.delete(child)
        if (code !== 0) stop()
        if (failure) reject(failure)
        else resolve()
      })
    })
    running.set(child, done)
    void done.catch(stop)
    return { child, done, output: () => output }
  }
  return {
    check() {
      if (failure) throw failure
    },
    async run(binary: string, args: string[], env: NodeJS.ProcessEnv) {
      const command = start(binary, args, env, true)
      command.child.stdin.end()
      await command.done
      return command.output()
    },
    async restore(snapshot: string, env: NodeJS.ProcessEnv) {
      const source = start('restic', ['dump', snapshot, '/specvoice.dump'], env, false)
      let target: ReturnType<typeof start> | undefined
      try {
        target = start(
          'pg_restore',
          ['--exit-on-error', '--no-owner', '--no-acl', '--dbname', env.PGDATABASE!],
          env,
          true
        )
        source.child.stdin.end()
        await Promise.all([source.done, target.done, pipeline(source.child.stdout, target.child.stdin)])
      } catch {
        stop()
        await Promise.allSettled([source.done, ...(target ? [target.done] : [])])
        throw failure
      }
    },
    async close() {
      if (running.size) stop()
      await Promise.allSettled(running.values())
      clearTimeout(timeout)
      if (escalation) clearTimeout(escalation)
      process.removeListener('SIGTERM', stop)
      process.removeListener('SIGINT', stop)
    },
  }
}

async function startRun(pool: Pool, kind: string): Promise<string> {
  try {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO operational_runs (kind, status, detail) VALUES ($1, 'running', '{}') RETURNING id::text",
      [kind]
    )
    return result.rows[0].id
  } catch {
    throw new Error('Unable to record backup operation; no operation started')
  }
}

async function finishRun(pool: Pool, id: string, status: 'complete' | 'failed', detail: object) {
  await pool.query('UPDATE operational_runs SET status = $2, finished_at = now(), detail = $3 WHERE id = $1', [
    id,
    status,
    detail,
  ])
}

export async function initializeBackup(): Promise<void> {
  const command = commands()
  try {
    await command.run('restic', ['init'], await repository(true))
  } catch {
    throw new Error('Backup initialization failed; verify the local repository and separate password file')
  } finally {
    await command.close()
  }
}

export async function backupOnce(pool: Pool): Promise<{ snapshotId: string; elapsedMs: number }> {
  const started = Date.now()
  const id = await startRun(pool, 'backup')
  const command = commands()
  let stage = 'configuration'
  let snapshotId: string | undefined
  let pruneStarted = false
  try {
    const env = { ...(await repository()), ...postgres().env }
    stage = 'backup'
    const output = await command.run(
      'restic',
      [
        '--json',
        'backup',
        '--host',
        'specvoice',
        '--tag',
        'specvoice',
        '--stdin-filename',
        'specvoice.dump',
        '--stdin-from-command',
        '--',
        'pg_dump',
        '--format=custom',
      ],
      env
    )
    for (const line of output.split('\n').filter(Boolean)) {
      const event = JSON.parse(line) as { message_type?: string; snapshot_id?: string }
      if (event.message_type === 'summary') snapshotId = event.snapshot_id
    }
    if (!snapshotId || !/^[a-f0-9]{8,64}$/.test(snapshotId)) throw new Error('Missing backup snapshot identity')
    stage = 'retention'
    pruneStarted = true
    await command.run(
      'restic',
      ['forget', '--tag', 'specvoice', '--group-by', 'host,paths', '--keep-within', '14d', '--prune'],
      env
    )
    const result = { snapshotId, elapsedMs: Date.now() - started }
    stage = 'recording completion'
    await finishRun(pool, id, 'complete', { ...result, pruneStarted })
    return result
  } catch {
    await finishRun(pool, id, 'failed', { stage, snapshotId, pruneStarted, elapsedMs: Date.now() - started }).catch(
      () => {}
    )
    throw new Error(
      `Backup failed (${stage}); ${pruneStarted ? 'retention may have run' : 'old snapshots were not pruned'}`
    )
  } finally {
    await command.close()
  }
}

export interface RestoreResult {
  database: string
  snapshotId: string
  drill: boolean
  sessions: number
  events: number
  elapsedMs: number
}

export async function restoreBackup(
  pool: Pool,
  snapshotId: string,
  options: { targetDatabase?: string; drill?: boolean } = {}
): Promise<RestoreResult> {
  const drill = options.drill === true
  const target = options.targetDatabase ?? (drill ? `specvoice_drill_${randomUUID().replaceAll('-', '_')}` : '')
  if (!/^(latest|[a-f0-9]{8,64})$/.test(snapshotId))
    throw new Error('Restore requires latest or a hexadecimal snapshot ID')
  if (
    target.length > 63 ||
    !(drill ? /^specvoice_(?:drill|restore)_[a-z0-9_]+$/ : /^specvoice_restore_[a-z0-9_]+$/).test(target)
  )
    throw new Error('Restore requires a new specvoice_restore_ database; drills can generate their own target')
  const started = Date.now()
  const id = await startRun(pool, drill ? 'restore_drill' : 'restore')
  const command = commands()
  let restored: Pool | undefined
  let created = false
  let stage = 'configuration'
  let result: RestoreResult | undefined
  try {
    const env = await repository()
    const connection = postgres()
    stage = 'repository integrity'
    await command.run('restic', ['check', '--read-data'], env)
    stage = 'creating target'
    const existing = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [target])
    if (existing.rowCount) throw new Error('Target database already exists')
    await pool.query(`CREATE DATABASE "${target}" TEMPLATE template0`)
    created = true
    stage = 'restore'
    await command.restore(snapshotId, { ...env, ...connection.env, PGDATABASE: target })
    connection.url.pathname = `/${target}`
    restored = createPool(connection.url.href)
    stage = 'migrations'
    await migrate(restored)
    stage = 'recovery guards'
    await transaction(restored, async client => {
      await client.query('DELETE FROM operator_sessions')
      await client.query(
        `UPDATE build_attempts SET status = 'needs_reconciliation',
          phase = CASE WHEN phase = 'queued' THEN 'generating' ELSE phase END,
          lease_token = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE status IN ('queued', 'running', 'needs_reconciliation')`
      )
    })
    stage = 'retention'
    await runRetention(restored)
    stage = 'identity integrity'
    const counts = await restored.query<{ sessions: string; events: string; invalid: string }>(
      `SELECT (SELECT count(*) FROM sessions)::text AS sessions,
        (SELECT count(*) FROM session_events)::text AS events,
        ((SELECT count(*) FROM sessions WHERE data->>'id' IS DISTINCT FROM id) +
         (SELECT count(*) FROM session_events e LEFT JOIN sessions s ON s.id = e.session_id
          WHERE s.id IS NULL OR (e.event->>'type' = 'session_updated'
            AND e.event->'session'->>'id' IS DISTINCT FROM e.session_id)))::text AS invalid`
    )
    const { sessions, events, invalid } = counts.rows[0]
    if (
      invalid !== '0' ||
      ![sessions, events].every(count => Number.isSafeInteger(Number(count)) && Number(count) >= 0)
    )
      throw new Error('Restored Session or event identity integrity failed')
    command.check()
    result = { database: target, snapshotId, drill, sessions: Number(sessions), events: Number(events), elapsedMs: 0 }
  } catch {
    await finishRun(pool, id, 'failed', {
      stage,
      database: target,
      snapshotId,
      created,
      elapsedMs: Date.now() - started,
    }).catch(() => {})
    throw new Error(
      `Restore failed (${stage}); ${created && !drill ? `new database ${target} retained for diagnosis` : 'existing databases unchanged'}`
    )
  } finally {
    await command.close()
    try {
      try {
        await restored?.end()
      } finally {
        if (drill && created) await pool.query(`DROP DATABASE "${target}"`)
      }
    } catch {
      await finishRun(pool, id, 'failed', { stage: 'cleanup', database: target, snapshotId, created }).catch(() => {})
      throw new Error(`Restore cleanup failed for newly created database ${target}`)
    }
  }
  result.elapsedMs = Date.now() - started
  try {
    await finishRun(pool, id, 'complete', result)
  } catch {
    throw new Error('Restore completed but its operational record could not be updated')
  }
  return result
}
