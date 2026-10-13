import { runtimePool } from '@/lib/db/postgres'
import { sessionStore } from './store'
import { PostgresSessionRepository } from './postgres-repository'
import { createHotReloadSafeSingleton } from '@/lib/singleton'

export function getSessionRepository() {
  if (!process.env.DATABASE_URL) return sessionStore
  return createHotReloadSafeSingleton('__postgresSessionRepository', () => new PostgresSessionRepository(runtimePool()))
}
