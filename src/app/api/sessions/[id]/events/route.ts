import { NextRequest } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { sessionNotFound } from '@/lib/api/helpers'
import type { SessionEvent } from '@/lib/session/types'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = sessionStore.getSession(params.id)
  if (!session) return sessionNotFound(params.id)

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  // Send the current session state immediately so the client doesn't wait for the next mutation
  const initialPayload = `data: ${JSON.stringify({ type: 'session_updated', session })}\n\n`
  writer.write(encoder.encode(initialPayload))

  const unsubscribe = sessionStore.subscribe(params.id, (event: SessionEvent) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`
    writer.write(encoder.encode(payload)).catch(() => {
      // Client already disconnected — abort handler will clean up
    })
  })

  request.signal.addEventListener('abort', () => {
    unsubscribe()
    writer.close()
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
