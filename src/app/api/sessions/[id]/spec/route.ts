import { NextRequest, NextResponse } from 'next/server'
import { sessionStore } from '@/lib/session/store'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = sessionStore.getSession(id)
  if (!session) {
    return NextResponse.json(
      { error: `Session not found: ${id}` },
      { status: 404 }
    )
  }
  if (!session.specOutput) {
    return NextResponse.json(
      {
        error: `Spec not yet generated for session ${id}. ` +
          'Call POST /api/tools/generate-spec first.',
      },
      { status: 404 }
    )
  }
  return NextResponse.json({ spec: session.specOutput })
}
