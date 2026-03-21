'use client'

import { useState, useCallback } from 'react'
import { useConversation } from '@elevenlabs/react'
import type { Session } from '@/lib/session/types'

interface Props {
  session: Session | null
  isConnected: boolean
  error: string | null
  onCreateSession: (repoUrl: string) => Promise<void>
}

const STATUS_LABELS: Record<string, string> = {
  idle: 'Idle',
  active: 'In Call',
  complete: 'Call Ended',
  error: 'Error',
}

const BUILD_LABELS: Record<string, string> = {
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
    if (!agentId) return
    await conversation.startSession({ agentId, connectionType: 'webrtc' })
  }, [conversation])

  const handleEndWebCall = useCallback(async () => {
    await conversation.endSession()
  }, [conversation])

  // SDK only emits 'connected' | 'disconnected'
  const webCallActive = conversation.status === 'connected'

  return (
    <div className="p-5 flex flex-col gap-6 h-full">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Spec Voice</h1>
        <p className="text-xs mt-0.5" style={{ color: '#888' }}>Code-aware voice agent</p>
      </div>

      {/* Repo input */}
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium" style={{ color: '#888' }}>
          REPOSITORY URL
        </label>
        <input
          type="url"
          value={repoUrl}
          onChange={e => setRepoUrl(e.target.value)}
          placeholder="https://github.com/org/repo"
          disabled={!!session || submitting}
          className="w-full rounded px-3 py-2 text-sm font-mono outline-none disabled:opacity-40"
          style={{
            background: '#111118',
            border: '1px solid #1a1a2e',
            color: '#e5e5e5',
          }}
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
        />
        <button
          onClick={handleCreate}
          disabled={!!session || submitting || !repoUrl.trim()}
          className="w-full rounded py-2 text-sm font-medium transition-opacity disabled:opacity-40"
          style={{ background: '#6c47ff', color: '#fff' }}
        >
          {submitting ? 'Starting…' : 'Start Session'}
        </button>
      </div>

      {/* Session status */}
      {session && (
        <div
          className="rounded p-3 flex flex-col gap-2 text-sm"
          style={{ background: '#111118', border: '1px solid #1a1a2e' }}
        >
          <Row label="Status" value={STATUS_LABELS[session.status] ?? session.status} />
          {session.buildStatus !== 'idle' && (
            <Row label="Build" value={BUILD_LABELS[session.buildStatus] ?? session.buildStatus} />
          )}
          <Row label="Duration" value={formatDuration(session.callDurationSecs)} />
          <Row label="Decisions" value={String(session.decisions.length)} />
          <Row label="Files read" value={String(session.filesRead.length)} />
        </div>
      )}

      {/* SSE connection indicator */}
      {session && (
        <div className="flex items-center gap-2 text-xs" style={{ color: '#888' }}>
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: isConnected ? '#22c55e' : '#ef4444' }}
          />
          {isConnected ? 'Live' : 'Reconnecting…'}
        </div>
      )}

      {/* Web conversation (optional) */}
      {session && process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium" style={{ color: '#888' }}>WEB CONVERSATION</p>
          {!webCallActive ? (
            <button
              onClick={handleStartWebCall}
              className="w-full rounded py-2 text-sm font-medium"
              style={{ background: '#1a1a2e', color: '#e5e5e5', border: '1px solid #2a2a4e' }}
            >
              Start Web Call
            </button>
          ) : (
            <button
              onClick={handleEndWebCall}
              className="w-full rounded py-2 text-sm font-medium"
              style={{ background: '#2a0a0a', color: '#ef4444', border: '1px solid #4e1a1a' }}
            >
              End Web Call
            </button>
          )}
          {conversation.isSpeaking && (
            <div className="flex items-center gap-2 text-xs" style={{ color: '#888' }}>
              <PulsingDot />
              Agent speaking
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-xs rounded p-2" style={{ background: '#2a0a0a', color: '#ef4444', border: '1px solid #4e1a1a' }}>
          {error}
        </p>
      )}

      {/* Phone number hint */}
      {session && !session.specOutput && (
        <div className="mt-auto">
          <p className="text-xs" style={{ color: '#888' }}>
            Dial in to your ElevenLabs number and provide session ID:
          </p>
          <code
            className="block mt-1 text-xs rounded px-2 py-1 font-mono break-all"
            style={{ background: '#111118', color: '#6c47ff' }}
          >
            {session.id}
          </code>
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center">
      <span style={{ color: '#888' }}>{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  )
}

function PulsingDot() {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full animate-pulse"
      style={{ background: '#6c47ff' }}
    />
  )
}
