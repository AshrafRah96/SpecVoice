import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import type { Pool } from 'pg'
import { runtimePool } from '@/lib/db/postgres'
import { migrate } from '@/lib/db/migrate'
import { backupOnce, initializeBackup, restoreBackup } from '@/lib/ops/backups'

/** A missing mount must fail closed, rather than silently backing up onto the host disk. */
export async function requireBackupVolume() {
  const expected = process.env.SPECVOICE_BACKUP_VOLUME_ID
  const marker = await readFile('/backup/.specvoice-backup-volume', 'utf8')
  if (!expected || marker.trim() !== expected) throw new Error('Configured backup volume is not mounted')
}

async function due(pool: Pool, kind: 'backup' | 'restore_drill', days: number) {
  const result = await pool.query<{ due: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM operational_runs WHERE kind=$1 AND
      (status='complete' AND finished_at > clock_timestamp()-($2 * interval '1 day')
       OR status IN ('running','failed') AND started_at > clock_timestamp()-interval '1 hour')) AS due`,
    [kind, days]
  )
  return result.rows[0].due
}

async function schedule(pool: Pool, signal: AbortSignal) {
  while (!signal.aborted) {
    const lock = await pool.connect()
    try {
      const held = await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(78234002) AS locked')
      if (held.rows[0].locked) {
        await requireBackupVolume()
        if (await due(pool, 'backup', 1)) await backupOnce(pool)
        if (!signal.aborted && (await due(pool, 'restore_drill', 7)))
          await restoreBackup(pool, 'latest', { drill: true })
      }
    } catch {
      console.error('Scheduled backup or restore drill failed; inspect operational_runs and local configuration.')
    } finally {
      await lock.query('SELECT pg_advisory_unlock(78234002)').catch(() => {})
      lock.release()
    }
    await wait(60000, undefined, { signal }).catch(() => {})
  }
}

export async function main() {
  const command = process.argv[2]
  if (!['init', 'once', 'drill', 'restore', 'schedule'].includes(command ?? ''))
    throw new Error('Usage: backup init|once|drill|restore <snapshot> <new-database>|schedule')
  await requireBackupVolume()
  if (command === 'init') return initializeBackup()
  const pool = runtimePool()
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    await migrate(pool)
    if (command === 'once') console.log(JSON.stringify(await backupOnce(pool)))
    else if (command === 'drill') console.log(JSON.stringify(await restoreBackup(pool, 'latest', { drill: true })))
    else if (command === 'restore') {
      if (!process.argv[3] || !process.argv[4]) throw new Error('Restore requires a snapshot and a new database name')
      console.log(JSON.stringify(await restoreBackup(pool, process.argv[3], { targetDatabase: process.argv[4] })))
    } else await schedule(pool, controller.signal)
  } finally {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    console.error(
      'Backup operation failed. Check the mounted volume, recovery password, database and operational_runs.'
    )
    process.exitCode = 1
  })
