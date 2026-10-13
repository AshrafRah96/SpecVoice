import { NextRequest } from 'next/server'
import { getSessionRepository } from '@/lib/session/runtime'
import { sessionNotFound } from '@/lib/api/helpers'
import { withOperator } from '@/lib/api/operator-handler'
import { requireOperator } from '@/lib/security/operator'

export const GET = withOperator(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const repository = getSessionRepository()
  const snapshot = await repository.getSnapshot(id)
  if (!snapshot.session) return sessionNotFound(id)

  let streamController: TransformStreamDefaultController<Uint8Array>
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      streamController = controller
    },
  })
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  const requestedCursor = request.headers.get('Last-Event-ID')
  let cursor = requestedCursor && /^\d+$/.test(requestedCursor) ? requestedCursor : snapshot.cursor
  let closed = false
  let reading = false
  let pending = false
  let ready = false
  let snapshotPending = !requestedCursor || !/^\d+$/.test(requestedCursor)
  let unsubscribe: (() => void) | undefined
  let poll: ReturnType<typeof setInterval> | undefined

  const stop = () => {
    if (closed) return
    closed = true
    clearInterval(poll)
    unsubscribe?.()
    request.signal.removeEventListener('abort', stop)
    // Termination closes the reader and releases writes blocked by a disconnected consumer.
    streamController.terminate()
  }
  void writer.closed.catch(stop)

  const send = async (idValue: string, event: unknown) => {
    if (closed) return
    await writer.write(encoder.encode(`id: ${idValue}\ndata: ${JSON.stringify(event)}\n\n`))
  }

  const flush = async () => {
    pending = true
    if (!ready || reading || closed) return
    reading = true
    try {
      if (snapshotPending) {
        snapshotPending = false
        await send(snapshot.cursor, { type: 'session_updated', session: snapshot.session })
      }
      while (!closed) {
        pending = false
        const events = await repository.readEvents(id, cursor)
        for (const event of events) {
          if (closed) break
          await send(event.id, event.event)
          cursor = event.id
        }
        if (events.length === 0 && !pending) break
      }
    } catch {
      stop()
    } finally {
      reading = false
    }
  }

  request.signal.addEventListener('abort', stop, { once: true })
  if (request.signal.aborted) stop()
  try {
    if (!closed) {
      unsubscribe = await repository.watch(id, () => void flush())
      if (closed) {
        unsubscribe()
      } else {
        ready = true
        poll = setInterval(() => {
          void requireOperator(request)
            .then(denied => (denied ? stop() : flush()))
            .catch(stop)
        }, 1000)
        // The consumer cannot read until Response returns; never await this first write.
        void flush()
      }
    }
  } catch (error) {
    stop()
    throw error
  }

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})
