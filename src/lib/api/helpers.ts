import { NextRequest, NextResponse } from 'next/server'

export async function parseRequestBody(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

export function sessionNotFound(sessionId: string): NextResponse {
  return NextResponse.json(
    { error: `Session not found: ${sessionId}. Create it via POST /api/sessions.` },
    { status: 404 }
  )
}

export function validationError(issues: unknown[]): NextResponse {
  return NextResponse.json({ error: 'Invalid request', details: issues }, { status: 400 })
}

export function errorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : String(err)
  return NextResponse.json({ error: message }, { status: 500 })
}
