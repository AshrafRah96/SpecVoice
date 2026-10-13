import { createHash, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPool } from '@/lib/db/postgres'
import { migrate } from '@/lib/db/migrate'
import { PostgresSessionRepository } from '@/lib/session/postgres-repository'
import { ModelBudget, requestReservation } from '@/lib/security/model-budget'
import { createModelGateway } from '@/model-gateway'

const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests')
if (!new URL(connectionString).pathname.endsWith('_test')) {
  throw new Error('Integration tests truncate data; TEST_DATABASE_URL must select a disposable database ending _test')
}

const pool = createPool(connectionString)
const repository = new PostgresSessionRepository(pool)
const budget = new ModelBudget(pool)
const servers = new Set<Server>()
const serviceSecret = 'test-service-secret-for-model-gateway-only'
const providerKey = 'test-provider-key-not-a-real-credential'
const message = {
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Inspect the scoped function.' }],
}

beforeAll(async () => {
  await migrate(pool)
})

beforeEach(async () => {
  await pool.query('TRUNCATE sessions, webhook_receipts RESTART IDENTITY CASCADE')
  vi.stubEnv('ANTHROPIC_API_KEY', providerKey)
  vi.stubEnv('SPECVOICE_SERVICE_SECRET', serviceSecret)
  vi.stubEnv('SPECVOICE_BUILD_BUDGET_USD', '5')
})

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      server =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close(error => (error ? reject(error) : resolve()))
        })
    )
  )
  servers.clear()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await pool.end()
})

async function attempt() {
  const session = await repository.createSession()
  const leaseToken = randomUUID()
  const result = await pool.query<{ id: string }>(
    `INSERT INTO build_attempts (session_id, attempt_key, status, lease_token, lease_expires_at)
     VALUES ($1, $2, 'running', $3, clock_timestamp() + interval '10 minutes') RETURNING id`,
    [session.id, randomUUID(), leaseToken]
  )
  return { attemptId: result.rows[0].id, leaseToken }
}

async function capability() {
  const owned = await attempt()
  return { ...owned, ...(await budget.issue(owned.attemptId, owned.leaseToken)) }
}

async function state(attemptId: string) {
  const result = await pool.query<{
    token_hash: string
    spent_usd: string
    requests: number
    in_flight: boolean
    state: string
  }>('SELECT * FROM model_runs WHERE attempt_id = $1', [attemptId])
  return result.rows[0]
}

async function recordedRequest(attemptId: string) {
  const result = await pool.query<{
    status: string
    reserved_usd: string
    charged_usd: string
    usage: unknown
    latency_ms: number | null
  }>('SELECT * FROM model_requests WHERE attempt_id = $1 ORDER BY created_at DESC LIMIT 1', [attemptId])
  return result.rows[0]
}

async function gateway(fetcher: typeof fetch) {
  const server = createModelGateway(pool, fetcher)
  servers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP gateway address')
  return `http://127.0.0.1:${address.port}`
}

function send(base: string, token: string, body: unknown = message, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  })
}

function events(...values: unknown[]) {
  return values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')
}

