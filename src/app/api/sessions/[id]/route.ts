import { NextRequest, NextResponse } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { sessionNotFound } from '@/lib/api/helpers'

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = sessionStore.getSession(params.id)
  if (!session) return sessionNotFound(params.id)
  return NextResponse.json({ session })
}
