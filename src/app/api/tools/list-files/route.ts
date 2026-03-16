import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { sessionStore } from '@/lib/session/store'
import { resolveCodeSource } from '@/lib/code/index'
import { parseRequestBody, sessionNotFound, errorResponse, validationError } from '@/lib/api/helpers'

const schema = z.object({
  session_id: z.string(),
  path: z.string().optional(),
})

export async function POST(request: NextRequest) {
  const body = await parseRequestBody(request)
  if (body === null) return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })

  const result = schema.safeParse(body)
  if (!result.success) return validationError(result.error.issues)
  const { session_id, path } = result.data

  const session = sessionStore.getSession(session_id)
  if (!session) return sessionNotFound(session_id)

  try {
    const source = resolveCodeSource(session)
    const files = await source.listFiles(path)
    return NextResponse.json({ files })
  } catch (err) {
    return errorResponse(err)
  }
}