describe('durable model budgets', () => {
  it('allows one concurrent reservation and debits it before provider work', async () => {
    const { attemptId, token } = await capability()
    const otherProcess = new ModelBudget(pool)
    const results = await Promise.allSettled([budget.reserve(token, 0.25), otherProcess.reserve(token, 0.25)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    expect(await state(attemptId)).toMatchObject({ spent_usd: '0.25', requests: 1, in_flight: true })
    expect(await recordedRequest(attemptId)).toMatchObject({
      status: 'pending',
      reserved_usd: '0.25',
      charged_usd: '0.25',
      usage: null,
    })
    expect((await pool.query('SELECT id FROM model_requests')).rowCount).toBe(1)
  })

  it('settles actual usage once, retaining its original metrics on repeated completion', async () => {
    const { attemptId, token } = await capability()
    const reservation = await budget.reserve(token, 0.25)
    const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 100 }
    await Promise.all([
      budget.finish({ ...reservation, reservedUsd: 4 }, usage, 123),
      new ModelBudget(pool).finish(reservation, usage, 123),
    ])
    await budget.finish(reservation, { input_tokens: 0, output_tokens: 0 }, 999)
    expect(Number((await state(attemptId)).spent_usd)).toBeCloseTo(0.00603, 8)
    expect(await state(attemptId)).toMatchObject({ requests: 1, in_flight: false })
    expect(await recordedRequest(attemptId)).toMatchObject({ status: 'reported', usage, latency_ms: 123 })
    await expect(budget.reserve(token, 0.1)).resolves.toHaveProperty('id')
  })

  it('retains the full reservation when usage is unknown, even after revocation', async () => {
    const { attemptId, leaseToken, token } = await capability()
    const reservation = await budget.reserve(token, 0.25)
    await budget.revoke(attemptId, leaseToken)
    await budget.finish(reservation, undefined, 150)
    expect(await state(attemptId)).toMatchObject({ spent_usd: '0.25', in_flight: false, state: 'revoked' })
    expect(await recordedRequest(attemptId)).toMatchObject({ status: 'unknown', charged_usd: '0.25', usage: null })
  })

  it.each(['token expiry', 'lease expiry', 'revocation', 'ownership change', 'attempt completion'])(
    'rejects requests after %s',
    async invalidation => {
      const { attemptId, leaseToken, token } = await capability()
      if (invalidation === 'token expiry') {
        await pool.query(
          "UPDATE model_runs SET expires_at = clock_timestamp() - interval '1 second' WHERE attempt_id = $1",
          [attemptId]
        )
      } else if (invalidation === 'lease expiry') {
        await pool.query(
          "UPDATE build_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
          [attemptId]
        )
      } else if (invalidation === 'revocation') {
        await budget.revoke(attemptId, leaseToken)
      } else if (invalidation === 'ownership change') {
        await pool.query('UPDATE build_attempts SET lease_token = $2 WHERE id = $1', [attemptId, randomUUID()])
      } else {
        await pool.query("UPDATE build_attempts SET status = 'complete' WHERE id = $1", [attemptId])
      }
      expect(await budget.active(token)).toBe(false)
      await expect(budget.reserve(token, 0.1)).rejects.toMatchObject({ status: 401 })
      expect(await state(attemptId)).toMatchObject({ spent_usd: '0', requests: 0, in_flight: false })
    }
  )

  it('stores only the token hash and refuses reissue without resetting usage', async () => {
    const { attemptId, leaseToken, token, expiresAt } = await capability()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 60_000)
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000)
    const reservation = await budget.reserve(token, 0.25)
    await budget.finish(reservation)
    await expect(new ModelBudget(pool).issue(attemptId, leaseToken)).rejects.toMatchObject({ status: 409 })
    const row = await state(attemptId)
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'))
    expect(JSON.stringify(row)).not.toContain(token)
    expect(row).toMatchObject({ spent_usd: '0.25', requests: 1 })
    expect(await budget.active(token)).toBe(true)
  })

  it('cannot issue a capability for an unowned or expired Build Attempt', async () => {
    const { attemptId, leaseToken } = await attempt()
    await expect(budget.issue(attemptId, randomUUID())).rejects.toMatchObject({ status: 403 })
    await pool.query(
      "UPDATE build_attempts SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [attemptId]
    )
    await expect(budget.issue(attemptId, leaseToken)).rejects.toMatchObject({ status: 403 })
    expect((await pool.query('SELECT attempt_id FROM model_runs')).rowCount).toBe(0)
  })

  it('allows the hundredth request but rejects the next without another debit', async () => {
    const { attemptId, token } = await capability()
    await pool.query('UPDATE model_runs SET requests = 99 WHERE attempt_id = $1', [attemptId])
    await budget.finish(await budget.reserve(token, 0.1), { input_tokens: 0, output_tokens: 0 })
    await expect(budget.reserve(token, 0.1)).rejects.toMatchObject({ status: 429 })
    expect(await state(attemptId)).toMatchObject({ requests: 100, in_flight: false })
    expect(Number((await state(attemptId)).spent_usd)).toBe(0)
  })

  it('enforces the five-dollar ceiling without floating-point overspend', async () => {
    const { attemptId, token } = await capability()
    await pool.query('UPDATE model_runs SET spent_usd = 4.9 WHERE attempt_id = $1', [attemptId])
    await expect(budget.reserve(token, 0.100001)).rejects.toMatchObject({ status: 429 })
    await budget.finish(await budget.reserve(token, 0.1))
    await expect(budget.reserve(token, 0.000001)).rejects.toMatchObject({ status: 429 })
    expect(Number((await state(attemptId)).spent_usd)).toBe(5)
    expect(await state(attemptId)).toMatchObject({ requests: 1, in_flight: false })
  })

  it('keeps an interrupted pending request charged and blocked across a new gateway instance', async () => {
    const { attemptId, leaseToken, token } = await capability()
    await budget.reserve(token, 0.5)
    const restarted = new ModelBudget(pool)
    await expect(restarted.reserve(token, 0.5)).rejects.toMatchObject({ status: 409 })
    await expect(restarted.issue(attemptId, leaseToken)).rejects.toMatchObject({ status: 409 })
    const upstream = vi.fn<typeof fetch>()
    expect((await send(await gateway(upstream), token)).status).toBe(409)
    expect(upstream).not.toHaveBeenCalled()
    expect(await state(attemptId)).toMatchObject({ spent_usd: '0.5', requests: 1, in_flight: true })
    expect(await recordedRequest(attemptId)).toMatchObject({ status: 'pending', charged_usd: '0.5' })
  })
})

