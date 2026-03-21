'use client'

import type { Session } from '@/lib/session/types'

interface Props {
  session: Session | null
}

export function SpecPreview({ session }: Props) {
  if (!session) {
    return (
      <div className="p-5 h-full flex items-center justify-center">
        <p className="text-sm" style={{ color: '#444' }}>
          Create a session to see the spec build in real time.
        </p>
      </div>
    )
  }

  // Post-call: show full spec
  if (session.specOutput) {
    return (
      <div className="p-5 h-full flex flex-col gap-3">
        <h2 className="text-xs font-semibold tracking-widest uppercase" style={{ color: '#888' }}>
          PR Spec
        </h2>
        <pre
          className="flex-1 text-xs overflow-auto whitespace-pre-wrap break-words leading-relaxed"
          style={{ color: '#e5e5e5', fontFamily: 'monospace' }}
        >
          {session.specOutput}
        </pre>
      </div>
    )
  }

  // During call: live decisions
  return (
    <div className="p-5 h-full flex flex-col gap-3">
      <h2 className="text-xs font-semibold tracking-widest uppercase" style={{ color: '#888' }}>
        Decisions ({session.decisions.length})
      </h2>

      {session.decisions.length === 0 ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: '#444' }}>
          <PulsingDot />
          Waiting for decisions…
        </div>
      ) : (
        <ul className="flex flex-col gap-3 overflow-y-auto">
          {[...session.decisions].reverse().map(d => (
            <li
              key={d.id}
              className="rounded p-3 text-sm animate-fadeIn"
              style={{ background: '#111118', border: '1px solid #1a1a2e' }}
            >
              <p className="font-medium text-sm" style={{ color: '#e5e5e5' }}>{d.summary}</p>
              {d.rationale && (
                <p className="mt-1 text-xs" style={{ color: '#888' }}>{d.rationale}</p>
              )}
              {d.relevantFiles.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {d.relevantFiles.map(f => (
                    <span
                      key={f}
                      className="text-xs font-mono rounded px-1.5 py-0.5"
                      style={{ background: '#1a1a2e', color: '#6c47ff' }}
                    >
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PulsingDot() {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full animate-pulse"
      style={{ background: '#444' }}
    />
  )
}
