import { NextRequest, NextResponse } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { sessionNotFound } from '@/lib/api/helpers'
import { BuildPipeline } from '@/lib/build/pipeline'
import { requireSessionCapability } from '@/lib/session/capability'
import { randomUUID } from 'crypto'
import { requireInMemorySessionStore } from '@/lib/session/deployment'

const pipeline = new BuildPipeline()

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const unavailable = requireInMemorySessionStore()
  if (unavailable) return unavailable
  const unauthorized = requireSessionCapability(request, id)
  if (unauthorized) return unauthorized
  const session = sessionStore.getSession(id)
  if (!session) return sessionNotFound(id)

  if (!session.specOutput) {
    return NextResponse.json({ error: 'No spec to build from.' }, { status: 400 })
  }

  const attemptKey = request.headers.get('Idempotency-Key') ?? randomUUID()
  const start = sessionStore.tryStartBuild(id, attemptKey)
  if (start.status === 'conflict') {
    return NextResponse.json({ error: `Build already in progress for session ${id}.` }, { status: 409 })
  }
  if (start.status === 'replayed') {
    return NextResponse.json({ accepted: true, replayed: true }, { status: 202 })
  }
  if (start.status !== 'started') return sessionNotFound(id)

  void pipeline.run(id)

  return NextResponse.json({ accepted: true, replayed: false }, { status: 202 })
}
