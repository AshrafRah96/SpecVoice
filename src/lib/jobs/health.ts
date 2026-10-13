import type { Pool } from 'pg'

export async function workerHeartbeat(pool: Pool, id: string, state: 'running' | 'stopping' = 'running') {
  await pool.query(
    'INSERT INTO worker_heartbeats (id, state) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET state = $2, heartbeat_at = clock_timestamp()',
    [id, state]
  )
}

export async function workerReady(pool: Pool, id?: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT id FROM worker_heartbeats WHERE ($1::text IS NULL OR id = $1) AND state = 'running' AND heartbeat_at > clock_timestamp() - interval '15 seconds' LIMIT 1",
    [id ?? null]
  )
  return Boolean(result.rowCount)
}
