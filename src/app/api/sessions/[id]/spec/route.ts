import { NextRequest, NextResponse } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { requireSessionCapability } from '@/lib/session/capability'
import { requireInMemorySessionStore } from '@/lib/session/deployment'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const unavailable = requireInMemorySessionStore()
  if (unavailable) return unavailable
  const unauthorized = requireSessionCapability(request, id)
  if (unauthorized) return unauthorized
  const session = sessionStore.getSession(id)
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
}
