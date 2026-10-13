import { NextResponse } from 'next/server'
import { StorageUnavailable } from '@/lib/db/postgres'

export function requireSessionStorage(): NextResponse | null {
  if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
    return NextResponse.json(
      {
        error: 'In-memory sessions are disabled in production. Configure DATABASE_URL.',
      },
      { status: 503 }
    )
  }
  return null
}

export function withSessionStorage<A extends unknown[], R extends Response>(handler: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    const unavailable = requireSessionStorage()
    if (unavailable) return unavailable as unknown as R
    try {
      return await handler(...args)
    } catch (error) {
      if (error instanceof StorageUnavailable)
        return NextResponse.json({ error: error.message }, { status: 503 }) as unknown as R
      throw error
    }
  }
}

// Kept as a compatibility alias for integrations that imported the old guard.
export const requireInMemorySessionStore = requireSessionStorage
