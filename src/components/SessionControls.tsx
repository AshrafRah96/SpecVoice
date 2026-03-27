'use client'

import { useState, useCallback } from 'react'
import { useConversation } from '@elevenlabs/react'
import type { Session, BuildStatus } from '@/lib/session/types'
import { Button } from '@/components/ui/button'
import { Orb } from '@/components/ui/Orb'
import { cn } from '@/lib/utils'

interface Props {
  session: Session | null
  isConnected: boolean
  error: string | null
  onCreateSession: (repoUrl: string) => Promise<void>
}

const BUILD_LABELS: Record<BuildStatus, string> = {
  idle: '',
  ready: 'Spec Ready',
  building: 'Building',
  complete: 'Build Complete',
  failed: 'Build Failed',
}

function formatDuration(secs: number | null): string {
  if (secs === null) return '—'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function SessionControls({ session, isConnected, error, onCreateSession }: Props) {
  const [repoUrl, setRepoUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const conversation = useConversation()

  const handleCreate = useCallback(async () => {
    if (!repoUrl.trim()) return
    setSubmitting(true)
    await onCreateSession(repoUrl.trim())
    setSubmitting(false)
  }, [repoUrl, onCreateSession])

  const handleStartWebCall = useCallback(async () => {
    const agentId = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID
    if (!agentId || !session) return
    await conversation.startSession({
      agentId,
      connectionType: 'webrtc',
      dynamicVariables: { session_id: session.id },
    })
  }, [conversation, session])

  const handleEndWebCall = useCallback(async () => {
    await conversation.endSession()
  }, [conversation])

  const webCallActive = conversation.status === 'connected'

  const orbState: 'idle' | 'listening' | 'talking' =
    conversation.isSpeaking ? 'talking'
    : session?.status === 'active' ? 'listening'
    : 'idle'

  return (
    <div className="flex flex-col h-full">
      {/* Orb header */}
      <div className="flex flex-col items-center gap-3 px-5 pt-8 pb-6 border-b border-border/50">
        <Orb state={orbState} />
        <div className="text-center">
          <h1 className="text-sm font-semibold tracking-tight text-foreground">Spec Voice</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Code-aware voice agent</p>
        </div>
      </div>

      {/* Controls body */}
      <div className="flex flex-col gap-5 p-5 flex-1 overflow-y-auto">
        {/* Repo input */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium tracking-widest uppercase text-muted-foreground">
            Repository URL
          </label>
          <input
            type="url"
            value={repoUrl}
            onChange={e => setRepoUrl(e.target.value)}
            placeholder="https://github.com/org/repo"
            disabled={!!session || submitting}
            className={cn(
              'w-full rounded-md px-3 py-2 text-xs font-mono outline-none',
              'bg-muted border border-input text-foreground',
              'placeholder:text-muted-foreground',
              'focus:border-primary/60 focus:ring-1 focus:ring-primary/20',
              'disabled:opacity-40 transition-colors'
            )}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
          />
          <Button
            onClick={handleCreate}
            disabled={!!session || submitting || !repoUrl.trim()}
            size="sm"
            className="w-full"
          >
            {submitting ? 'Starting…' : 'Start Session'}
          </Button>
        </div>

        {/* Session status */}
        {session && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium tracking-widest uppercase text-muted-foreground mb-1">
              Session
            </span>
            <StatusRow label="Status" value={session.status === 'active' ? 'In Call' : 'Ended'} />
            {session.buildStatus !== 'idle' && (
              <StatusRow label="Build" value={BUILD_LABELS[session.buildStatus] ?? session.buildStatus} />
            )}
            <StatusRow label="Duration" value={formatDuration(session.callDurationSecs)} />
            <StatusRow label="Decisions" value={String(session.decisions.length)} />
            <StatusRow label="Files read" value={String(session.filesRead.length)} />
          </div>
        )}

        {/* SSE connection indicator */}
        {session && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={cn(
                'inline-block w-1.5 h-1.5 rounded-full',
                isConnected ? 'bg-success animate-pulse' : 'bg-destructive'
              )}
            />
            <span data-testid="sse-status">{isConnected ? 'connected' : 'disconnected'}</span>
          </div>
        )}

        {/* Web conversation controls */}
        {session && process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium tracking-widest uppercase text-muted-foreground">
              Web Conversation
            </span>
            {!webCallActive ? (
              <Button variant="outline" size="sm" className="w-full" onClick={handleStartWebCall}>
                Start Web Call
              </Button>
            ) : (
              <Button variant="destructive" size="sm" className="w-full" onClick={handleEndWebCall}>
                End Web Call
              </Button>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="text-xs rounded-md px-3 py-2 bg-destructive/10 text-destructive border border-destructive/20">
            {error}
          </p>
        )}

        {/* Session ID dial-in hint */}
        {session && !session.specOutput && (
          <div className="mt-auto pt-4 border-t border-border/50">
            <p className="text-xs text-muted-foreground mb-1">Dial in with session ID:</p>
            <code data-testid="session-id" className="block text-xs rounded-md px-2 py-1.5 font-mono bg-muted text-primary break-all">
              {session.id}
            </code>
          </div>
        )}
      </div>
    </div>
  )
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  )
}
