import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import {
  getOperatorAuth,
  hashOperatorPassphrase,
  OperatorAuth,
  OPERATOR_COOKIE,
  operatorToken,
  requireOperator,
  sameOrigin,
  verifyOperatorPassphrase,
} from '@/lib/security/operator'

const passphrase = 'correct horse with a longer battery staple'
let hash: string
let rotatedHash: string

beforeAll(async () => {
  hash = await hashOperatorPassphrase(passphrase)
  rotatedHash = await hashOperatorPassphrase('a different long operator passphrase')
})

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('SPECVOICE_OPERATOR_PASSWORD_HASH', hash)
  vi.stubEnv('SPECVOICE_OPERATOR_ORIGIN', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('operator passphrases', () => {
  it('uses a fresh salt and verifies the full passphrase', async () => {
    expect(await hashOperatorPassphrase(passphrase)).not.toBe(hash)
    expect(await verifyOperatorPassphrase(passphrase, hash)).toBe(true)
    expect(await verifyOperatorPassphrase(`${passphrase}!`, hash)).toBe(false)
    expect(hash).not.toContain(passphrase)
  })

  it('rejects malformed hashes and unbounded passphrases', async () => {
    expect(await verifyOperatorPassphrase(passphrase, `${hash}$ignored`)).toBe(false)
    expect(await verifyOperatorPassphrase(passphrase, hash.replace('$32768$', '$1073741824$'))).toBe(false)
    expect(await verifyOperatorPassphrase('a'.repeat(1025), hash)).toBe(false)
    await expect(hashOperatorPassphrase('')).rejects.toMatchObject({ status: 400 })
  })
})

describe('operator sessions', () => {
  it('issues independent tokens and revokes the logged-out token', async () => {
    const auth = new OperatorAuth()
    const first = await auth.login(passphrase)
    const second = await auth.login(passphrase)
    expect(first.token).not.toBe(second.token)
    expect(await auth.valid(first.token)).toBe(true)
    expect(await auth.valid(`${first.token}x`)).toBe(false)
    expect(await auth.valid('x'.repeat(43))).toBe(false)
    await auth.logout(first.token)
    expect(await auth.valid(first.token)).toBe(false)
    expect(await auth.valid(second.token)).toBe(true)
  })

  it('expires after eight hours without extending expiry when checked', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const auth = new OperatorAuth()
    const session = await auth.login(passphrase)
    expect(Date.parse(session.expiresAt)).toBe(now + 8 * 60 * 60 * 1000)
    clock.mockReturnValue(Date.parse(session.expiresAt) - 1)
    expect(await auth.valid(session.token)).toBe(true)
    clock.mockReturnValue(Date.parse(session.expiresAt))
    expect(await auth.valid(session.token)).toBe(false)
  })

  it('invalidates existing sessions when the configured password hash changes', async () => {
    const auth = new OperatorAuth()
    const session = await auth.login(passphrase)
    vi.stubEnv('SPECVOICE_OPERATOR_PASSWORD_HASH', rotatedHash)
    expect(await auth.valid(session.token)).toBe(false)
    await expect(auth.login(passphrase)).rejects.toMatchObject({ status: 401 })
    const next = await auth.login('a different long operator passphrase')
    expect(await auth.valid(next.token)).toBe(true)
  })

  it('reserves the global attempt budget before concurrent verification', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const auth = new OperatorAuth()
    const results = await Promise.allSettled(Array.from({ length: 11 }, () => auth.login('wrong')))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(0)
    const statuses = results.map(result => (result.status === 'rejected' ? result.reason.status : 0))
    expect(statuses.filter(status => status === 401)).toHaveLength(10)
    expect(statuses.filter(status => status === 429)).toHaveLength(1)
    await expect(auth.login(passphrase)).rejects.toMatchObject({ status: 429 })
    clock.mockReturnValue(now + 15 * 60 * 1000)
    expect(await auth.valid((await auth.login(passphrase)).token)).toBe(true)
  }, 30_000) // Real memory-hard hashes remain bounded on small CI/Docker hosts.

  it('counts successful logins toward the same abuse budget', async () => {
    const auth = new OperatorAuth()
    await auth.login(passphrase)
    await Promise.all(Array.from({ length: 9 }, () => expect(auth.login('')).rejects.toMatchObject({ status: 401 })))
    await expect(auth.login(passphrase)).rejects.toMatchObject({ status: 429 })
  })

  it('fails closed when configuration or production storage is missing', async () => {
    const auth = new OperatorAuth()
    vi.stubEnv('SPECVOICE_OPERATOR_PASSWORD_HASH', '')
    await expect(auth.login(passphrase)).rejects.toMatchObject({ status: 503 })
    await expect(auth.valid(null)).rejects.toMatchObject({ status: 503 })
    vi.stubEnv('SPECVOICE_OPERATOR_PASSWORD_HASH', 'not-a-hash')
    await expect(auth.login(passphrase)).rejects.toMatchObject({ status: 503 })
    vi.stubEnv('SPECVOICE_OPERATOR_PASSWORD_HASH', hash)
    vi.stubEnv('NODE_ENV', 'production')
    await expect(auth.login(passphrase)).rejects.toMatchObject({ status: 503 })
    expect(() => getOperatorAuth()).toThrow('storage unavailable')
  })
})

