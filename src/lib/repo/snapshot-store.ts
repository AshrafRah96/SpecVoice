import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createHotReloadSafeSingleton } from '@/lib/singleton'
import { runtimePool, database, transaction } from '@/lib/db/postgres'
import type { Session, RepositoryProfile, RepositorySnapshot, ScopePlan } from '@/lib/session/types'

export interface RepositorySnapshotStore {
  ensureForSession(session: Session, repositorySha?: string): Promise<RepositorySnapshot>
  getForSession(sessionId: string): Promise<RepositorySnapshot | undefined>
  proposeScope(sessionId: string, plan: Omit<ScopePlan, 'id' | 'createdAt' | 'status'>): Promise<ScopePlan>
  confirmScope(
    sessionId: string,
    planId: string,
    counts?: { estimatedFiles: number; estimatedBytes: number }
  ): Promise<ScopePlan | undefined>
  claimPending(): Promise<RepositorySnapshot | undefined>
  saveProfile(snapshotId: string, profile: RepositoryProfile, lease?: string): Promise<void>
  retryProfile(sessionId: string): Promise<void>
}

function snapshotFor(session: Session, repositorySha: string | null = null, id = randomUUID()): RepositorySnapshot {
  const now = new Date().toISOString()
  return {
    id,
    sessionId: session.id,
    source: { repoUrl: session.repoUrl, repoLocalPath: session.repoLocalPath },
    repositorySha,
    indexStatus: 'pending',
    profile: null,
    scopePlan: null,
    createdAt: now,
    updatedAt: now,
  }
}

class MemoryRepositorySnapshotStore implements RepositorySnapshotStore {
  private snapshots = new Map<string, RepositorySnapshot>()

  async ensureForSession(session: Session, repositorySha?: string) {
    const existing = [...this.snapshots.values()].find(snapshot => snapshot.sessionId === session.id)
    if (existing) {
      if (repositorySha && !existing.repositorySha) {
        existing.repositorySha = repositorySha
        existing.updatedAt = new Date().toISOString()
      }
      return existing
    }
    const snapshot = snapshotFor(session, repositorySha ?? null)
    this.snapshots.set(snapshot.id, snapshot)
    return snapshot
  }

  async getForSession(sessionId: string) {
    return [...this.snapshots.values()].find(snapshot => snapshot.sessionId === sessionId)
  }

  async proposeScope(sessionId: string, plan: Omit<ScopePlan, 'id' | 'createdAt' | 'status'>) {
    const snapshot = await this.getRequired(sessionId)
    const scopePlan: ScopePlan = { ...plan, id: randomUUID(), createdAt: new Date().toISOString(), status: 'proposed' }
    snapshot.scopePlan = scopePlan
    snapshot.updatedAt = new Date().toISOString()
    return scopePlan
  }

  async confirmScope(sessionId: string, planId: string, counts?: { estimatedFiles: number; estimatedBytes: number }) {
    const snapshot = await this.getForSession(sessionId)
    if (!snapshot?.scopePlan || snapshot.scopePlan.id !== planId) return undefined
    snapshot.scopePlan = {
      ...snapshot.scopePlan,
      ...counts,
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
    }
    snapshot.updatedAt = new Date().toISOString()
    return snapshot.scopePlan
  }

  async claimPending() {
    const now = Date.now()
    const snapshot = [...this.snapshots.values()].find(item => {
      if (item.indexStatus === 'indexing' && now - Date.parse(item.updatedAt) > 5 * 60_000) {
        item.indexStatus = 'pending'
      }
      return item.indexStatus === 'pending'
    })
    if (!snapshot) return undefined
    snapshot.profileLease = randomUUID()
    snapshot.indexStatus = 'indexing'
    snapshot.updatedAt = new Date().toISOString()
    return structuredClone(snapshot)
  }

