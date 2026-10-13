import { runtimePool } from '@/lib/db/postgres'

async function main() {
  const pool = runtimePool()
  try {
    // Aggregates contain no transcript, prompt, repository content or credentials.
    const [workers, builds, receipts, models, backups] = await Promise.all([
      pool.query(
        "SELECT id, state, heartbeat_at, state = 'running' AND heartbeat_at > now() - interval '15 seconds' AS healthy FROM worker_heartbeats ORDER BY heartbeat_at DESC"
      ),
      pool.query('SELECT status, count(*)::int AS count FROM build_attempts GROUP BY status ORDER BY status'),
      pool.query('SELECT status, count(*)::int AS count FROM post_call_jobs GROUP BY status ORDER BY status'),
      pool.query(
        "SELECT count(*)::int AS requests, coalesce(sum(charged_usd), 0) AS estimated_usd, count(*) FILTER (WHERE status = 'unknown')::int AS unknown_usage, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms FROM model_requests WHERE created_at > now() - interval '24 hours'"
      ),
      pool.query(
        'SELECT DISTINCT ON (kind) kind, status, started_at, finished_at, detail FROM operational_runs ORDER BY kind, started_at DESC'
      ),
    ])
    console.log(
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          workers: workers.rows,
          builds: builds.rows,
          receipts: receipts.rows,
          modelsLast24Hours: models.rows[0],
          latestOperations: backups.rows,
        },
        null,
        2
      )
    )
  } finally {
    await pool.end()
  }
}

void main().catch(() => {
  console.error('Operational status unavailable. Check PostgreSQL connectivity and migrations.')
  process.exitCode = 1
})
