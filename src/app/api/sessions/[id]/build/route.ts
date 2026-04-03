import { NextRequest, NextResponse } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { sessionNotFound } from '@/lib/api/helpers'
import { assessComplexity } from '@/lib/session/complexity'
import { executeBuild } from '@/lib/build'

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

  void runGatedBuild(id)

  return NextResponse.json({ accepted: true }, { status: 202 })
}

async function runGatedBuild(sessionId: string) {
  const session = sessionStore.getSession(sessionId)
  if (!session) return

  const assessment = assessComplexity(session)
  sessionStore.setComplexityAssessment(sessionId, assessment)

  if (assessment.blocked) {
    sessionStore.setBuildStatus(sessionId, 'ready')
    sessionStore.broadcastEvent(sessionId, {
      type: 'build_blocked',
      sessionId,
      assessment,
    })
    return
  }

  await executeBuild(sessionId)
}
