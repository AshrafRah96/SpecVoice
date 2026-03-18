import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { sessionStore } from '@/lib/session/store'
import { parseRequestBody } from '@/lib/api/helpers'

// TODO: Verify webhook signature using ElevenLabs signing secret before processing.
// ElevenLabs sends a signature header (exact name TBD). Skip in v1 — documented gap.

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await parseRequestBody(req)
  if (body === null) {
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

  const session = sessionStore.getSession(sessionId)
  if (!session) {
    return NextResponse.json({ ignored: 'unknown session' }, { status: 200 })
  }

  // Single updateSession call = single session_updated broadcast.
  sessionStore.updateSession(sessionId, {
    callDurationSecs: data.metadata.call_duration_secs,
    transcript: JSON.stringify(data.transcript),
    buildStatus: 'ready',
  })

  // Dedicated call_ended event so dashboard consumers know the call finished
  // without having to diff session state.
  sessionStore.broadcastEvent(sessionId, {
    type: 'call_ended',
    sessionId,
    callDurationSecs: data.metadata.call_duration_secs,
  })

  return NextResponse.json({ received: true }, { status: 200 })
}
