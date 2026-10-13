import { NextRequest, NextResponse } from 'next/server'
import {
  getOperatorAuth,
  operatorToken,
  OPERATOR_COOKIE,
  operatorErrorStatus,
  sameOrigin,
} from '@/lib/security/operator'
import { withSessionStorage } from '@/lib/session/deployment'
import { z } from 'zod'

export const POST = withSessionStorage(async (request: NextRequest) => {
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Same-origin request required.' }, { status: 403 })
  const body = z.object({ passphrase: z.string().min(1).max(1024) }).safeParse(await request.json().catch(() => null))
  if (!body.success) return NextResponse.json({ error: 'Enter your operator passphrase.' }, { status: 400 })
  try {
    const login = await getOperatorAuth().login(body.data.passphrase)
    const response = NextResponse.json({ expiresAt: login.expiresAt }, { headers: { 'Cache-Control': 'no-store' } })
    const origin = new URL(process.env.SPECVOICE_OPERATOR_ORIGIN ?? request.nextUrl.origin)
    response.cookies.set(OPERATOR_COOKIE, login.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: origin.protocol === 'https:',
      path: '/',
      expires: new Date(login.expiresAt),
    })
    return response
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error && error.name === 'OperatorAuthError' ? error.message : 'Sign-in unavailable.' },
      { status: operatorErrorStatus(error) }
    )
  }
})

export const DELETE = withSessionStorage(async (request: NextRequest) => {
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Same-origin request required.' }, { status: 403 })
  try {
    await getOperatorAuth().logout(operatorToken(request))
    const response = NextResponse.json({ signedOut: true })
    response.cookies.set(OPERATOR_COOKIE, '', { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 0 })
    return response
  } catch {
    return NextResponse.json({ error: 'Could not revoke operator session. Retry sign-out.' }, { status: 503 })
  }
})
