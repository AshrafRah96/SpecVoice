import { z } from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import type { Session } from '@/lib/session/types'
import type { CodeSource } from '@/lib/code/types'
import { getSessionRepository } from '@/lib/session/runtime'
import { resolveCodeSource, scopeCodeSource } from '@/lib/code/index'
import { getRepositorySnapshotStore } from '@/lib/repo/snapshot-store'
import { parseRequestBody, sessionNotFound, validationError, errorResponse } from '@/lib/api/helpers'
import { requireSessionCapability } from '@/lib/session/capability'
import { withSessionStorage } from '@/lib/session/deployment'

type ToolFn<T> = (session: Session, input: T, request: NextRequest) => Promise<NextResponse>
type CodeToolFn<T> = (session: Session, source: CodeSource, input: T, request: NextRequest) => Promise<NextResponse>

const routingSchema = z.object({ session_id: z.string(), session_token: z.string().optional() })

export function createToolHandler<S extends z.ZodRawShape>(
  schema: z.ZodObject<S>,
  fn: ToolFn<z.infer<z.ZodObject<S>>>
): (req: NextRequest) => Promise<NextResponse> {
  return withSessionStorage(async (req: NextRequest) => {
    const body = await parseRequestBody(req)
    if (body === null) return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    // Parse routing key and domain input separately so generics stay clean.
    const routing = routingSchema.safeParse(body)
    if (!routing.success) return validationError(routing.error.issues)
    const unauthorized = requireSessionCapability(req, routing.data.session_id, routing.data.session_token)
    if (unauthorized) return unauthorized
    const result = schema.safeParse(body)
    if (!result.success) return validationError(result.error.issues)
    const session = await getSessionRepository().getSession(routing.data.session_id)
    if (!session) return sessionNotFound(routing.data.session_id)
    if (session.currentCallId) {
      const stale = requireSessionCapability(req, session.id, routing.data.session_token, session.currentCallId)
      if (stale) return stale
      if (session.callState !== 'active' || !(Date.parse(session.callExpiresAt ?? '') > Date.now()))
        return NextResponse.json({ error: 'Voice call is no longer active' }, { status: 409 })
    }
    try {
      return await fn(session, result.data, req)
    } catch (err) {
      return errorResponse(err)
    }
  })
}

export function createCodeToolHandler<S extends z.ZodRawShape>(
  schema: z.ZodObject<S>,
  fn: CodeToolFn<z.infer<z.ZodObject<S>>>
): (req: NextRequest) => Promise<NextResponse> {
  return createToolHandler(schema, async (session, input, request) => {
    const snapshot = await getRepositorySnapshotStore().getForSession(session.id)
    if (
      !snapshot ||
      !session.repositorySha ||
      snapshot.repositorySha !== session.repositorySha ||
      !['ready', 'partial'].includes(snapshot.indexStatus)
    )
      return NextResponse.json({ error: 'Repository Profile is not ready.' }, { status: 409 })
    return fn(session, scopeCodeSource(resolveCodeSource(session), snapshot?.scopePlan), input, request)
  })
}
