import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { transaction } from './postgres'

export async function migrate(pool: Pool, directory = join(process.cwd(), 'migrations')) {
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(78234001)')
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())'
    )
    const files = (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()
    for (const name of files) {
      const sql = await readFile(join(directory, name), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      const existing = await client.query('SELECT checksum FROM schema_migrations WHERE name = $1', [name])
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`)
        continue
      }
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum])
    }
  })
}
