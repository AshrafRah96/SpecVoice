import { hostname } from 'node:os'
import { runtimePool } from '@/lib/db/postgres'
import { workerReady } from '@/lib/jobs/health'

async function main() {
  const pool = runtimePool()
  try {
    if (!(await workerReady(pool, hostname()))) process.exitCode = 1
  } finally {
    await pool.end()
  }
}
void main().catch(() => {
  process.exitCode = 1
})
