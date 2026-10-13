import { NextRequest, NextResponse } from 'next/server'
import { getSessionRepository } from '@/lib/session/runtime'
import { withOperator } from '@/lib/api/operator-handler'

export const GET = withOperator(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await getSessionRepository().getSession(id)
  if (!session) {
    return NextResponse.json({ error: `Session not found: ${id}` }, { status: 404 })
  }
  if (!session.specOutput) {
    return NextResponse.json(
      {
        error: `Spec not yet generated for session ${id}. ` + 'Call POST /api/tools/generate-spec first.',
      },
      { status: 404 }
    )
  }
  return NextResponse.json({ spec: session.specOutput })
})
