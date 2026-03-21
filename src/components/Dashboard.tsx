'use client'

import { useSession } from '@/components/hooks/useSession'
import { SessionControls } from '@/components/SessionControls'
import { FileExplorer } from '@/components/FileExplorer'
import { SpecPreview } from '@/components/SpecPreview'
import { BuildPanel } from '@/components/BuildPanel'

export function Dashboard() {
  const { session, buildLog, isConnected, error, createSession, triggerBuild } = useSession()

  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      style={{ background: '#0a0a0b', color: '#e5e5e5' }}
    >
      {/* Left panel — 300px fixed */}
      <aside
        className="flex-none w-[300px] h-full overflow-y-auto border-r"
        style={{ borderColor: '#1a1a2e' }}
      >
        <SessionControls
          session={session}
          isConnected={isConnected}
          error={error}
          onCreateSession={createSession}
        />
      </aside>

      {/* Centre panel — flex-1 */}
      <section
        className="flex-1 h-full overflow-y-auto border-r"
        style={{ borderColor: '#1a1a2e' }}
      >
        <FileExplorer filesRead={session?.filesRead ?? []} />
      </section>

      {/* Right panel — flex-1, split vertically */}
      <section className="flex-1 h-full flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto border-b" style={{ borderColor: '#1a1a2e' }}>
          <SpecPreview session={session} />
        </div>
        <div className="flex-none overflow-y-auto max-h-[40%]">
          <BuildPanel session={session} buildLog={buildLog} onTriggerBuild={triggerBuild} error={error} />
        </div>
      </section>
    </div>
  )
}
