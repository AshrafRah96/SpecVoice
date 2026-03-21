'use client'

import type { Session } from '@/lib/session/types'
import type { BuildLogEntry } from '@/components/hooks/useSession'
import { BuildProgress } from '@/components/BuildProgress'

interface Props {
  session: Session | null
  buildLog: BuildLogEntry[]
  onTriggerBuild: () => Promise<void>
  error: string | null
}

export function BuildPanel({ session, buildLog, onTriggerBuild, error }: Props) {
  if (!session) return null

  const { buildStatus, prUrl, complexityAssessment } = session

  return (
    <div className="p-5 flex flex-col gap-4">
      <h2 className="text-xs font-semibold tracking-widest uppercase" style={{ color: '#888' }}>
        Build
      </h2>

      {/* Ready to build */}
      {buildStatus === 'ready' && (
        <button
          onClick={onTriggerBuild}
          className="w-full rounded-lg py-3 text-sm font-semibold tracking-wide transition-all hover:opacity-90 active:scale-95"
          style={{ background: '#6c47ff', color: '#fff' }}
        >
          Build It
        </button>
      )}

      {/* Building in progress */}
      {(buildStatus === 'building' || buildLog.length > 0) && (
        <BuildProgress entries={buildLog} isBuilding={buildStatus === 'building'} />
      )}

      {/* Complete */}
      {buildStatus === 'complete' && prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between rounded p-3 text-sm font-medium transition-opacity hover:opacity-80"
          style={{ background: '#0a2a0a', border: '1px solid #1a4e1a', color: '#22c55e' }}
        >
          <span>View Pull Request</span>
          <span>↗</span>
        </a>
      )}

      {/* Failed with retry — 'failed' not 'error' per BuildStatus type */}
      {buildStatus === 'failed' && (
        <div className="flex flex-col gap-2">
          <p className="text-xs rounded p-2" style={{ background: '#2a0a0a', color: '#ef4444', border: '1px solid #4e1a1a' }}>
            {error ?? 'Build failed. Check logs.'}
          </p>
          <button
            onClick={onTriggerBuild}
            className="w-full rounded py-2 text-sm font-medium"
            style={{ background: '#1a1a2e', color: '#e5e5e5' }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Blocked — complexityAssessment.score === 'too_large' */}
      {buildStatus !== 'complete' && complexityAssessment?.score === 'too_large' && (
        <div
          className="rounded p-3 text-xs flex flex-col gap-1"
          style={{ background: '#1a1500', border: '1px solid #3a2e00', color: '#f59e0b' }}
        >
          <p className="font-semibold">Complexity: Too Large</p>
          <p style={{ color: '#888' }}>{complexityAssessment.reasoning}</p>
          {complexityAssessment.splitSuggestion && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {complexityAssessment.splitSuggestion.map(s => (
                <li key={s} className="font-mono" style={{ color: '#f59e0b' }}>{s}</li>
              ))}
            </ul>
          )}
          <p className="mt-1" style={{ color: '#888' }}>Split into smaller PRs by directory above.</p>
        </div>
      )}

      {/* Idle — waiting */}
      {buildStatus === 'idle' && (
        <p className="text-xs" style={{ color: '#444' }}>
          Build will be available once the spec is generated.
        </p>
      )}
    </div>
  )
}
