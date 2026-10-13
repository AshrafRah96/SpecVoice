'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useConversation } from '@elevenlabs/react'
import type { Session, BuildStatus } from '@/lib/session/types'
import { Button } from '@/components/ui/button'
import { Orb } from '@/components/ui/Orb'
import { cn } from '@/lib/utils'

interface Props {
  canStartCall: boolean
  session: Session | null
  isConnected: boolean
  error: string | null
  onCreateSession: (repoUrl: string) => Promise<void>
}

interface WebCall {
  sessionId: string
  callId?: string
  cancelled: boolean
  connected: boolean
  stopping?: Promise<void>
  finishing?: Promise<void>
  warningTimer?: ReturnType<typeof setTimeout>
  endTimer?: ReturnType<typeof setTimeout>
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

export function SessionControls({ session, isConnected, error, onCreateSession, canStartCall }: Props) {
  const [repoUrl, setRepoUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [startingCall, setStartingCall] = useState(false)
  const [endingCall, setEndingCall] = useState(false)
  const [callError, setCallError] = useState<string | null>(null)
  const [callWarning, setCallWarning] = useState(false)
  const currentCall = useRef<WebCall | null>(null)
  const conversation = useConversation()
  const endConversation = useRef(conversation.endSession)
  const previousEnd = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    endConversation.current = conversation.endSession
  }, [conversation.endSession])

