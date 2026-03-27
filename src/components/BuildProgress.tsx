'use client'

import type { BuildPhase } from '@/lib/session/types'
import type { BuildLogEntry } from '@/components/hooks/useSession'

interface Props {
  entries: BuildLogEntry[]
  isBuilding: boolean
}

// Record<BuildPhase, ...> enforces exhaustiveness — any new BuildPhase value will cause a compile error here
const PHASE_LABELS: Record<BuildPhase, string> = {
  analyzing: 'Analyzing',
  writing: 'Writing',
  reviewing: 'Reviewing',
  cloning: 'Cloning',
  pr: 'Pull Request',
}

const PHASE_COLORS: Record<BuildPhase, string> = {
  analyzing: '#6c47ff',
  writing: '#22c55e',
  reviewing: '#f59e0b',
  cloning: '#3b82f6',
  pr: '#ec4899',
}

export function BuildProgress({ entries, isBuilding }: Props) {
  return (
    <div className="flex flex-col gap-0">
      {entries.map((entry, i) => (
        <div key={`${entry.timestamp}-${i}`} className="flex gap-3 animate-fadeIn">
          {/* Timeline spine */}
          <div className="flex flex-col items-center">
            <div
              className="w-2 h-2 rounded-full mt-1 flex-none"
              style={{ background: PHASE_COLORS[entry.phase] }}
            />
            {i < entries.length - 1 && (
              <div className="w-px flex-1 mt-1" style={{ background: '#1a1a2e' }} />
            )}
          </div>
          {/* Content */}
          <div className="pb-3 flex-1">
            <span
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: PHASE_COLORS[entry.phase] }}
            >
              {PHASE_LABELS[entry.phase]}
            </span>
            <p className="text-xs mt-0.5" style={{ color: '#e5e5e5' }}>{entry.detail}</p>
          </div>
        </div>
      ))}

      {isBuilding && (
        <div className="flex gap-3">
          <div className="flex flex-col items-center">
            <div className="w-2 h-2 rounded-full mt-1 animate-pulse" style={{ background: '#888' }} />
          </div>
          <p className="text-xs pb-3" style={{ color: '#888' }}>Working…</p>
        </div>
      )}
    </div>
  )
}
