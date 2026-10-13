import { NextRequest, NextResponse } from 'next/server'
import { getSessionRepository } from '@/lib/session/runtime'
import { sessionNotFound } from '@/lib/api/helpers'
import { withOperator } from '@/lib/api/operator-handler'

export const GET = withOperator(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await getSessionRepository().getSession(id)
  if (!session) return sessionNotFound(id)
  return NextResponse.json({ session })
})
