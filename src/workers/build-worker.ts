import { hostname } from 'node:os'
import { runtimePool } from '@/lib/db/postgres'
import { migrate } from '@/lib/db/migrate'
import { PostgresBuildQueue } from '@/lib/jobs/queue'
import { PostgresSessionRepository } from '@/lib/session/postgres-repository'
import { executeBuildAttempt } from '@/lib/build/attempt'
import { PostgresPostCallQueue } from '@/lib/jobs/post-call-queue'
import { PostgresRepositorySnapshotStore } from '@/lib/repo/snapshot-store'
import { processNextProfile } from '@/lib/repo/profile-worker'
import { runWorkerLoops } from '@/lib/jobs/worker-loops'
import { workerHeartbeat } from '@/lib/jobs/health'
import { runRetention } from '@/lib/session/retention'

async function main() {
  const pool = runtimePool()
  const shutdown = new AbortController()
  const stop = () => shutdown.abort(new Error('Worker stopping'))
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    await migrate(pool)
    const queue = new PostgresBuildQueue(pool)
    const postCalls = new PostgresPostCallQueue(pool)
    const snapshots = new PostgresRepositorySnapshotStore(pool)
    const sessions = new PostgresSessionRepository(pool)
    await runWorkerLoops(
      {
        build: async signal => {
          const job = await queue.claim()
          if (!job) return false
          await executeBuildAttempt(pool, job, signal)
          return true
        },
        profile: signal => processNextProfile(snapshots, sessions, signal),
        postCall: async signal => {
          const job = await postCalls.claim()
          if (!job) return false
          signal.throwIfAborted()
          try {
            await postCalls.finalize(job)
          } catch {
            await postCalls.finish(job, 'failed', 'Post-call finalization failed. Retrying with bounded backoff.')
          }
          return true
        },
        heartbeat: () => workerHeartbeat(pool, hostname()),
        maintenance: async () => {
          await runRetention(pool)
        },
        onError: lane => console.error(`[worker] ${lane} unavailable; retrying with bounded backoff`),
      },
      shutdown.signal
    )
  } finally {
    await workerHeartbeat(pool, hostname(), 'stopping').catch(() => {})
    await pool.end()
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}
void main().catch(() => {
  console.error('[worker] startup failed; check database and migrations')
  process.exitCode = 1
})
