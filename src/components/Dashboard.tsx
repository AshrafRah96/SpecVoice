'use client'

import { ScopeControls, canDiscuss } from './ScopeControls'
import { buildReadiness } from '@/lib/repo/readiness'
import { useSession } from '@/components/hooks/useSession'
import { SessionControls } from '@/components/SessionControls'
import { FileExplorer } from '@/components/FileExplorer'
import { SpecPreview } from '@/components/SpecPreview'
import { BuildPanel } from '@/components/BuildPanel'

export function Dashboard() {
  const {
    session,
    history,
    openSession,
    hasMoreHistory,
    loadMoreHistory,
    signOut,
    buildLog,
    isConnected,
    error,
    createSession,
    triggerBuild,
    recoverBuild,
    snapshot,
    changeScope,
    retryProfile,
  } = useSession()

  return (
    <div className="flex h-screen w-full gap-2 p-2 overflow-hidden bg-background">
      {/* Left panel — 280px fixed */}
      <aside className="flex-none w-[280px] h-full overflow-y-auto rounded-lg border border-border/50 bg-sidebar">
        <div className="p-3 space-y-2 border-b">
          <label htmlFor="session-history" className="text-xs">
            Saved Sessions
          </label>
          <select
            id="session-history"
            className="w-full bg-background border rounded p-2 text-xs"
            value={session?.id ?? ''}
            onChange={event => void openSession(event.target.value || null)}
          >
            <option value="">New Session</option>
            {session && !history.some(item => item.id === session.id) && (
              <option value={session.id}>{session.repoUrl ?? session.repoLocalPath ?? session.id}</option>
            )}
            {history.map(item => (
              <option key={item.id} value={item.id}>
                {item.repoUrl ?? item.repoLocalPath ?? item.id} — {item.buildStatus}
              </option>
            ))}
          </select>
          {hasMoreHistory && (
            <button className="text-xs underline mr-3" onClick={() => void loadMoreHistory()}>
              Load older Sessions
            </button>
          )}
          <button className="text-xs underline" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
        <SessionControls
          session={session}
          canStartCall={canDiscuss(snapshot)}
          isConnected={isConnected}
          error={error}
          onCreateSession={createSession}
        />
        {session && <ScopeControls snapshot={snapshot} changeScope={changeScope} retryProfile={retryProfile} />}
      </aside>

      {/* Centre panel — flex-1 */}
      <section className="flex-1 h-full overflow-y-auto rounded-lg border border-border/50 bg-card">
        <FileExplorer filesRead={session?.filesRead ?? []} />
      </section>

      {/* Right panel — flex-1, split vertically */}
      <section className="flex-1 h-full flex flex-col overflow-hidden rounded-lg border border-border/50">
        <div className="flex-1 overflow-y-auto border-b border-border/50">
          <SpecPreview session={session} />
        </div>
        <div className="flex-none overflow-y-auto max-h-[40%] bg-card">
          <BuildPanel
            session={session}
            buildLog={buildLog}
            onTriggerBuild={triggerBuild}
            onRecoverBuild={recoverBuild}
            readiness={
              session?.callState === 'active' || session?.callState === 'awaiting_transcript'
                ? 'Finish the voice call and wait for its transcript before building.'
                : buildReadiness(snapshot, session?.repositorySha)
            }
            error={error}
          />
        </div>
      </section>
    </div>
  )
}