  async saveProfile(snapshotId: string, profile: RepositoryProfile, lease?: string) {
    const snapshot = this.snapshots.get(snapshotId)
    if (!snapshot) throw new Error(`Repository snapshot not found: ${snapshotId}`)
    if (snapshot.profileLease !== lease) throw new Error('Repository profile lease lost')
    if (snapshot.repositorySha && snapshot.repositorySha !== profile.repositorySha)
      throw new Error('Repository profile cannot change the pinned commit')
    snapshot.repositorySha = profile.repositorySha
    snapshot.profile = profile
    snapshot.indexStatus = profile.indexStatus
    snapshot.updatedAt = new Date().toISOString()
  }

  async retryProfile(sessionId: string) {
    const snapshot = await this.getRequired(sessionId)
    if (snapshot.indexStatus === 'failed' || snapshot.indexStatus === 'expired') {
      snapshot.indexStatus = 'pending'
      snapshot.profileLease = undefined
    }
  }

  private async getRequired(sessionId: string) {
    const snapshot = await this.getForSession(sessionId)
    if (!snapshot) throw new Error(`Repository snapshot not found for session: ${sessionId}`)
    return snapshot
  }
}

export class PostgresRepositorySnapshotStore implements RepositorySnapshotStore {
  constructor(private readonly pool: Pool) {}

  async ensureForSession(session: Session, repositorySha?: string) {
    const existing = await database(() =>
      this.pool.query<{ data: RepositorySnapshot }>('SELECT data FROM repo_snapshots WHERE session_id = $1', [
        session.id,
      ])
    )
    if (existing.rows[0]) {
      const data = existing.rows[0].data
      if (repositorySha && !data.repositorySha) {
        const updated = {
          ...data,
          repositorySha,
          source: { repoUrl: session.repoUrl, repoLocalPath: session.repoLocalPath },
        }
        await database(() =>
          this.pool.query(
            'UPDATE repo_snapshots SET repository_sha = $2, source = $3, data = $4, updated_at = now() WHERE session_id = $1',
            [session.id, repositorySha, updated.source, updated]
          )
        )
        return updated
      }
      return data
    }
    const snapshot = snapshotFor(session, repositorySha ?? null)
    await database(() =>
      this.pool.query(
        'INSERT INTO repo_snapshots (id, session_id, source, repository_sha, index_status, data) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (session_id) DO NOTHING',
        [snapshot.id, session.id, snapshot.source, snapshot.repositorySha, snapshot.indexStatus, snapshot]
      )
    )
    const created = await database(() =>
      this.pool.query<{ data: RepositorySnapshot }>('SELECT data FROM repo_snapshots WHERE session_id = $1', [
        session.id,
      ])
    )
    return created.rows[0]?.data ?? snapshot
  }

  async getForSession(sessionId: string) {
    const result = await database(() =>
      this.pool.query<{ data: RepositorySnapshot }>('SELECT data FROM repo_snapshots WHERE session_id = $1', [
        sessionId,
      ])
    )
    return result.rows[0]?.data
  }

  async proposeScope(sessionId: string, plan: Omit<ScopePlan, 'id' | 'createdAt' | 'status'>) {
    return transaction(this.pool, async client => {
      const row = await client.query<{ data: RepositorySnapshot }>(
        'SELECT data FROM repo_snapshots WHERE session_id = $1 FOR UPDATE',
        [sessionId]
      )
      const snapshot = row.rows[0]?.data
      if (!snapshot) throw new Error(`Repository snapshot not found for session: ${sessionId}`)
      const scopePlan: ScopePlan = {
        ...plan,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        status: 'proposed',
      }
      const updated = { ...snapshot, scopePlan, updatedAt: new Date().toISOString() }
      await client.query('UPDATE repo_snapshots SET data = $2, updated_at = now() WHERE session_id = $1', [
        sessionId,
        updated,
      ])
      await client.query('INSERT INTO scope_plans (id, snapshot_id, data, status) VALUES ($1, $2, $3, $4)', [
        scopePlan.id,
        snapshot.id,
        scopePlan,
        scopePlan.status,
      ])
      return scopePlan
    })
  }