  const finishCall = useCallback(async (call: WebCall, failed = false) => {
    call.cancelled = true
    clearTimeout(call.warningTimer)
    clearTimeout(call.endTimer)
    // A credential request may still be in flight; its response will supply the ID to close.
    if (!call.callId) return
    if (call.finishing) return call.finishing
    if (currentCall.current === call) setEndingCall(true)
    call.finishing = (async () => {
      try {
        const response = await fetch(`/api/sessions/${call.sessionId}/call`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callId: call.callId, failed }),
          keepalive: true,
        })
        if (!response.ok) throw new Error('Call disconnected, but its end could not be recorded. Refresh the Session.')
      } catch (error) {
        if (currentCall.current === call)
          setCallError(error instanceof Error ? error.message : 'Could not record the end of the call.')
      } finally {
        if (currentCall.current === call) {
          currentCall.current = null
          setStartingCall(false)
          setEndingCall(false)
          setCallWarning(false)
        }
      }
    })()
    return call.finishing
  }, [])

  const endCall = useCallback(
    async (call: WebCall) => {
      call.cancelled = true
      clearTimeout(call.warningTimer)
      clearTimeout(call.endTimer)
      if (currentCall.current === call && !call.stopping) {
        setEndingCall(true)
        const stop = endConversation.current
        call.stopping = Promise.resolve()
          .then(stop)
          .catch(() => {
            if (currentCall.current === call) setCallError('The voice connection could not close cleanly.')
          })
        previousEnd.current = call.stopping
      }
      await call.stopping
      await finishCall(call, !call.connected)
    },
    [finishCall]
  )

  useEffect(() => {
    const sessionId = session?.id
    return () => {
      setCallError(null)
      const call = currentCall.current
      if (!call || call.sessionId !== sessionId) return
      void endCall(call)
      currentCall.current = null
      setStartingCall(false)
      setEndingCall(false)
      setCallWarning(false)
    }
  }, [session?.id, endCall])

  const handleCreate = useCallback(async () => {
    if (!repoUrl.trim()) return
    setSubmitting(true)
    try {
      await onCreateSession(repoUrl.trim())
    } finally {
      setSubmitting(false)
    }
  }, [repoUrl, onCreateSession])

  const handleStartWebCall = useCallback(async () => {
    if (!session || !canStartCall || currentCall.current) return
    const call: WebCall = { sessionId: session.id, cancelled: false, connected: false }
    currentCall.current = call
    setStartingCall(true)
    setCallError(null)
    setCallWarning(false)
    try {
      await previousEnd.current
      if (call.cancelled) return
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true })
      microphone.getTracks().forEach(track => track.stop())
      if (call.cancelled) return
      const response = await fetch(`/api/sessions/${call.sessionId}/call`, { method: 'POST' })
      const credentials = await response.json()
      if (!response.ok)
        throw new Error(typeof credentials.error === 'string' ? credentials.error : 'Could not start the call.')
      if (typeof credentials.callId === 'string') call.callId = credentials.callId
      if (!call.callId || typeof credentials.signedUrl !== 'string' || typeof credentials.capability !== 'string')
        throw new Error('Call credentials were incomplete. Try again.')
      if (call.cancelled) {
        await finishCall(call, true)
        return
      }
      await conversation.startSession({
        signedUrl: credentials.signedUrl,
        connectionType: 'websocket',
        dynamicVariables: {
          session_id: call.sessionId,
          session_token: credentials.capability,
          call_id: call.callId,
        },
        overrides: { conversation: { textOnly: false } },
        onConnect: () => {
          call.connected = true
        },
        onDisconnect: () => void endCall(call),
        onError: message => {
          if (currentCall.current === call) setCallError(message)
        },
      })
      if (call.cancelled) return
      call.warningTimer = setTimeout(
        () => {
          if (currentCall.current === call) setCallWarning(true)
        },
        40 * 60 * 1000
      )
      call.endTimer = setTimeout(() => void endCall(call), 45 * 60 * 1000)
    } catch (error) {
      if (currentCall.current === call)
        setCallError(error instanceof Error ? error.message : 'Could not connect the voice call.')
      await endCall(call)
    } finally {
      if (currentCall.current === call) {
        setStartingCall(false)
        if (!call.callId) {
          currentCall.current = null
          setEndingCall(false)
        }
      }
    }
  }, [conversation, session, canStartCall, finishCall, endCall])

  const handleEndWebCall = useCallback(async () => {
    const call = currentCall.current
    if (call) await endCall(call)
  }, [endCall])

  const discardCall = async () => {
    if (
      !session?.currentCallId ||
      !window.confirm(
        'Mark this call failed and ignore its pending transcript? Saved Specs and decisions remain. Close any other tab still using the call.'
      )
    )
      return
    setEndingCall(true)
    setCallError(null)
    try {
      const response = await fetch(`/api/sessions/${session.id}/call`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: session.currentCallId, failed: true }),
      })
      if (!response.ok) throw new Error('Could not mark the call failed. Try again.')
    } catch (error) {
      setCallError(error instanceof Error ? error.message : 'Could not update the call.')
    } finally {
      setEndingCall(false)
    }
  }

  const webCallActive = conversation.status === 'connected'

  const orbState: 'idle' | 'listening' | 'talking' = conversation.isSpeaking
    ? 'talking'
    : webCallActive
      ? 'listening'
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
          <label className="text-xs font-medium tracking-widest uppercase text-muted-foreground">Repository URL</label>
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
            <span className="text-xs font-medium tracking-widest uppercase text-muted-foreground mb-1">Session</span>
            <StatusRow label="Status" value={webCallActive ? 'In Call' : 'Ended'} />
            {session.buildStatus !== 'idle' && (
              <StatusRow label="Build" value={BUILD_LABELS[session.buildStatus] ?? session.buildStatus} />
            )}
            <StatusRow label="Duration" value={formatDuration(session.callDurationSecs)} />
            <StatusRow label="Decisions" value={String(session.decisions.length)} />
            <StatusRow label="Files read" value={String(session.filesRead.length)} />
            {webCallActive && (
              <div className="flex justify-between items-center py-0.5 text-xs">
                <span className="text-muted-foreground">Reading</span>
                <span className="font-mono text-foreground/70 truncate ml-3 text-right max-w-[140px]">
                  {session.filesRead.length > 0 ? (
                    session.filesRead[session.filesRead.length - 1].path.split('/').pop()
                  ) : (
                    <span className="italic text-muted-foreground animate-pulse">exploring…</span>
                  )}
                </span>
              </div>
            )}
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
        {session && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium tracking-widest uppercase text-muted-foreground">
              Web Conversation
            </span>
            {!webCallActive ? (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={!canStartCall || startingCall || endingCall}
                onClick={handleStartWebCall}
              >
                {startingCall ? 'Connecting…' : endingCall ? 'Ending…' : 'Start Web Call'}
              </Button>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                className="w-full"
                disabled={endingCall}
                onClick={handleEndWebCall}
              >
                {endingCall ? 'Ending…' : 'End Web Call'}
              </Button>
            )}
            {callWarning && (
              <p role="status" className="text-xs text-muted-foreground">
                This call ends in five minutes. Finish the spec or continue in another call.
              </p>
            )}
            {!webCallActive &&
              !startingCall &&
              session.currentCallId &&
              (session.callState === 'active' || session.callState === 'awaiting_transcript') && (
                <div className="text-xs text-muted-foreground space-y-2">
                  <p>
                    A saved call is active or awaiting its transcript. If the connection or callback was lost, mark it
                    failed to use the saved Spec.
                  </p>
                  <Button variant="outline" size="sm" disabled={endingCall} onClick={discardCall}>
                    Mark call failed
                  </Button>
                </div>
              )}
          </div>
        )}

        {/* Error */}
        {(callError || error) && (
          <p
            role="alert"
            className="text-xs rounded-md px-3 py-2 bg-destructive/10 text-destructive border border-destructive/20"
          >
            {callError || error}
          </p>
        )}

        {/* Session ID dial-in hint */}
        {session && !session.specOutput && (
          <div className="mt-auto pt-4 border-t border-border/50">
            <p className="text-xs text-muted-foreground mb-1">Saved Session ID:</p>
            <code
              data-testid="session-id"
              className="block text-xs rounded-md px-2 py-1.5 font-mono bg-muted text-primary break-all"
            >
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
