import type { RepositorySnapshot } from '@/lib/session/types'

export function buildReadiness(snapshot: RepositorySnapshot | null | undefined, sha?: string | null): string | null {
  if (snapshot?.indexStatus === 'expired')
    return 'Repository Profile expired. Rebuild it at the saved commit before building.'
  if (!snapshot?.profile) return 'Repository Profile is still being prepared.'
  if (snapshot.indexStatus === 'failed') return 'Repository Profile failed. Retry profiling before building.'
  if (!['ready', 'partial'].includes(snapshot.indexStatus)) return 'Repository Profile is still being prepared.'
  if (!sha || snapshot.repositorySha !== sha) return 'Repository Snapshot does not match the pinned commit.'
  const plan = snapshot.scopePlan
  if (plan && (plan.status !== 'confirmed' || plan.repositorySha !== sha))
    return 'Confirm the current Scope Plan before building.'
  if ((snapshot.profile.tier !== 'small' || !snapshot.profile.treeComplete) && !plan)
    return 'A confirmed Scope Plan is required before building this repository.'
  return null
}
