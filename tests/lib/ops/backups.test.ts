import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backupOnce, initializeBackup, restoreBackup } from '@/lib/ops/backups'

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(),
  createPool: vi.fn(),
  migrate: vi.fn(),
  retention: vi.fn(),
}))
vi.mock('node:child_process', async original => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: fixture.spawn,
}))
vi.mock('@/lib/db/postgres', async original => ({
  ...(await original<typeof import('@/lib/db/postgres')>()),
  createPool: fixture.createPool,
}))
vi.mock('@/lib/db/migrate', () => ({ migrate: fixture.migrate }))
vi.mock('@/lib/session/retention', () => ({ runRetention: fixture.retention }))

const snapshotId = '12345678'.repeat(8)
const secret = 'synthetic-password-only'
const dump = 'synthetic binary dump\u0000with bytes'
let directory: string
let repository: string
let password: string
let source: Pool
let restored: Pool
let sourceQuery: ReturnType<typeof vi.fn>
let restoredQuery: ReturnType<typeof vi.fn>
let end: ReturnType<typeof vi.fn>
let existing: boolean
let invalid: string
let children: ChildProcessWithoutNullStreams[]
let scripts: Map<string, string>
let onSpawn: ((child: ChildProcessWithoutNullStreams) => void) | undefined

const commandName = (binary: string, args: string[]) =>
  binary === 'pg_restore' ? binary : args.find(arg => ['init', 'backup', 'forget', 'check', 'dump'].includes(arg))!

