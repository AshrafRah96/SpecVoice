'use client'

import type { BuildPhase } from '@/lib/session/types'
import type { BuildLogEntry } from '@/components/hooks/useSession'

interface Props {
  entries: BuildLogEntry[]
  isBuilding: boolean
}

// Record<BuildPhase, ...> enforces exhaustiveness — any new BuildPhase value causes a compile error here
const PHASE_COLORS: Record<BuildPhase, string> = {
  analyzing: 'text-foreground',
  writing:   'text-success',
  reviewing: 'text-warning',
  cloning:   'text-muted-foreground',
  pr:        'text-success',
}

export function BuildProgress({ entries, isBuilding }: Props) {
  return (
    <div className="flex flex-col gap-1 font-mono text-xs">
      {entries.map((entry, i) => (
        <div key={`${entry.timestamp}-${i}`} className="animate-fadeIn">
          <span className="text-muted-foreground">{'> '}</span>
          <span className={PHASE_COLORS[entry.phase]}>[{entry.phase}]</span>
          <span className="text-foreground/70 ml-1">{entry.detail}</span>
        </div>
      ))}
      {isBuilding && (
        <div className="text-muted-foreground">
          {'> '}<span className="animate-pulse">_</span>
        </div>
      )}
    </div>
  )
}
