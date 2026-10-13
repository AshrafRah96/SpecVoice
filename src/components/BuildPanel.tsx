'use client'

import type { Session } from '@/lib/session/types'
import type { BuildLogEntry } from '@/components/hooks/useSession'
import { BuildProgress } from '@/components/BuildProgress'
import { Button } from '@/components/ui/button'
import { LiveWaveform } from '@/components/ui/LiveWaveform'

interface Props {
  session: Session | null
  buildLog: BuildLogEntry[]
  onTriggerBuild: () => Promise<void>
  error: string | null
  readiness: string | null
  onRecoverBuild: () => Promise<void>
}

function groupLabel(group: string[]): string {
  if (group.length === 0) return '(empty)'
  const dir = group[0].includes('/') ? group[0].split('/')[0] : '(root)'
  return `${dir}/: ${group.length} file${group.length !== 1 ? 's' : ''}`
}

export function BuildPanel({ session, buildLog, onTriggerBuild, onRecoverBuild, readiness, error }: Props) {
  if (!session) return null

  const { buildStatus, prUrl, complexityAssessment } = session

  return (
    <div className="p-5 flex flex-col gap-4">
      <h2 className="text-xs font-medium tracking-widest uppercase text-muted-foreground">Build</h2>

      {readiness && <p data-testid="build-readiness">{readiness}</p>}
      {/* Ready to build */}
      {buildStatus === 'ready' && (
        <Button data-testid="build-button" disabled={!!readiness} onClick={onTriggerBuild} size="lg" className="w-full">
          Build It
        </Button>
      )}

      {/* Building — waveform indicator */}
      {buildStatus === 'building' && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <LiveWaveform active bars={8} className="h-4" />
          <span>{session.buildRecovery ? 'Recovering publication…' : 'Claude Code is working…'}</span>
        </div>
      )}

      {/* Build log */}
      {(buildStatus === 'building' || buildLog.length > 0) && (
        <BuildProgress entries={buildLog} isBuilding={buildStatus === 'building'} />
      )}

      {/* Complete — PR link */}
      {buildStatus === 'complete' && prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between rounded-md px-3 py-2 text-xs font-medium border border-success/30 bg-success-muted text-success hover:bg-success-muted/80 transition-colors"
        >
          <span>View Pull Request</span>
          <span>↗</span>
        </a>
      )}

      {/* Failed */}
      {buildStatus === 'failed' && (
        <div className="flex flex-col gap-2">
          <p className="text-xs rounded-md px-3 py-2 bg-destructive-muted text-destructive border border-destructive/20">
            {error ?? 'Build failed. Check logs.'}
          </p>
          {session.buildRecovery?.retryable && (
            <Button onClick={onRecoverBuild}>Retry recovery without generation</Button>
          )}
          <Button variant="outline" size="sm" className="w-full" disabled={!!readiness} onClick={onTriggerBuild}>
            Retry Build (uses model quota)
          </Button>
        </div>
      )}

      {/* Blocked */}
      {buildStatus !== 'complete' && complexityAssessment?.blocked && (
        <div className="rounded-md p-3 text-xs flex flex-col gap-1 border border-warning/30 bg-warning/10">
          <p className="font-medium text-warning">
            {complexityAssessment.blockReason === 'open_questions'
              ? `${complexityAssessment.openQuestionCount} open question${complexityAssessment.openQuestionCount !== 1 ? 's' : ''} must be resolved`
              : `Too large to build in one pass (${complexityAssessment.fileCount} files)`}
          </p>
          {complexityAssessment.splitSuggestion && (
            <>
              <ul className="mt-1 flex flex-col gap-0.5">
                {complexityAssessment.splitSuggestion.map((group, i) => (
                  <li key={i} className="font-mono text-warning/80">
                    {groupLabel(group)}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-muted-foreground">Split into smaller PRs by directory above.</p>
            </>
          )}
        </div>
      )}

      {/* Idle */}
      {buildStatus === 'idle' && (
        <p className="text-xs text-muted-foreground">Build will be available once the spec is generated.</p>
      )}
    </div>
  )
}