beforeEach(async () => {
  vi.clearAllMocks()
  directory = await mkdtemp(join(tmpdir(), 'specvoice-backup-test-'))
  repository = join(directory, 'repository')
  password = join(directory, 'password')
  await mkdir(repository)
  await writeFile(join(repository, 'config'), 'synthetic restic configuration')
  await writeFile(password, 'synthetic-encryption-password')
  vi.stubEnv('RESTIC_REPOSITORY', repository)
  vi.stubEnv('RESTIC_PASSWORD_FILE', password)
  vi.stubEnv('RESTIC_CACHE_DIR', join(directory, 'cache'))
  vi.stubEnv('DATABASE_URL', `postgresql://fixture:${secret}@postgres:5432/specvoice?sslmode=disable`)
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-provider-key')
  existing = false
  invalid = '0'
  children = []
  scripts = new Map()
  onSpawn = undefined
  sourceQuery = vi.fn(async (sql: string) => {
    if (sql.startsWith('INSERT INTO operational_runs')) return { rows: [{ id: '1' }], rowCount: 1 }
    if (sql.includes('FROM pg_database')) return { rows: [], rowCount: existing ? 1 : 0 }
    return { rows: [], rowCount: 0 }
  })
  restoredQuery = vi.fn(async (sql: string) => {
    if (sql.includes('AS sessions')) return { rows: [{ sessions: '2', events: '205', invalid }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  end = vi.fn(async () => {})
  source = { query: sourceQuery } as unknown as Pool
  restored = {
    query: restoredQuery,
    connect: async () => ({ query: restoredQuery, release: vi.fn() }),
    end,
  } as unknown as Pool
  fixture.createPool.mockReturnValue(restored)
  fixture.migrate.mockResolvedValue(undefined)
  fixture.retention.mockResolvedValue({})
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  fixture.spawn.mockImplementation((binary: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    const name = commandName(binary, args)
    const defaults: Record<string, string> = {
      backup: `console.log(JSON.stringify({message_type:'summary',snapshot_id:${JSON.stringify(snapshotId)}}))`,
      dump: `process.stdout.write(${JSON.stringify(dump)})`,
      pg_restore: `let data='';process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>process.exit(data===${JSON.stringify(dump)}?0:3))`,
    }
    const child = original.spawn(process.execPath, ['-e', scripts.get(name) ?? defaults[name] ?? ''], options)
    children.push(child)
    onSpawn?.(child)
    return child
  })
})

afterEach(async () => {
  vi.useRealTimers()
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch {}
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

const commandsRun = () => fixture.spawn.mock.calls.map(([binary, args]) => commandName(binary, args))
const finishDetails = () => sourceQuery.mock.calls.filter(([sql]) => sql.startsWith('UPDATE operational_runs'))

describe('encrypted backup boundary', () => {
  it('backs up through pg_dump, then prunes only after a trustworthy snapshot summary', async () => {
    expect(await backupOnce(source)).toMatchObject({ snapshotId, elapsedMs: expect.any(Number) })
    expect(commandsRun()).toEqual(['backup', 'forget'])
    expect(fixture.spawn.mock.calls[0][1]).toEqual([
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
    ])
    expect(fixture.spawn.mock.calls[1][1]).toEqual([
      'forget',
      '--tag',
      'specvoice',
      '--group-by',
      'host,paths',
      '--keep-within',
      '14d',
      '--prune',
    ])
    for (const [, args, options] of fixture.spawn.mock.calls) {
      expect(args.join(' ')).not.toContain(secret)
      expect(options.env).toMatchObject({
        PGDATABASE: 'specvoice',
        PGPASSWORD: secret,
        PGSSLMODE: 'disable',
        RESTIC_CACHE_DIR: join(directory, 'cache'),
      })
      expect(options.env.DATABASE_URL).toBeUndefined()
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(options.shell).toBeUndefined()
    }
    expect(finishDetails()[0][1]).toEqual([
      '1',
      'complete',
      expect.objectContaining({ snapshotId, pruneStarted: true }),
    ])
  })

  it('never prunes or leaks child diagnostics when dumping fails', async () => {
    scripts.set('backup', `console.error(${JSON.stringify(secret)});process.exit(2)`)
    const error = await backupOnce(source).catch(error => error as Error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('old snapshots were not pruned')
    expect(String(error)).not.toContain(secret)
    expect(commandsRun()).toEqual(['backup'])
    expect(finishDetails()[0][1]).toEqual([
      '1',
      'failed',
      expect.objectContaining({ stage: 'backup', pruneStarted: false }),
    ])
    expect(JSON.stringify(finishDetails())).not.toContain(secret)
  })

  it('reports retention failure honestly after a completed backup', async () => {
    scripts.set('forget', 'process.exit(1)')
    await expect(backupOnce(source)).rejects.toThrow('retention may have run')
    expect(finishDetails()[0][1]).toEqual(['1', 'failed', expect.objectContaining({ snapshotId, pruneStarted: true })])
  })

  it('refuses pruning when the backup command has no valid snapshot identity', async () => {
    scripts.set('backup', 'console.log(JSON.stringify({message_type:"summary",snapshot_id:"--unsafe"}))')
    await expect(backupOnce(source)).rejects.toThrow('old snapshots were not pruned')
    expect(commandsRun()).toEqual(['backup'])
  })

  it('requires explicit initialization and refuses to initialize an existing repository', async () => {
    await expect(initializeBackup()).rejects.toThrow('initialization failed')
    expect(fixture.spawn).not.toHaveBeenCalled()
    await rm(join(repository, 'config'))
    await expect(backupOnce(source)).rejects.toThrow('configuration')
    expect(fixture.spawn).not.toHaveBeenCalled()
    vi.stubEnv('RESTIC_REPOSITORY', join(directory, 'new-repository'))
    await initializeBackup()
    expect(commandsRun()).toEqual(['init'])
  })

  it('rejects relative repositories and passwords stored inside the repository, including symlinks', async () => {
    vi.stubEnv('RESTIC_REPOSITORY', 'relative-path')
    await expect(backupOnce(source)).rejects.toThrow('configuration')
    vi.stubEnv('RESTIC_REPOSITORY', repository)
    await writeFile(join(repository, 'unsafe-password'), 'synthetic')
    const link = join(directory, 'password-link')
    await symlink(join(repository, 'unsafe-password'), link)
    vi.stubEnv('RESTIC_PASSWORD_FILE', link)
    await expect(backupOnce(source)).rejects.toThrow('configuration')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('does not start commands when the durable operation record cannot be created', async () => {
    sourceQuery.mockRejectedValueOnce(new Error(secret))
    await expect(backupOnce(source)).rejects.toThrow('no operation started')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'times out the process group, escalates, and awaits close before rejecting',
    async () => {
      scripts.set(
        'backup',
        String.raw`process.on('SIGTERM',()=>process.stdout.write('term\n'));process.stdout.write('ready\n');setInterval(()=>{},1000)`
      )
      vi.useFakeTimers()
      const spawned = new Promise<ChildProcessWithoutNullStreams>(resolve => {
        onSpawn = resolve
      })
      const operation = backupOnce(source).catch(error => error as Error)
      const child = await spawned
      await new Promise(resolve => child.stdout.once('data', resolve))
      const term = new Promise(resolve => child.stdout.once('data', resolve))
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      await term
      expect(child.signalCode).toBeNull()
      await vi.advanceTimersByTimeAsync(5000)
      expect(String(await operation)).toContain('Backup failed')
      expect(child.signalCode).toBe('SIGKILL')
      expect(commandsRun()).toEqual(['backup'])
    }
  )
})

describe('new-database restore boundary', () => {
  it('streams verified backup bytes, migrates, revokes sessions, blocks stale generation, and applies retention', async () => {
    const result = await restoreBackup(source, snapshotId, { targetDatabase: 'specvoice_restore_fixture' })
    expect(result).toMatchObject({
      database: 'specvoice_restore_fixture',
      snapshotId,
      drill: false,
      sessions: 2,
      events: 205,
    })
    expect(commandsRun()).toEqual(['check', 'dump', 'pg_restore'])
    expect(fixture.spawn.mock.calls[0][1]).toEqual(['check', '--read-data'])
    expect(fixture.spawn.mock.calls[1][1]).toEqual(['dump', snapshotId, '/specvoice.dump'])
    expect(fixture.spawn.mock.calls[2][1]).toEqual([
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
      '--dbname',
      'specvoice_restore_fixture',
    ])
    expect(fixture.spawn.mock.calls[2][2].env.PGDATABASE).toBe('specvoice_restore_fixture')
    expect(fixture.createPool).toHaveBeenCalledWith(expect.stringContaining('/specvoice_restore_fixture?'))
    expect(fixture.migrate).toHaveBeenCalledWith(restored)
    expect(restoredQuery).toHaveBeenCalledWith('DELETE FROM operator_sessions')
    expect(restoredQuery).toHaveBeenCalledWith(
      expect.stringContaining("phase = CASE WHEN phase = 'queued' THEN 'generating'")
    )
    expect(restoredQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE status IN ('queued', 'running', 'needs_reconciliation')")
    )
    expect(fixture.retention).toHaveBeenCalledWith(restored)
    expect(end).toHaveBeenCalledOnce()
    expect(sourceQuery.mock.calls.some(([sql]) => sql.startsWith('DROP DATABASE'))).toBe(false)
    expect(finishDetails().at(-1)?.[1]).toEqual(['1', 'complete', result])
  })

  it.each(['postgres', 'specvoice', 'specvoice_restore_bad";DROP DATABASE specvoice;--', 'specvoice_restore_'])(
    'rejects unsafe target %s before any work',
    async targetDatabase => {
      await expect(restoreBackup(source, 'latest', { targetDatabase })).rejects.toThrow('new specvoice_restore_')
      expect(sourceQuery).not.toHaveBeenCalled()
      expect(fixture.spawn).not.toHaveBeenCalled()
    }
  )

  it.each(['--latest', 'other-backup', '../snapshot', 'abc'])(
    'rejects unsafe snapshot %s before any work',
    async snapshot => {
      await expect(restoreBackup(source, snapshot, { drill: true })).rejects.toThrow('hexadecimal snapshot')
      expect(sourceQuery).not.toHaveBeenCalled()
      expect(fixture.spawn).not.toHaveBeenCalled()
    }
  )

  it('never overwrites or drops an existing database, even during a drill', async () => {
    existing = true
    await expect(
      restoreBackup(source, 'latest', { drill: true, targetDatabase: 'specvoice_restore_existing' })
    ).rejects.toThrow('existing databases unchanged')
    expect(sourceQuery.mock.calls.some(([sql]) => /^(CREATE|DROP) DATABASE/.test(sql))).toBe(false)
    expect(commandsRun()).toEqual(['check'])
  })

  it('does not drop a target if another process wins the creation race', async () => {
    sourceQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('INSERT')) return { rows: [{ id: '1' }], rowCount: 1 }
      if (sql.startsWith('CREATE DATABASE')) throw new Error('duplicate database')
      return { rows: [], rowCount: 0 }
    })
    await expect(restoreBackup(source, 'latest', { drill: true })).rejects.toThrow('existing databases unchanged')
    expect(sourceQuery.mock.calls.some(([sql]) => sql.startsWith('DROP DATABASE'))).toBe(false)
  })

  it('always removes only its newly created drill database after failed identity checks', async () => {
    invalid = '1'
    await expect(restoreBackup(source, 'latest', { drill: true })).rejects.toThrow('identity integrity')
    const create = sourceQuery.mock.calls.find(([sql]) => sql.startsWith('CREATE DATABASE'))![0]
    const target = create.match(/"([^"]+)"/)![1]
    expect(target).toMatch(/^specvoice_drill_[a-z0-9_]+$/)
    expect(sourceQuery).toHaveBeenCalledWith(`DROP DATABASE "${target}"`)
    expect(end).toHaveBeenCalledOnce()
    expect(finishDetails().at(-1)?.[1][1]).toBe('failed')
  })

  it('cleans a failed restore stream before dropping the newly created drill', async () => {
    scripts.set('pg_restore', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(1))')
    await expect(restoreBackup(source, 'latest', { drill: true })).rejects.toThrow('Restore failed (restore)')
    expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true)
    expect(sourceQuery.mock.calls.some(([sql]) => sql.startsWith('DROP DATABASE'))).toBe(true)
    expect(fixture.migrate).not.toHaveBeenCalled()
  })

  it('attempts drill deletion even when ending its restored pool fails', async () => {
    end.mockRejectedValueOnce(new Error(secret))
    await expect(restoreBackup(source, 'latest', { drill: true })).rejects.toThrow('cleanup failed')
    expect(sourceQuery.mock.calls.some(([sql]) => sql.startsWith('DROP DATABASE'))).toBe(true)
    expect(finishDetails().at(-1)?.[1]).toEqual(['1', 'failed', expect.objectContaining({ stage: 'cleanup' })])
  })
})
