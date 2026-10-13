import { buildReadiness } from '@/lib/repo/readiness'
import { NextRequest, NextResponse } from 'next/server'
import { getSessionRepository } from '@/lib/session/runtime'
import { sessionNotFound } from '@/lib/api/helpers'
import { BuildPipeline } from '@/lib/build/pipeline'
import { runtimePool } from '@/lib/db/postgres'
import { PostgresBuildQueue } from '@/lib/jobs/queue'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { withOperator } from '@/lib/api/operator-handler'
import { getRepositorySnapshotStore } from '@/lib/repo/snapshot-store'

const pipeline = new BuildPipeline()

export const POST = withOperator(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const repository = getSessionRepository()
  const session = await repository.getSession(id)
  if (!session) return sessionNotFound(id)
  if (session.callState === 'active' || session.callState === 'awaiting_transcript')
    return NextResponse.json(
      { error: 'Finish the voice call and wait for its transcript before building.' },
      { status: 409 }
    )

  if (request.headers.get('Content-Type')?.includes('application/json')) {
    const body = z
      .object({ retryAttemptId: z.string().regex(/^\d+$/) })
      .safeParse(await request.json().catch(() => null))
    if (!body.success)
      return NextResponse.json({ error: 'Expected retryAttemptId for recovery-only retry.' }, { status: 400 })
    if (!process.env.DATABASE_URL)
      return NextResponse.json({ error: 'Durable recovery requires PostgreSQL.' }, { status: 409 })
    const accepted = await new PostgresBuildQueue(runtimePool()).retryRecovery(id, body.data.retryAttemptId)
    return NextResponse.json({ accepted, recoveryOnly: true }, { status: accepted ? 202 : 409 })
  }

  const snapshot = await getRepositorySnapshotStore().getForSession(id)
  const readiness = buildReadiness(snapshot, session.repositorySha)
  if (session.specOutput && readiness) return NextResponse.json({ error: readiness }, { status: 409 })

  if (!session.specOutput) {
    return NextResponse.json({ error: 'No spec to build from.' }, { status: 400 })
  }

  const attemptKey = request.headers.get('Idempotency-Key') ?? randomUUID()
  if (!process.env.DATABASE_URL && snapshot) await repository.updateSession(id, { scopePlan: snapshot.scopePlan })
  const start = await repository.tryStartBuild(id, attemptKey)
  if (start.status === 'not_ready')
    return NextResponse.json(
      { error: 'Repository Profile or Scope Plan changed; review it before building.' },
      { status: 409 }
    )
  if (start.status === 'conflict') {
    return NextResponse.json({ error: `Build already in progress for session ${id}.` }, { status: 409 })
  }
  if (start.status === 'replayed') {
    return NextResponse.json({ accepted: true, replayed: true }, { status: 202 })
  }
  if (start.status !== 'started') return sessionNotFound(id)

  if (!process.env.DATABASE_URL) void pipeline.run(id)

  return NextResponse.json({ accepted: true, replayed: false }, { status: 202 })
})
