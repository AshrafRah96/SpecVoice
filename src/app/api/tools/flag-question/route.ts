import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { sessionStore } from '@/lib/session/store'
import type { OpenQuestion } from '@/lib/session/types'
import { parseRequestBody, sessionNotFound, validationError } from '@/lib/api/helpers'

const schema = z.object({
  session_id: z.string(),
  question: z.string().min(1),
  context: z.string().default(''),
})

export async function POST(request: NextRequest) {
  const body = await parseRequestBody(request)
  if (body === null) return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })

  const result = schema.safeParse(body)
  if (!result.success) return validationError(result.error.issues)
  const { session_id, question, context } = result.data

  const session = sessionStore.getSession(session_id)
  if (!session) return sessionNotFound(session_id)

  const openQuestion: OpenQuestion = {
    id: randomUUID(),
    question,
    context,
    timestamp: new Date().toISOString(),
  }

  sessionStore.updateSession(session_id, {
    openQuestions: [...session.openQuestions, openQuestion],
  })

  return NextResponse.json({ question: openQuestion })
}
