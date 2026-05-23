import { NextRequest, NextResponse } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { sessionNotFound } from '@/lib/api/helpers'
import { BuildPipeline } from '@/lib/build/pipeline'

const pipeline = new BuildPipeline()

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

  sessionStore.startBuild(id)

  void pipeline.run(id)

  return NextResponse.json({ accepted: true }, { status: 202 })
}
