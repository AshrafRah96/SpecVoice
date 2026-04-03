import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { sessionStore } from '@/lib/session/store'
import { resolveCodeSource } from '@/lib/code/index'
import { parseRequestBody, sessionNotFound, errorResponse, validationError } from '@/lib/api/helpers'

const schema = z.object({
  session_id: z.string(),
  path: z.string(),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
})

export async function POST(request: NextRequest) {
  const body = await parseRequestBody(request)
  if (body === null) return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })

  const result = schema.safeParse(body)
  if (!result.success) return validationError(result.error.issues)
  const { session_id, path, start_line, end_line } = result.data

  const session = sessionStore.getSession(session_id)
  if (!session) return sessionNotFound(session_id)

  try {
    const source = resolveCodeSource(session)
    const content = await source.readFile(path, start_line, end_line)

    sessionStore.updateSession(session_id, {
      filesRead: [
        ...session.filesRead,
        {
          path,
          timestamp: new Date().toISOString(),
          characterCount: content.content.length,
        },
      ],
    })

    return NextResponse.json({ content })
  } catch (err) {
    console.error('[read-file] error reading', path, err)
    return errorResponse(err)
  }
}
