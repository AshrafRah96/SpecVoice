import { z } from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import type { Session } from '@/lib/session/types'
import type { CodeSource } from '@/lib/code/types'
import { sessionStore } from '@/lib/session/store'
import { resolveCodeSource } from '@/lib/code/index'
import { parseRequestBody, sessionNotFound, validationError, errorResponse } from '@/lib/api/helpers'

type ToolFn<T> = (session: Session, input: T) => Promise<NextResponse>
type CodeToolFn<T> = (session: Session, source: CodeSource, input: T) => Promise<NextResponse>

const routingSchema = z.object({ session_id: z.string() })

export function createToolHandler<S extends z.ZodRawShape>(
  schema: z.ZodObject<S>,
  fn: ToolFn<z.infer<z.ZodObject<S>>>
): (req: NextRequest) => Promise<NextResponse> {
  return async (req: NextRequest) => {
    const body = await parseRequestBody(req)
    if (body === null)
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    // Parse routing key and domain input separately so generics stay clean.
    const routing = routingSchema.safeParse(body)
    if (!routing.success) return validationError(routing.error.issues)
    const result = schema.safeParse(body)
    if (!result.success) return validationError(result.error.issues)
    const session = sessionStore.getSession(routing.data.session_id)
    if (!session) return sessionNotFound(routing.data.session_id)
    try {
      return await fn(session, result.data)
    } catch (err) {
      return errorResponse(err)
    }
  }
}

export function createCodeToolHandler<S extends z.ZodRawShape>(
  schema: z.ZodObject<S>,
  fn: CodeToolFn<z.infer<z.ZodObject<S>>>
): (req: NextRequest) => Promise<NextResponse> {
  return createToolHandler(schema, (session, input) =>
    fn(session, resolveCodeSource(session), input)
  )
}
