'use client'
import { useEffect, useRef, useState } from 'react'
import type { RepositorySnapshot } from '@/lib/session/types'
import type { UseSessionReturn } from './hooks/useSession'
import { Button } from './ui/button'

export function ScopeControls({
  snapshot,
  changeScope,
  retryProfile,
}: Pick<UseSessionReturn, 'snapshot' | 'changeScope' | 'retryProfile'>) {
  const [included, setIncluded] = useState('')
  const [excluded, setExcluded] = useState('')
  const [busy, setBusy] = useState(false)
  const plan = snapshot?.scopePlan
  const loadedPlan = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (loadedPlan.current === plan?.id) return
    loadedPlan.current = plan?.id
    setIncluded(plan?.includedRoots.join('\n') ?? '')
    setExcluded(plan?.excludedRoots.join('\n') ?? '')
  }, [plan]) // A refreshed profile must not overwrite an unfinished edit.
  const split = (text: string) =>
    text
      .split('\n')
      .map(path => path.trim())
      .filter(Boolean)
  const perform = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }
  const dirty =
    split(included).join('\n') !== (plan?.includedRoots.join('\n') ?? '') ||
    split(excluded).join('\n') !== (plan?.excludedRoots.join('\n') ?? '')
  const ready = snapshot && ['ready', 'partial'].includes(snapshot.indexStatus)
  return (
    <section className="p-5 border-t border-border/50 text-xs flex flex-col gap-3" aria-label="Repository scope">
      <h2 className="font-semibold">Repository Profile</h2>
      <p data-testid="profile-status">{snapshot?.indexStatus ?? 'pending'}</p>
      {snapshot?.repositorySha && <p className="font-mono break-all">Commit: {snapshot.repositorySha}</p>}
      {snapshot?.profile && (
        <p>
          {snapshot.profile.tier} · {snapshot.profile.treeComplete ? '' : 'At least '}
          {snapshot.profile.fileCount} files · {snapshot.profile.byteCount} bytes
        </p>
      )}
      {snapshot?.profile?.error && <p role="alert">{snapshot.profile.error}</p>}
      {snapshot?.indexStatus === 'expired' && (
        <p>Inventory expired. Rebuild it at the saved commit; your Scope Plan is retained.</p>
      )}
      {(snapshot?.indexStatus === 'failed' || snapshot?.indexStatus === 'expired') && (
        <Button disabled={busy} onClick={() => perform(retryProfile)}>
          {snapshot.indexStatus === 'expired' ? 'Rebuild profile' : 'Retry profiling'}
        </Button>
      )}
      {ready && (
        <>
          <p>
            Discuss within discovery limits. Confirm scope before building larger or partially profiled repositories.
          </p>
          {snapshot.profile?.packages.length !== 0 && (
            <p>Packages: {snapshot.profile?.packages.map(item => item.path || '(root)').join(', ')}</p>
          )}
          <label className="flex flex-col gap-1">
            Included paths, one per line
            <textarea
              aria-label="Included paths"
              value={included}
              onChange={event => setIncluded(event.target.value)}
              className="rounded border border-input bg-muted p-2 font-mono"
            />
          </label>
          <label className="flex flex-col gap-1">
            Excluded paths, one per line
            <textarea
              aria-label="Excluded paths"
              value={excluded}
              onChange={event => setExcluded(event.target.value)}
              className="rounded border border-input bg-muted p-2 font-mono"
            />
          </label>
          <Button
            disabled={busy}
            onClick={() =>
              perform(() => changeScope({ includedRoots: split(included), excludedRoots: split(excluded) }))
            }
          >
            Save Scope Plan
          </Button>
          {plan && (
            <p data-testid="scope-status">
              Scope: {plan.status} · {plan.estimatedFiles} files
            </p>
          )}
          {dirty && <p>Save changed paths before confirming the Scope Plan.</p>}
          {plan?.status === 'proposed' && (
            <Button
              disabled={busy || dirty}
              onClick={() => perform(() => changeScope({ confirm: true, planId: plan.id }))}
            >
              Confirm Scope Plan
            </Button>
          )}
        </>
      )}
    </section>
  )
}

export function canDiscuss(snapshot: RepositorySnapshot | null): boolean {
  return !!snapshot && ['ready', 'partial'].includes(snapshot.indexStatus)
}
