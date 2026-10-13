'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Session, SessionEvent, BuildPhase, RepositorySnapshot } from '@/lib/session/types'

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
  history: Array<Pick<Session, 'id' | 'repoUrl' | 'repoLocalPath' | 'buildStatus'>>
  hasMoreHistory: boolean
  loadMoreHistory: () => Promise<void>
  signOut: () => Promise<void>
  openSession: (id: string | null) => Promise<void>
  createSession: (repoUrl: string) => Promise<void>
  triggerBuild: () => Promise<void>
  recoverBuild: () => Promise<void>
  snapshot: RepositorySnapshot | null
  changeScope: (body: {
    includedRoots?: string[]
    excludedRoots?: string[]
    confirm?: boolean
    planId?: string
  }) => Promise<void>
  retryProfile: () => Promise<void>
}

async function operatorFetch(url: string, options?: RequestInit) {
  const response = await fetch(url, options)
  if (response.status === 401) window.location.reload()
  return response
}

export function useSession(): UseSessionReturn {
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [history, setHistory] = useState<Array<Pick<Session, 'id' | 'repoUrl' | 'repoLocalPath' | 'buildStatus'>>>([])
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const sessionRequest = useRef(0)
  const [buildLog, setBuildLog] = useState<BuildLogEntry[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshHistory = useCallback(async (before?: string) => {
    const response = await operatorFetch('/api/sessions' + (before ? `?before=${encodeURIComponent(before)}` : ''))
    if (!response.ok) throw new Error('Session history unavailable')
    const data = await response.json()
    setHistory(previous => (before ? [...previous, ...data.sessions] : data.sessions))
    setHistoryCursor(data.next)
  }, [])

  const openSession = useCallback(async (id: string | null) => {
    const sequence = ++sessionRequest.current
    try {
      const response = await (id ? operatorFetch(`/api/sessions/${encodeURIComponent(id)}`) : Promise.resolve(null))
      if (response && !response.ok) throw new Error('Cannot reopen Session')
      const data = response ? await response.json() : null
      if (sequence !== sessionRequest.current) return
      setError(null)
      setIsConnected(false)
      setSession(data?.session ?? null)
      setSnapshot(null)
      setBuildLog([])
      setSessionId(id)
      window.history.replaceState(null, '', id ? `/?session=${encodeURIComponent(id)}` : '/')
    } catch (error) {
      if (sequence === sessionRequest.current)
        setError(error instanceof Error ? error.message : 'Cannot reopen Session')
    }
  }, [])

  useEffect(() => {
    let disposed = false
    void Promise.resolve().then(async () => {
      if (disposed) return
      await refreshHistory().catch(error => setError(error.message))
      const id = new URL(window.location.href).searchParams.get('session')
      if (!disposed && id) await openSession(id)
    })
    return () => {
      disposed = true
    }
  }, [openSession, refreshHistory])

  useEffect(() => {
    if (!sessionId) return
    const es = new EventSource(`/api/sessions/${sessionId}/events`)

    es.onopen = () => {
      setIsConnected(true)
      setError(null)
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
            setBuildLog([]) // clear stale log from previous builds
            break
          case 'build_progress':
            setBuildLog(prev => [
              ...prev,
              {
                phase: sseEvent.phase,
                detail: sseEvent.detail,
                timestamp: new Date().toISOString(),
              },
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
      // Keep this EventSource alive so native reconnect sends its Last-Event-ID.
    }

    return () => {
      es.onopen = null
      es.onmessage = null
      es.onerror = null
      es.close()
    }
  }, [sessionId])

  const refreshProfile = useCallback(
    async (signal?: AbortSignal) => {
      if (!sessionId) return
      const res = await operatorFetch(`/api/sessions/${sessionId}/profile`, {
        signal,
      })
      if (!res.ok) throw new Error('Cannot load Repository Profile')
      const data = await res.json()
      if (!signal?.aborted) setSnapshot(data.snapshot)
    },
    [sessionId]
  )

  useEffect(() => {
    if (!sessionId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        await refreshProfile(controller.signal)
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Profile request failed')
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [sessionId, refreshProfile])

  const changeScope = useCallback(
    async (body: { includedRoots?: string[]; excludedRoots?: string[]; confirm?: boolean; planId?: string }) => {
      setError(null)
      try {
        const res = await operatorFetch(`/api/sessions/${sessionId}/scope`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const result = await res.json()
        if (!res.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Invalid Scope Plan')
        await refreshProfile()
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Scope update failed')
      }
    },
    [sessionId, refreshProfile]
  )

  const retryProfile = useCallback(async () => {
    setError(null)
    try {
      const res = await operatorFetch(`/api/sessions/${sessionId}/profile`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('Profiling could not restart')
      await refreshProfile()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Profile request failed')
    }
  }, [sessionId, refreshProfile])

  const recoverBuild = useCallback(async () => {
    if (!session?.buildRecovery) return
    setError(null)
    const res = await operatorFetch(`/api/sessions/${sessionId}/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retryAttemptId: session.buildRecovery.attemptId }),
    }).catch(() => null)
    if (!res?.ok) setError('Recovery could not restart. Refresh the Session and retry.')
  }, [session, sessionId])

  const createSession = useCallback(
    async (repoUrl: string) => {
      const sequence = ++sessionRequest.current
      setError(null)
      try {
        const res = await operatorFetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoUrl }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? `Failed to create session (${res.status})`)
        }
        const data = (await res.json()) as { session: Session }
        if (sequence !== sessionRequest.current) return
        setIsConnected(false)
        setSnapshot(null)
        setBuildLog([])
        setSession(data.session)
        setSessionId(data.session.id)
        window.history.replaceState(null, '', `/?session=${encodeURIComponent(data.session.id)}`)
        await refreshHistory()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create session')
      }
    },
    [refreshHistory]
  )

  const triggerBuild = useCallback(async () => {
    if (!sessionId) return
    setError(null)
    try {
      const res = await operatorFetch(`/api/sessions/${sessionId}/build`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Build failed to start (${res.status})`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger build')
    }
  }, [sessionId])

  return {
    session,
    sessionId,
    history,
    openSession,
    hasMoreHistory: historyCursor !== null,
    loadMoreHistory: async () => {
      try {
        if (historyCursor) await refreshHistory(historyCursor)
      } catch {
        setError('Session history unavailable')
      }
    },
    signOut: async () => {
      try {
        const response = await fetch('/api/operator', { method: 'DELETE' })
        if (!response.ok) throw new Error('Sign out failed; your login remains active.')
        window.location.reload()
      } catch {
        setError('Sign out failed; your login remains active. Retry when the server is reachable.')
      }
    },
    buildLog,
    isConnected,
    error,
    createSession,
    triggerBuild,
    recoverBuild,
    snapshot,
    changeScope,
    retryProfile,
  }
}
