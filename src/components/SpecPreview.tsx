'use client'

import { useMemo, useState } from 'react'
import type { Session } from '@/lib/session/types'
import { cn } from '@/lib/utils'

interface Props {
  session: Session | null
}

export function SpecPreview({ session }: Props) {
  const [activeTab, setActiveTab] = useState<'decisions' | 'spec'>('decisions')

  const reversedDecisions = useMemo(
    () => session ? [...session.decisions].reverse() : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.decisions]
  )

  if (!session) {
    return (
      <div data-testid="spec-preview" className="p-5 h-full flex items-center justify-center">
        <p className="text-xs text-muted-foreground text-center">
          Create a session to see the spec build in real time.
        </p>
      </div>
    )
  }

  const hasSpec = !!session.specOutput
  const tab = activeTab

  return (
    <div data-testid="spec-preview" className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="flex border-b border-border/50 px-5 gap-5 flex-none">
        {(['decisions', 'spec'] as const).map(t => (
          <button
            key={t}
            role="tab"
            onClick={() => setActiveTab(t)}
            disabled={t === 'spec' && !hasSpec}
            className={cn(
              'py-3 text-xs font-medium capitalize transition-colors',
              'border-b-[1px] -mb-px',
              tab === t
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
              t === 'spec' && !hasSpec && 'opacity-30 cursor-default'
            )}
          >
            {t === 'decisions'
              ? `Decisions${session.decisions.length > 0 ? ` (${session.decisions.length})` : ''}`
              : 'Spec'}
          </button>
        ))}
      </div>

      {/* Tab body */}
      <div className="flex-1 overflow-y-auto p-5">
        {tab === 'spec' && hasSpec ? (
          <pre className="text-xs overflow-auto whitespace-pre-wrap break-words leading-relaxed text-foreground font-mono">
            {session.specOutput}
          </pre>
        ) : (
          <>
            {session.decisions.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-foreground/20 animate-pulse" />
                Waiting for decisions…
              </div>
            ) : (
              <ul className="flex flex-col gap-0">
                {reversedDecisions.map(d => (
                  <li
                    key={d.id}
                    className={cn(
                      'flex items-center justify-between py-2 px-3 -mx-3',
                      'border-l-2 border-foreground/20',
                      'hover:bg-muted/40 transition-colors cursor-default',
                      'animate-fadeSlideIn'
                    )}
                  >
                    <span className="text-xs text-foreground flex-1 truncate mr-3">
                      {d.summary}
                    </span>
                    {d.relevantFiles.length > 0 && (
                      <span className="text-xs text-muted-foreground flex-none whitespace-nowrap">
                        {d.relevantFiles.length} file{d.relevantFiles.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}
