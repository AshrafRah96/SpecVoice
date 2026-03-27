import { NextRequest, NextResponse } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { sessionNotFound } from '@/lib/api/helpers'
import type { BuildPhase } from '@/lib/session/types'

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = sessionStore.getSession(params.id)
  if (!session) return sessionNotFound(params.id)

  if (session.buildStatus === 'building') {
    return NextResponse.json(
      { error: `Build already in progress for session ${params.id}.` },
      { status: 409 }
    )
  }

  if (!session.specOutput) {
    return NextResponse.json({ error: 'No spec to build from.' }, { status: 400 })
  }

  sessionStore.setBuildStatus(params.id, 'building')
  sessionStore.broadcastEvent(params.id, { type: 'build_started', sessionId: params.id })

  // Stub: simulate build progress then complete
  // Real implementation (feature 2): kicks off Claude Code headless pipeline
  void simulateBuild(params.id)

  return NextResponse.json({ accepted: true }, { status: 202 })
}

async function simulateBuild(sessionId: string) {
  const phases: Array<{ phase: BuildPhase; detail: string }> = [
    { phase: 'analyzing', detail: 'Parsing spec decisions and identifying affected modules' },
    { phase: 'writing', detail: 'Generating implementation scaffold' },
    { phase: 'reviewing', detail: 'Running static checks' },
  ]

  for (const { phase, detail } of phases) {
    await new Promise(r => setTimeout(r, 1500))
    sessionStore.broadcastEvent(sessionId, { type: 'build_progress', phase, detail })
  }

  await new Promise(r => setTimeout(r, 1000))
  const prUrl = 'https://github.com/placeholder/pr/1'
  // Batch prUrl + buildStatus into one updateSession to avoid double session_updated broadcast
  sessionStore.updateSession(sessionId, { prUrl, buildStatus: 'complete' })
  sessionStore.broadcastEvent(sessionId, { type: 'build_complete', sessionId, prUrl })
}
