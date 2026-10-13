import { runtimePool } from '@/lib/db/postgres'
import { migrate } from '@/lib/db/migrate'
import { runRetention } from '@/lib/session/retention'

const pool = runtimePool()
void migrate(pool)
  .then(() => runRetention(pool))
  .then(() => {
    console.log('Retention applied; planning records and active Build inputs preserved.')
  })
  .catch(() => {
    console.error('Retention failed; check database configuration and migrations.')
    process.exitCode = 1
  })
  .finally(() => pool.end())
