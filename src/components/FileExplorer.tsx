'use client'

import { useMemo } from 'react'
import type { FileRead } from '@/lib/session/types'

interface Props {
  filesRead: FileRead[]
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

export function FileExplorer({ filesRead }: Props) {
  const sorted = useMemo(
    () => [...filesRead].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
    [filesRead]
  )

  return (
    <div className="p-5 h-full">
      <h2 className="text-xs font-semibold mb-4 tracking-widest uppercase" style={{ color: '#888' }}>
        Files Explored
      </h2>

      {sorted.length === 0 ? (
        <p className="text-sm" style={{ color: '#444' }}>
          Waiting for agent to explore the codebase…
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((f, i) => (
            <li
              key={`${f.path}-${f.timestamp}`}
              className="rounded px-3 py-2 text-sm animate-fadeIn"
              style={{
                background: i === 0 ? '#111118' : 'transparent',
                border: '1px solid',
                borderColor: i === 0 ? '#1a1a2e' : 'transparent',
                animationDelay: '0ms',
              }}
            >
              <div className="font-mono text-xs break-all" style={{ color: '#e5e5e5' }}>
                {f.path}
              </div>
              <div className="flex justify-between mt-1 text-xs" style={{ color: '#555' }}>
                <span>{(f.characterCount / 1000).toFixed(1)}k chars</span>
                <span>{relativeTime(f.timestamp)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
