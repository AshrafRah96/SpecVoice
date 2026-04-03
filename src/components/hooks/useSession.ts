'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { Session, SessionEvent, BuildPhase } from '@/lib/session/types'

// Local type — build log lives in hook state only, NOT on the Session object
export interface BuildLogEntry {
  phase: BuildPhase
  detail: string
  timestamp: string
}

export interface UseSessionReturn {
  session: Session | null
  sessionId: string | null
  buildLog: BuildLogEntry[]
  isConnected: boolean
  error: string | null
  createSession: (repoUrl: string) => Promise<void>
  triggerBuild: () => Promise<void>
}

export function useSession(): UseSessionReturn {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [buildLog, setBuildLog] = useState<BuildLogEntry[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryDelayRef = useRef(1000)

  const connectSSE = useCallback((id: string) => {
    if (esRef.current) esRef.current.close()

    const es = new EventSource(`/api/sessions/${id}/events`)
    esRef.current = es

    es.onopen = () => {
      setIsConnected(true)
      setError(null)
      retryDelayRef.current = 1000
    }

    es.onmessage = (event: MessageEvent) => {
      try {
        const sseEvent = JSON.parse(event.data) as SessionEvent
        switch (sseEvent.type) {
          case 'session_updated':
            setSession(sseEvent.session)
            break
          case 'call_ended':
            // session_updated follows immediately with the updated session — let it carry the state
            break
          case 'build_started':
            setBuildLog([])  // clear stale log from previous builds
            break
          case 'build_progress':
            setBuildLog(prev => [
              ...prev,
              { phase: sseEvent.phase, detail: sseEvent.detail, timestamp: new Date().toISOString() },
            ])
            break
          case 'build_complete':
          case 'build_blocked':
            // session_updated carries the final session state (buildStatus, prUrl, complexityAssessment)
            break
          case 'build_failed':
            // Surface the error so BuildPanel can display it instead of the generic fallback
            setError(sseEvent.error)
            break
        }
      } catch {
        // malformed SSE payload — ignore
      }
    }

    es.onerror = () => {
      setIsConnected(false)
      es.close()
      // exponential backoff reconnect, cap at 30s
      retryTimerRef.current = setTimeout(() => {
        retryDelayRef.current = Math.min(retryDelayRef.current * 2, 30000)
        connectSSE(id)
      }, retryDelayRef.current)
    }
  }, [])

  useEffect(() => {
    if (!sessionId) return
    connectSSE(sessionId)
    return () => {
      esRef.current?.close()
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [sessionId, connectSSE])

  const createSession = useCallback(async (repoUrl: string) => {
    setError(null)
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Failed to create session (${res.status})`)
      }
      const data = await res.json() as { session: Session }
      setSession(data.session)
      setSessionId(data.session.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session')
    }
  }, [])

  const triggerBuild = useCallback(async () => {
    if (!sessionId) return
    setError(null)
    try {
      const res = await fetch(`/api/sessions/${sessionId}/build`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Build failed to start (${res.status})`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger build')
    }
  }, [sessionId])

  return { session, sessionId, buildLog, isConnected, error, createSession, triggerBuild }
}