describe('model gateway HTTP boundary', () => {
  it('requires separate control authentication and an active attempt capability', async () => {
    const upstream = vi.fn<typeof fetch>()
    const base = await gateway(upstream)
    const owned = await attempt()
    const control = (token: string, method = 'POST') =>
      fetch(`${base}/control/attempts`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(owned),
      })
    expect((await control('incorrect')).status).toBe(401)
    expect((await send(base, serviceSecret)).status).toBe(401)
    expect((await send(base, 'invalid-capability')).status).toBe(401)
    const issued = await control(serviceSecret)
    expect(issued.status).toBe(201)
    const { token } = await issued.json()
    expect((await fetch(`${base}/attempt-status`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
    expect((await control(token, 'DELETE')).status).toBe(401)
    expect((await control(serviceSecret, 'DELETE')).status).toBe(200)
    expect((await send(base, token)).status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('rejects other models, paid tools, oversized requests and proxy paths before upstream work', async () => {
    const { attemptId, token } = await capability()
    const upstream = vi.fn<typeof fetch>()
    const base = await gateway(upstream)
    expect((await send(base, token, { ...message, model: 'claude-opus-4-6' })).status).toBe(400)
    expect(
      (await send(base, token, { ...message, tools: [{ type: 'web_search_20250305', name: 'web_search' }] })).status
    ).toBe(400)
    expect((await send(base, token, { ...message, max_tokens: 8193 })).status).toBe(400)
    expect((await send(base, token, { ...message, system: 'x'.repeat(1024 * 1024) })).status).toBeGreaterThanOrEqual(
      400
    )
    expect((await fetch(`${base}/https://attacker.invalid/v1/messages`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/v1/models?url=http://169.254.169.254/`)).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
    expect(await state(attemptId)).toMatchObject({ requests: 0, spent_usd: '0' })
  })

  it('uses only its provider key and fixed upstream destination, and settles JSON usage', async () => {
    const { attemptId, token } = await capability()
    const upstream = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ id: 'test-message', usage: { input_tokens: 100, output_tokens: 20 } })
      )
    const base = await gateway(upstream)
    const response = await send(base, token, message, {
      'x-api-key': 'caller-provider-key-must-not-forward',
      'anthropic-beta': 'caller-beta-must-not-forward',
      'x-forwarded-host': 'attacker.invalid',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('id', 'test-message')
    expect(upstream).toHaveBeenCalledOnce()
    const [url, options] = upstream.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(options?.redirect).toBe('error')
    expect(Object.fromEntries(new Headers(options?.headers))).toEqual({
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta':
        'interleaved-thinking-2025-05-14,context-management-2025-06-27,effort-2025-11-24,thinking-display-updates-2026-08-18',
      'x-api-key': providerKey,
    })
    expect(JSON.parse(String(options?.body))).toEqual(message)
    expect(Number((await state(attemptId)).spent_usd)).toBeCloseTo(0.0006, 8)
    expect(await recordedRequest(attemptId)).toMatchObject({ status: 'reported', latency_ms: expect.any(Number) })
  })

  it('merges usage across split SSE chunks and records cache charges and latency', async () => {
    const { attemptId, token } = await capability()
    const usage = {
      input_tokens: 100,
      output_tokens: 0,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 10,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 },
    }
    const stream = events(
      { type: 'message_start', message: { usage } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'café' } },
      { type: 'message_delta', usage: { output_tokens: 20 } },
      { type: 'message_stop' }
    )
    const bytes = new TextEncoder().encode(stream)
    const upstream = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < bytes.length; offset += 7)
                controller.enqueue(bytes.slice(offset, offset + 7))
              controller.close()
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
    )
    const response = await send(await gateway(upstream), token, { ...message, stream: true })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(stream)
    expect(Number((await state(attemptId)).spent_usd)).toBeCloseTo(0.000738, 8)
    expect(await recordedRequest(attemptId)).toMatchObject({
      status: 'reported',
      usage: { ...usage, output_tokens: 20 },
      latency_ms: expect.any(Number),
    })
  })

  it('charges the reservation when the upstream stream ends without final usage', async () => {
    const { attemptId, token } = await capability()
    const body = { ...message, stream: true }
    const upstream = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(events({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } }), {
          headers: { 'Content-Type': 'text/event-stream' },
        })
    )
    const response = await send(await gateway(upstream), token, body)
    await response.text()
    const reserved = requestReservation(body, Buffer.byteLength(JSON.stringify(body)))
    expect(Number((await state(attemptId)).spent_usd)).toBe(reserved)
    expect(await recordedRequest(attemptId)).toMatchObject({ status: 'unknown', usage: null })
    expect(await state(attemptId)).toHaveProperty('in_flight', false)
  })

  it('aborts upstream work on client disconnect and retains the full reservation', async () => {
    const { attemptId, token } = await capability()
    let upstreamSignal: AbortSignal | null | undefined
    const upstream = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      upstreamSignal = options?.signal
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                events({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } })
              )
            )
            upstreamSignal?.addEventListener('abort', () => controller.error(new Error('Mock upstream aborted')), {
              once: true,
            })
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    })
    const base = await gateway(upstream)
    const controller = new AbortController()
    const body = { ...message, stream: true }
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    controller.abort()
    await reader.cancel().catch(() => undefined)
    await vi.waitFor(async () => {
      expect(upstreamSignal?.aborted).toBe(true)
      expect(await recordedRequest(attemptId)).toHaveProperty('status', 'unknown')
    })
    const row = await recordedRequest(attemptId)
    expect(row.charged_usd).toBe(row.reserved_usd)
    expect(Number((await state(attemptId)).spent_usd)).toBe(Number(row.reserved_usd))
    expect(await state(attemptId)).toHaveProperty('in_flight', false)
  })
})
