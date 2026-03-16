import { NextRequest, NextResponse } from 'next/server'
import { sessionStore } from '@/lib/session/store'

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = sessionStore.getSession(params.id)
  if (!session) {
    return NextResponse.json(
      { error: `Session not found: ${params.id}` },
      { status: 404 }
    )
  }
  if (!session.specOutput) {
    return NextResponse.json(
      {
        error: `Spec not yet generated for session ${params.id}. ` +
          'Call POST /api/tools/generate-spec first.',
      },
      { status: 404 }
    )
  }
  return NextResponse.json({ spec: session.specOutput })
}
