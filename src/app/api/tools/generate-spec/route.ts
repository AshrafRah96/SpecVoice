import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { sessionStore } from '@/lib/session/store'
import { generateSpec } from '@/lib/session/spec-generator'
import { parseRequestBody, sessionNotFound, validationError } from '@/lib/api/helpers'

const schema = z.object({
  session_id: z.string(),
})

export async function POST(request: NextRequest) {
  const body = await parseRequestBody(request)
  if (body === null) return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })

  const result = schema.safeParse(body)
  if (!result.success) return validationError(result.error.issues)
  const { session_id } = result.data

  const session = sessionStore.getSession(session_id)
  if (!session) return sessionNotFound(session_id)

  const spec = generateSpec(session)
  sessionStore.updateSession(session_id, { specOutput: spec, status: 'complete' })

  return NextResponse.json({ spec })
}
