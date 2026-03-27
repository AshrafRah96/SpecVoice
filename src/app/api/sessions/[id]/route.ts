import { NextRequest, NextResponse } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { sessionNotFound } from '@/lib/api/helpers'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = sessionStore.getSession(id)
  if (!session) return sessionNotFound(id)
  return NextResponse.json({ session })
}
