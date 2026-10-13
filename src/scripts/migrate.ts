import { createPool } from '../lib/db/postgres'
import { migrate } from '../lib/db/migrate'

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const pool = createPool(process.env.DATABASE_URL)
  try {
    await migrate(pool)
    console.log('Database migrations applied.')
  } finally {
    await pool.end()
  }
}

void main().catch(() => {
  console.error('Migration failed. Check database availability and migration checksums.')
  process.exitCode = 1
})