  async confirmScope(sessionId: string, planId: string, counts?: { estimatedFiles: number; estimatedBytes: number }) {
    return transaction(this.pool, async client => {
      const row = await client.query<{ data: RepositorySnapshot }>(
        'SELECT data FROM repo_snapshots WHERE session_id = $1 FOR UPDATE',
        [sessionId]
      )
      const snapshot = row.rows[0]?.data
      if (!snapshot?.scopePlan || snapshot.scopePlan.id !== planId) return undefined
      const scopePlan = {
        ...snapshot.scopePlan,
        ...counts,
        status: 'confirmed' as const,
        confirmedAt: new Date().toISOString(),
      }
      const updated = { ...snapshot, scopePlan, updatedAt: new Date().toISOString() }
      await client.query('UPDATE repo_snapshots SET data = $2, updated_at = now() WHERE session_id = $1', [
        sessionId,
        updated,
      ])
      await client.query('UPDATE scope_plans SET data = $2, status = $3, confirmed_at = now() WHERE id = $1', [
        planId,
        scopePlan,
        'confirmed',
      ])
      return scopePlan
    })
  }

  async claimPending() {
    return transaction(this.pool, async client => {
      // Reclaim a profile whose worker died before saving its result.
      await client.query(
        "UPDATE repo_snapshots SET index_status = 'pending', data = jsonb_set(data, '{indexStatus}', to_jsonb('pending'::text)), updated_at = now() WHERE index_status = 'indexing' AND updated_at < now() - interval '5 minutes'"
      )
      const result = await client.query<{ id: string; data: RepositorySnapshot }>(
        "SELECT id, data FROM repo_snapshots WHERE index_status = 'pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1"
      )
      const row = result.rows[0]
      if (!row) return undefined
      const data = {
        ...row.data,
        profileLease: randomUUID(),
        indexStatus: 'indexing' as const,
        updatedAt: new Date().toISOString(),
      }
      await client.query(
        "UPDATE repo_snapshots SET data = $2, index_status = 'indexing', updated_at = now() WHERE id = $1",
        [row.id, data]
      )
      return data
    })
  }

  async retryProfile(sessionId: string) {
    await database(() =>
      this.pool.query(
        "UPDATE repo_snapshots SET index_status = 'pending', data = jsonb_set(data - 'profileLease', '{indexStatus}', '\"pending\"'), updated_at = now() WHERE session_id = $1 AND index_status IN ('failed', 'expired')",
        [sessionId]
      )
    )
  }

  async saveProfile(snapshotId: string, profile: RepositoryProfile, lease?: string) {
    await transaction(this.pool, async client => {
      const existing = await client.query<{ data: RepositorySnapshot }>(
        'SELECT data FROM repo_snapshots WHERE id = $1 FOR UPDATE',
        [snapshotId]
      )
      if (!existing.rows[0]) throw new Error(`Repository snapshot not found: ${snapshotId}`)
      if (existing.rows[0].data.profileLease !== lease) throw new Error('Repository profile lease lost')
      if (existing.rows[0].data.repositorySha && existing.rows[0].data.repositorySha !== profile.repositorySha)
        throw new Error('Repository profile cannot change the pinned commit')
      const data = {
        ...existing.rows[0].data,
        repositorySha: profile.repositorySha,
        profile,
        indexStatus: profile.indexStatus,
        updatedAt: new Date().toISOString(),
      }
      await client.query(
        'UPDATE repo_snapshots SET repository_sha = $2, index_status = $3, data = $4, updated_at = now() WHERE id = $1',
        [snapshotId, profile.repositorySha, profile.indexStatus, data]
      )
    })
  }
}

export function getRepositorySnapshotStore(): RepositorySnapshotStore {
  if (process.env.DATABASE_URL) {
    return createHotReloadSafeSingleton(
      '__repositorySnapshotStore',
      () => new PostgresRepositorySnapshotStore(runtimePool())
    )
  }
  return createHotReloadSafeSingleton('__memoryRepositorySnapshotStore', () => new MemoryRepositorySnapshotStore())
}
