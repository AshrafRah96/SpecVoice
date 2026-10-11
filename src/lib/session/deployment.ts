import { NextResponse } from 'next/server'

export function requireInMemorySessionStore(): NextResponse | null {
  if (process.env.NODE_ENV === 'production' && process.env.SPECVOICE_ALLOW_IN_MEMORY_SESSIONS !== 'true') {
    return NextResponse.json(
      {
        error:
          'In-memory sessions are disabled in production. Configure durable session storage or explicitly allow single-process mode.',
      },
      { status: 503 }
    )
  }
  return null
}
