import { NextRequest, NextResponse } from 'next/server'
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'
import { z } from 'zod'
import { withOperator } from '@/lib/api/operator-handler'
import { getSessionRepository } from '@/lib/session/runtime'
import { getRepositorySnapshotStore } from '@/lib/repo/snapshot-store'
import { getSessionCalls, CALL_DURATION_SECS } from '@/lib/session/calls'
import { issueSessionCapability } from '@/lib/session/capability'

type Context = { params: Promise<{ id: string }> }
export const POST = withOperator(async (_request: NextRequest, context: Context) => {
  const { id } = await context.params
  const session = await getSessionRepository().getSession(id)
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  const snapshot = await getRepositorySnapshotStore().getForSession(id)
  if (
    !snapshot ||
    snapshot.repositorySha !== session.repositorySha ||
    !['ready', 'partial'].includes(snapshot.indexStatus)
  )
    return NextResponse.json({ error: 'Repository Profile is not ready.' }, { status: 409 })
  const agentId = process.env.ELEVENLABS_AGENT_ID
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!agentId || !apiKey)
    return NextResponse.json({ error: 'Private voice agent is not configured.' }, { status: 503 })
  const calls = getSessionCalls()
  let call
  try {
    call = await calls.start(id)
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'SessionCallError' &&
      'status' in error &&
      typeof error.status === 'number' &&
      [404, 409, 429].includes(error.status)
    )
      return NextResponse.json({ error: error.message }, { status: error.status })
    return NextResponse.json({ error: 'Call storage is unavailable. Retry when PostgreSQL is ready.' }, { status: 503 })
  }
  try {
    const client = new ElevenLabsClient({ apiKey })
    const result = await client.conversationalAi.conversations.getSignedUrl(
      { agentId, includeConversationId: true },
      { timeoutInSeconds: 15, maxRetries: 0 }
    )
    return NextResponse.json(
      {
        callId: call.id,
        signedUrl: result.signedUrl,
        capability: issueSessionCapability(id, Date.now(), call.id),
        maxDurationSecs: CALL_DURATION_SECS,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch {
    await calls.end(id, call.id, true)
    return NextResponse.json({ error: 'Voice provider could not start a private call.' }, { status: 502 })
  }
})

export const DELETE = withOperator(async (request: NextRequest, context: Context) => {
  const { id } = await context.params
  const body = z
    .object({ callId: z.string().uuid(), failed: z.boolean().optional() })
    .safeParse(await request.json().catch(() => null))
  if (!body.success) return NextResponse.json({ error: 'Valid callId required.' }, { status: 400 })
  await getSessionCalls().end(id, body.data.callId, body.data.failed)
  return NextResponse.json({ ended: true })
})
