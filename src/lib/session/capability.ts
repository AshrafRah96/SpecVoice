import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'

const CAPABILITY_TTL_MS = 60 * 60 * 1000
const DEVELOPMENT_SECRET = randomBytes(32).toString('hex')

function secret(): string {
  const configured = process.env.SESSION_CAPABILITY_SECRET
  if (configured) return configured
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_CAPABILITY_SECRET must be set in production.')
  }
  return DEVELOPMENT_SECRET
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function issueSessionCapability(sessionId: string, now = Date.now(), callId?: string): string {
  const payload = encode(
    JSON.stringify({
      sid: sessionId,
      cid: callId,
      iat: now,
      exp: now + CAPABILITY_TTL_MS,
      jti: randomUUID(),
    })
  )
  return `${payload}.${sign(payload)}`
}

export function verifySessionCapability(
  token: string | null | undefined,
  sessionId: string,
  now = Date.now(),
  callId?: string
): boolean {
  if (!token) return false
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return false

  const expected = sign(payload)
  const providedBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) return false

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sid?: unknown
      exp?: unknown
      iat?: unknown
      cid?: unknown
    }
    return (
      parsed.sid === sessionId &&
      (!callId || parsed.cid === callId) &&
      typeof parsed.exp === 'number' &&
      typeof parsed.iat === 'number' &&
      parsed.iat <= now &&
      now < parsed.exp
    )
  } catch {
    return false
  }
}

export function capabilityFromRequest(request: NextRequest, bodyToken?: unknown): string | null {
  const authorization = request.headers.get('authorization')
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length)
  return (
    request.headers.get('x-session-capability') ??
    request.nextUrl.searchParams.get('capability') ??
    (typeof bodyToken === 'string' ? bodyToken : null)
  )
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: 'Valid session capability required.' }, { status: 401 })
}

export function requireSessionCapability(
  request: NextRequest,
  sessionId: string,
  bodyToken?: unknown,
  callId?: string
): NextResponse | null {
  return verifySessionCapability(capabilityFromRequest(request, bodyToken), sessionId, Date.now(), callId)
    ? null
    : unauthorizedResponse()
}
