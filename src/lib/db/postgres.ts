import { Pool, type PoolClient } from 'pg'
import { createHotReloadSafeSingleton } from '@/lib/singleton'

export function runtimePool(): Pool {
  const url = process.env.DATABASE_URL
  if (!url) throw new StorageUnavailable()
  return createHotReloadSafeSingleton('__runtimePool', () => createPool(url))
}

export class StorageUnavailable extends Error {
  constructor() {
    super('Session storage unavailable. Check PostgreSQL and run database migrations.')
  }
}

export function createPool(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 3000, statement_timeout: 10000 })
  pool.on('error', () => console.error('[database] idle connection failed'))
  return pool
}

export async function database<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch {
    // Connection diagnostics can contain credentials; never return raw driver errors.
    throw new StorageUnavailable()
  }
}

export async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database(() => pool.connect())
  try {
    await database(() => client.query('BEGIN'))
    const result = await operation(client)
    await database(() => client.query('COMMIT'))
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
