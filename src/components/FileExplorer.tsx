'use client'

import { useMemo } from 'react'
import type { FileRead } from '@/lib/session/types'
import { LiveWaveform } from '@/components/ui/LiveWaveform'

interface Props {
  filesRead: FileRead[]
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

export function FileExplorer({ filesRead }: Props) {
  const sorted = useMemo(
    () => [...filesRead].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    [filesRead]
  )

  const active = sorted.length > 0

  return (
    <div className="p-5 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-medium tracking-widest uppercase text-muted-foreground">
          Files Explored
        </h2>
        <LiveWaveform active={active} bars={8} className="h-4" />
      </div>

      {/* Empty state */}
      {sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3">
          <LiveWaveform active={false} bars={12} />
          <p className="text-xs text-muted-foreground text-center">
            Waiting for the agent to explore the codebase
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-0">
          {sorted.map((f) => (
            <li
              key={`${f.path}-${f.timestamp}`}
              className="flex items-center justify-between py-1.5 border-b border-border/30 animate-fadeSlideIn group"
            >
              <span className="font-mono text-xs text-foreground/80 group-hover:text-foreground transition-colors truncate mr-3 flex-1">
                {f.path}
              </span>
              <span className="text-xs text-muted-foreground flex-none whitespace-nowrap font-mono">
                {(f.characterCount / 1000).toFixed(1)}k · {formatTime(f.timestamp)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
