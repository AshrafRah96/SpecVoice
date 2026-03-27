'use client'

import { useSession } from '@/components/hooks/useSession'
import { SessionControls } from '@/components/SessionControls'
import { FileExplorer } from '@/components/FileExplorer'
import { SpecPreview } from '@/components/SpecPreview'
import { BuildPanel } from '@/components/BuildPanel'

export function Dashboard() {
  const { session, buildLog, isConnected, error, createSession, triggerBuild } = useSession()

  return (
    <div className="flex h-screen w-full gap-2 p-2 overflow-hidden bg-background">
      {/* Left panel — 280px fixed */}
      <aside className="flex-none w-[280px] h-full overflow-y-auto rounded-lg border border-border/50 bg-card">
        <SessionControls
          session={session}
          isConnected={isConnected}
          error={error}
          onCreateSession={createSession}
        />
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
          <BuildPanel session={session} buildLog={buildLog} onTriggerBuild={triggerBuild} error={error} />
        </div>
      </section>
    </div>
  )
}
