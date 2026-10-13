import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'
import { getSessionRepository } from '@/lib/session/runtime'
import { env } from '@/lib/env'
import { withSessionStorage } from '@/lib/session/deployment'
import { getPostCallQueue } from '@/lib/jobs/post-call-queue'
import { getSessionCalls } from '@/lib/session/calls'

const TranscriptTurnSchema = z
  .object({
    role: z.string(),
    message: z.string(),
    time_in_call_secs: z.number(),
  })
  .passthrough()

// Only validate the fields this handler uses. The full payload has many more fields.
// Payload shape confirmed from ElevenLabs `post_call_transcription` example via context7.
const PostCallPayloadSchema = z.object({
  type: z.string(),
  data: z
    .object({
      metadata: z
        .object({
          call_duration_secs: z.number(),
        })
        .passthrough(),
      conversation_id: z.string().optional(),
      event_timestamp: z.union([z.string(), z.number()]).optional(),
      transcript: z.array(TranscriptTurnSchema),
      conversation_initiation_client_data: z
        .object({
          dynamic_variables: z.record(z.unknown()).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
})

export const POST = withSessionStorage(async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV !== 'test' && !env.ELEVENLABS_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'ELEVENLABS_WEBHOOK_SECRET is required.' }, { status: 503 })
  }
  const rawBody = await req.text()

  // Verify webhook signature when secret is configured.
  // constructEvent also parses the JSON, so we use its output directly.
  if (env.ELEVENLABS_WEBHOOK_SECRET) {
    const elevenlabs = new ElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY ?? '' })
    const sigHeader = req.headers.get('ElevenLabs-Signature')
    try {
      await elevenlabs.webhooks.constructEvent(rawBody, sigHeader ?? '', env.ELEVENLABS_WEBHOOK_SECRET)
    } catch {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = PostCallPayloadSchema.safeParse(body)
  if (!parsed.success) {
    // Return 200 so ElevenLabs does not retry on schema mismatches.
    return NextResponse.json({ ignored: 'unexpected payload shape' }, { status: 200 })
  }

  const { data } = parsed.data
  const sessionId = data.conversation_initiation_client_data?.dynamic_variables?.['session_id']

  if (typeof sessionId !== 'string' || !sessionId) {
    return NextResponse.json({ ignored: 'missing session_id' }, { status: 200 })
  }

  const repository = getSessionRepository()
  const session = await repository.getSession(sessionId)
  if (!session) {
    return NextResponse.json({ ignored: 'unknown session' }, { status: 200 })
  }

  const callId = data.conversation_initiation_client_data?.dynamic_variables?.['call_id']
  if (callId !== undefined && !z.string().uuid().safeParse(callId).success)
    return NextResponse.json({ ignored: 'invalid call_id' })
  if (session.currentCallId && !callId) return NextResponse.json({ ignored: 'uncorrelated legacy callback' })
  if (typeof callId === 'string') {
    const call = await getSessionCalls().get(callId)
    if (!call || call.sessionId !== sessionId || !data.conversation_id)
      return NextResponse.json({ ignored: 'unknown call or missing conversation_id' })
    if (call.conversationId && call.conversationId !== data.conversation_id)
      return NextResponse.json({ ignored: 'conversation does not match call' })
  }

  const deliveryId =
    req.headers.get('ElevenLabs-Delivery-Id') ??
    req.headers.get('X-ElevenLabs-Delivery-Id') ??
    req.headers.get('X-Webhook-Id') ??
    undefined
  const queue = getPostCallQueue()
  const accepted = await queue.accept({
    provider: 'elevenlabs',
    deliveryId,
    eventType: parsed.data.type,
    conversationId: data.conversation_id ?? sessionId,
    eventTimestamp: data.event_timestamp === undefined ? undefined : String(data.event_timestamp),
    body: rawBody,
    sessionId,
    callId: typeof callId === 'string' ? callId : undefined,
    callDurationSecs: data.metadata.call_duration_secs,
    transcript: JSON.stringify(data.transcript),
  })

  if (!accepted.duplicate && !process.env.DATABASE_URL) {
    await getSessionCalls().complete({
      sessionId,
      callId: typeof callId === 'string' ? callId : undefined,
      conversationId: data.conversation_id ?? sessionId,
      callDurationSecs: data.metadata.call_duration_secs,
      transcript: JSON.stringify(data.transcript),
    })
  }

  return NextResponse.json(accepted.duplicate ? { received: true, duplicate: true } : { received: true }, {
    status: 200,
  })
})
