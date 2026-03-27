import { NextRequest, NextResponse } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { sessionNotFound } from '@/lib/api/helpers'
import { assessComplexity } from '@/lib/session/complexity'
import type { BuildPhase } from '@/lib/session/types'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = sessionStore.getSession(id)
  if (!session) return sessionNotFound(id)

  if (session.buildStatus === 'building') {
    return NextResponse.json(
      { error: `Build already in progress for session ${id}.` },
      { status: 409 }
    )
  }

  if (!session.specOutput) {
    return NextResponse.json({ error: 'No spec to build from.' }, { status: 400 })
  }

  sessionStore.setBuildStatus(id, 'building')
  sessionStore.broadcastEvent(id, { type: 'build_started', sessionId: id })

  // Gate and build run synchronously up to the first await so events
  // fire before the response is returned, making them testable without timers.
  void runGatedBuild(id)

  return NextResponse.json({ accepted: true }, { status: 202 })
}

async function runGatedBuild(sessionId: string) {
  const session = sessionStore.getSession(sessionId)
  if (!session) return

  const assessment = assessComplexity(session)
  sessionStore.setComplexityAssessment(sessionId, assessment)

  if (assessment.blocked) {
    // Reset to 'ready' so the "Build it" button stays visible for retry after resolution.
    sessionStore.setBuildStatus(sessionId, 'ready')
    sessionStore.broadcastEvent(sessionId, {
      type: 'build_blocked',
      sessionId,
      assessment,
    })
    return
  }

  await simulateBuild(sessionId)
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
