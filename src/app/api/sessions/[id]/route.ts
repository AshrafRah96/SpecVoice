import { NextRequest, NextResponse } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { sessionNotFound } from '@/lib/api/helpers'
import { requireSessionCapability } from '@/lib/session/capability'
import { requireInMemorySessionStore } from '@/lib/session/deployment'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const unavailable = requireInMemorySessionStore()
  if (unavailable) return unavailable
  const unauthorized = requireSessionCapability(request, id)
  if (unauthorized) return unauthorized
  const session = sessionStore.getSession(id)
  if (!session) return sessionNotFound(id)
  return NextResponse.json({ session })
}
