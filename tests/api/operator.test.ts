import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST, DELETE } from '@/app/api/operator/route'
import { GET as getSession } from '@/app/api/sessions/[id]/route'
import { OPERATOR_COOKIE } from '@/lib/security/operator'
import { issueSessionCapability } from '@/lib/session/capability'
import { sessionStore } from '@/lib/session/store'
import { TEST_OPERATOR_HASH, TEST_OPERATOR_PASSPHRASE } from '../helpers/operator-fixture'

function configure() {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('SPECVOICE_OPERATOR_PASSWORD_HASH', TEST_OPERATOR_HASH)
  vi.stubEnv('SPECVOICE_OPERATOR_ORIGIN', 'http://localhost:3000')
}

function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/operator', {
    method,
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function sessionRequest(id: string, headers: Record<string, string> = {}) {
  return getSession(new NextRequest(`http://localhost:3000/api/sessions/${id}`, { headers }), {
    params: Promise.resolve({ id }),
  })
}

describe('operator route and private Session access', () => {
  let cookie: string
  let login: Response

  beforeAll(async () => {
    configure()
    login = await POST(request('POST', { passphrase: TEST_OPERATOR_PASSPHRASE }))
    cookie = login.headers.get('set-cookie')!.split(';')[0]
  })
  beforeEach(configure)
  afterEach(() => vi.unstubAllEnvs())

  it('signs in with an HttpOnly, Strict cookie without returning the token in JSON', async () => {
    expect(login.status).toBe(200)
    expect(login.headers.get('cache-control')).toBe('no-store')
    expect(login.headers.get('set-cookie')).toContain(`${OPERATOR_COOKIE}=`)
    expect(login.headers.get('set-cookie')).toContain('HttpOnly')
    expect(login.headers.get('set-cookie')).toContain('SameSite=strict')
    expect(login.headers.get('set-cookie')).toContain('Path=/')
    const body = await login.json()
    expect(Object.keys(body)).toEqual(['expiresAt'])
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('marks the cookie Secure when the configured operator origin uses HTTPS', async () => {
    vi.stubEnv('SPECVOICE_OPERATOR_ORIGIN', 'https://operator.example.test')
    const response = await POST(
      request('POST', { passphrase: TEST_OPERATOR_PASSPHRASE }, { Origin: 'https://operator.example.test' })
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('Secure')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('SameSite=strict')
  })

  it('rejects incorrect credentials without issuing a cookie', async () => {
    const response = await POST(request('POST', { passphrase: 'incorrect-test-passphrase' }))
    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it.each([
    ['Origin', 'https://attacker.example.test'],
    ['Sec-Fetch-Site', 'cross-site'],
  ])('rejects cross-site sign-in and sign-out: %s=%s', async (name, value) => {
    const headers = { [name]: value }
    expect((await POST(request('POST', { passphrase: TEST_OPERATOR_PASSPHRASE }, headers))).status).toBe(403)
    expect((await DELETE(request('DELETE', undefined, { ...headers, Cookie: cookie }))).status).toBe(403)
    const session = sessionStore.createSession()
    expect((await sessionRequest(session.id, { Cookie: cookie })).status).toBe(200)
  })

  it('returns private Session state only for an authenticated operator, not a tool capability', async () => {
    const session = sessionStore.createSession({ transcript: 'Private conversation' })
    const response = await sessionRequest(session.id, { Cookie: cookie })
    expect(response.status).toBe(200)
    expect((await response.json()).session).toMatchObject({ id: session.id, transcript: 'Private conversation' })
    expect((await sessionRequest(session.id)).status).toBe(401)
    const capability = issueSessionCapability(session.id)
    expect((await sessionRequest(session.id, { Authorization: `Bearer ${capability}` })).status).toBe(401)
    expect((await sessionRequest(session.id, { 'x-session-capability': capability })).status).toBe(401)
  })

  it('revokes the server-side operator session and clears its HttpOnly, Strict cookie on sign-out', async () => {
    const signedIn = await POST(request('POST', { passphrase: TEST_OPERATOR_PASSPHRASE }))
    const revokedCookie = signedIn.headers.get('set-cookie')!.split(';')[0]
    const session = sessionStore.createSession()
    expect((await sessionRequest(session.id, { Cookie: revokedCookie })).status).toBe(200)
    const response = await DELETE(request('DELETE', undefined, { Cookie: revokedCookie }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ signedOut: true })
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('SameSite=strict')
    expect((await sessionRequest(session.id, { Cookie: revokedCookie })).status).toBe(401)
    expect((await sessionRequest(session.id, { Cookie: cookie })).status).toBe(200)
  })
})
