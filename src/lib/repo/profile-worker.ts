import { resolveCodeSource } from '@/lib/code'
import { profileRepository, repositoryCommitSha } from './profile'
import type { RepositorySnapshotStore } from './snapshot-store'
import type { SessionRepository } from '@/lib/session/repository'

export async function processNextProfile(
  snapshots: RepositorySnapshotStore,
  sessions: SessionRepository,
  signal?: AbortSignal
): Promise<boolean> {
  signal?.throwIfAborted()
  const snapshot = await snapshots.claimPending()
  if (!snapshot) return false
  try {
    const session = await sessions.getSession(snapshot.sessionId)
    if (!session) throw new Error(`Session not found: ${snapshot.sessionId}`)
    let pinnedSession = session
    let source = resolveCodeSource(pinnedSession)
    const sha = snapshot.repositorySha ?? pinnedSession.repositorySha ?? (await repositoryCommitSha(source, signal))
    if (pinnedSession.repositorySha && pinnedSession.repositorySha !== sha)
      throw new Error('Repository Snapshot does not match the pinned commit')
    if (!pinnedSession.repositorySha) {
      pinnedSession = await sessions.updateSession(session.id, { repositorySha: sha })
      source = resolveCodeSource(pinnedSession)
    }
    const profile = await profileRepository(source, sha, undefined, undefined, { signal })
    signal?.throwIfAborted()
    await snapshots.saveProfile(snapshot.id, profile, snapshot.profileLease)
  } catch (error) {
    if (signal?.aborted) return false
    // A failed profile is durable through the existing snapshot record; keep the
    // failure visible to the user instead of retrying an unbounded scan.
    const failed = {
      ...(snapshot.profile ?? {
        repositorySha: snapshot.repositorySha ?? '',
        fileCount: 0,
        byteCount: 0,
        languages: {},
        packages: [],
        generatedRoots: [],
        vendorRoots: [],
        treeComplete: false,
        tier: 'very-large' as const,
        profiledAt: new Date().toISOString(),
      }),
      error: error instanceof Error ? error.message : 'Repository profiling failed',
      indexStatus: 'failed' as const,
      profiledAt: new Date().toISOString(),
    }
    await snapshots.saveProfile(snapshot.id, failed, snapshot.profileLease)
    console.error(`[profile] failed for ${snapshot.sessionId}`, error instanceof Error ? error.message : error)
  }
  return true
}
