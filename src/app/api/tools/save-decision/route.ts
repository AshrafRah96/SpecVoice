import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { sessionStore } from '@/lib/session/store'
import type { Decision } from '@/lib/session/types'
import { parseRequestBody, sessionNotFound, validationError } from '@/lib/api/helpers'

const schema = z.object({
  session_id: z.string(),
  summary: z.string().min(1),
  rationale: z.string().min(1),
  alternatives_considered: z.array(z.string()).default([]),
  relevant_files: z.array(z.string()).default([]),
})

export async function POST(request: NextRequest) {
  const body = await parseRequestBody(request)
  if (body === null) return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })

  const result = schema.safeParse(body)
  if (!result.success) {
    console.error('[save-decision] validation failed', result.error.issues, 'body:', JSON.stringify(body))
    return validationError(result.error.issues)
  }
  const { session_id, summary, rationale, alternatives_considered, relevant_files } = result.data

  const session = sessionStore.getSession(session_id)
  if (!session) return sessionNotFound(session_id)

  const decision: Decision = {
    id: randomUUID(),
    summary,
    rationale,
    alternativesConsidered: alternatives_considered,
    relevantFiles: relevant_files,
    timestamp: new Date().toISOString(),
  }

  sessionStore.updateSession(session_id, {
    decisions: [...session.decisions, decision],
  })

  return NextResponse.json({ decision })
}