describe('operator request boundary', () => {
  it('accepts only the operator cookie and enforces server-side logout', async () => {
    const auth = getOperatorAuth()
    const { token } = await auth.login(passphrase)
    const request = new NextRequest('http://localhost:3000/api/sessions', {
      headers: { cookie: `${OPERATOR_COOKIE}=${token}` },
    })
    expect(operatorToken(request)).toBe(token)
    expect(await requireOperator(request)).toBeNull()
    const bearerOnly = new NextRequest('http://localhost:3000/api/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect((await requireOperator(bearerOnly))?.status).toBe(401)
    await auth.logout(token)
    expect((await requireOperator(request))?.status).toBe(401)
  })

  it.each([
    [{ origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }, true],
    [{ origin: 'https://attacker.example' }, false],
    [{ origin: 'null' }, false],
    [{ 'sec-fetch-site': 'cross-site' }, false],
    [{ 'sec-fetch-site': 'same-site' }, false],
    [{}, true],
  ])('checks Origin and browser fetch metadata for writes: %j', (headers, expected) => {
    const request = new NextRequest('http://localhost:3000/api/sessions', { method: 'POST', headers })
    expect(sameOrigin(request)).toBe(expected)
  })

  it('requires the configured operator origin without trusting forwarded headers or public webhook origin', async () => {
    vi.stubEnv('SPECVOICE_OPERATOR_ORIGIN', 'https://specvoice.example')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://webhooks.example')
    const trusted = new NextRequest('http://web:3000/api/sessions', {
      method: 'POST',
      headers: { origin: 'https://specvoice.example' },
    })
    expect(sameOrigin(trusted)).toBe(true)
    for (const origin of ['http://web:3000', 'https://webhooks.example']) {
      expect(sameOrigin(new NextRequest('http://web:3000/api/sessions', { method: 'POST', headers: { origin } }))).toBe(
        false
      )
    }
    const forged = new NextRequest('http://web:3000/api/sessions', {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example' },
    })
    expect((await requireOperator(forged))?.status).toBe(403)
  })

  it('reports unavailable auth as 503 without exposing internals', async () => {
    vi.stubEnv('SPECVOICE_OPERATOR_PASSWORD_HASH', '')
    const response = await requireOperator(new NextRequest('http://localhost:3000/api/sessions'))
    expect(response?.status).toBe(503)
    expect(await response?.json()).toEqual({ error: 'Operator authentication unavailable.' })
  })

  it('fails closed for malformed or opaque configured browser origins', () => {
    for (const configured of ['not-a-url', 'file:///tmp/operator']) {
      vi.stubEnv('SPECVOICE_OPERATOR_ORIGIN', configured)
      expect(
        sameOrigin(
          new NextRequest('http://localhost:3000/api/sessions', { method: 'POST', headers: { origin: 'null' } })
        )
      ).toBe(false)
    }
  })
})
