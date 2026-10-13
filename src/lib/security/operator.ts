import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import type { Pool } from 'pg'
import { runtimePool } from '@/lib/db/postgres'
import { createHotReloadSafeSingleton } from '@/lib/singleton'

export const OPERATOR_COOKIE = 'specvoice_operator'
const SESSION_MS = 8 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const HASH_PATTERN = /^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/

export class OperatorAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'OperatorAuthError'
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export function operatorErrorStatus(error: unknown): number {
  // Next.js route bundles and hot reloads share the singleton, but not class constructors.
  return error instanceof Error &&
    error.name === 'OperatorAuthError' &&
    'status' in error &&
    typeof error.status === 'number' &&
    [400, 401, 429, 503].includes(error.status)
    ? error.status
    : 503
}
const validPassphrase = (value: string) => value.length > 0 && Buffer.byteLength(value, 'utf8') <= 1024

function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // OWASP's 32 MiB scrypt configuration bounds memory while retaining its recommended work factor.
    scrypt(passphrase, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function hashOperatorPassphrase(passphrase: string): Promise<string> {
  if (!validPassphrase(passphrase)) throw new OperatorAuthError(400, 'Passphrase must contain 1–1024 UTF-8 bytes.')
  const salt = randomBytes(16)
  const key = await derive(passphrase, salt)
  return `scrypt$32768$8$3$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyOperatorPassphrase(passphrase: string, hash: string): Promise<boolean> {
  const parts = HASH_PATTERN.exec(hash)
  if (!parts || !validPassphrase(passphrase)) return false
  const key = await derive(passphrase, Buffer.from(parts[1], 'hex'))
  return timingSafeEqual(key, Buffer.from(parts[2], 'hex'))
}

function configuredHash(): string {
  const hash = process.env.SPECVOICE_OPERATOR_PASSWORD_HASH
  if (!hash || !HASH_PATTERN.test(hash)) {
    throw new OperatorAuthError(503, 'Configure a valid SPECVOICE_OPERATOR_PASSWORD_HASH before signing in.')
  }
  return hash
}

export class OperatorAuth {
  private readonly sessions = new Map<string, { fingerprint: string; expiresAt: number }>()
  private loginWindow = { start: 0, attempts: 0 }

  constructor(private readonly pool?: Pool) {}

  private assertStorage() {
    if (!this.pool && process.env.NODE_ENV === 'production') {
      throw new OperatorAuthError(503, 'Operator authentication storage unavailable.')
    }
  }

  private async query<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch {
      throw new OperatorAuthError(503, 'Operator authentication storage unavailable.')
    }
  }

  private async reserveLogin(): Promise<void> {
    if (this.pool) {
      const result = await this.query(() =>
        this.pool!.query(
          `INSERT INTO operator_login_limit (id, window_start, attempts)
           VALUES (1, clock_timestamp(), 1)
           ON CONFLICT (id) DO UPDATE SET
             window_start = CASE WHEN operator_login_limit.window_start <= clock_timestamp() - interval '15 minutes'
               THEN clock_timestamp() ELSE operator_login_limit.window_start END,
             attempts = CASE WHEN operator_login_limit.window_start <= clock_timestamp() - interval '15 minutes'
               THEN 1 ELSE operator_login_limit.attempts + 1 END
           WHERE operator_login_limit.window_start <= clock_timestamp() - interval '15 minutes'
             OR operator_login_limit.attempts < 10
           RETURNING id`
        )
      )
      if (result.rowCount) return
    } else {
      const now = Date.now()
      if (now >= this.loginWindow.start + LOGIN_WINDOW_MS) this.loginWindow = { start: now, attempts: 0 }
      if (this.loginWindow.attempts < 10) {
        this.loginWindow.attempts++
        return
      }
    }
    throw new OperatorAuthError(429, 'Too many sign-in attempts. Retry after 15 minutes.')
  }

  async login(passphrase: string): Promise<{ token: string; expiresAt: string }> {
    const hash = configuredHash()
    this.assertStorage()
    await this.reserveLogin()
    if (!(await verifyOperatorPassphrase(passphrase, hash)) || configuredHash() !== hash) {
      throw new OperatorAuthError(401, 'Invalid operator credentials.')
    }
    const token = randomBytes(32).toString('base64url')
    const tokenHash = digest(token)
    const fingerprint = digest(hash)
    if (this.pool) {
      const result = await this.query(() =>
        this.pool!.query<{ expires_at: Date }>(
          `INSERT INTO operator_sessions (token_hash, fingerprint, expires_at)
           VALUES ($1, $2, clock_timestamp() + interval '8 hours') RETURNING expires_at`,
          [tokenHash, fingerprint]
        )
      )
      return { token, expiresAt: result.rows[0].expires_at.toISOString() }
    }
    const now = Date.now()
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key)
    const expiresAt = now + SESSION_MS
    this.sessions.set(tokenHash, { fingerprint, expiresAt })
    return { token, expiresAt: new Date(expiresAt).toISOString() }
  }

  async valid(token: string | null | undefined): Promise<boolean> {
    const fingerprint = digest(configuredHash())
    this.assertStorage()
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false
    const tokenHash = digest(token)
    if (this.pool) {
      const result = await this.query(() =>
        this.pool!.query(
          `SELECT token_hash FROM operator_sessions
           WHERE token_hash = $1 AND fingerprint = $2 AND expires_at > clock_timestamp()`,
          [tokenHash, fingerprint]
        )
      )
      return Boolean(result.rowCount)
    }
    const session = this.sessions.get(tokenHash)
    return Boolean(session && session.fingerprint === fingerprint && session.expiresAt > Date.now())
  }

  async logout(token: string | null | undefined): Promise<void> {
    this.assertStorage()
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return
    const tokenHash = digest(token)
    if (this.pool)
      await this.query(() => this.pool!.query('DELETE FROM operator_sessions WHERE token_hash = $1', [tokenHash]))
    else this.sessions.delete(tokenHash)
  }
}

export function getOperatorAuth(): OperatorAuth {
  if (process.env.DATABASE_URL) {
    return createHotReloadSafeSingleton('__postgresOperatorAuth', () => new OperatorAuth(runtimePool()))
  }
  if (process.env.NODE_ENV === 'production')
    throw new OperatorAuthError(503, 'Operator authentication storage unavailable.')
  return createHotReloadSafeSingleton('__memoryOperatorAuth', () => new OperatorAuth())
}

export function operatorToken(request: NextRequest): string | null {
  return request.cookies.get(OPERATOR_COOKIE)?.value ?? null
}

export function sameOrigin(request: NextRequest): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true
  const site = request.headers.get('sec-fetch-site')
  if (site && !['same-origin', 'none'].includes(site)) return false
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    const expected = process.env.SPECVOICE_OPERATOR_ORIGIN
      ? new URL(process.env.SPECVOICE_OPERATOR_ORIGIN).origin
      : request.nextUrl.origin
    return expected !== 'null' && origin === expected
  } catch {
    return false
  }
}

export async function requireOperator(request: NextRequest): Promise<NextResponse | null> {
  if (!sameOrigin(request)) return NextResponse.json({ error: 'Same-origin request required.' }, { status: 403 })
  try {
    if (await getOperatorAuth().valid(operatorToken(request))) return null
    return NextResponse.json({ error: 'Operator sign-in required.' }, { status: 401 })
  } catch (error) {
    const status = operatorErrorStatus(error)
    return NextResponse.json({ error: 'Operator authentication unavailable.' }, { status })
  }
}
