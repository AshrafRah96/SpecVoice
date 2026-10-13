import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'
import type { Pool } from 'pg'
import { z } from 'zod'
import { runtimePool } from '@/lib/db/postgres'
import { ModelBudget, ModelBudgetError, requestReservation, type ModelUsage } from '@/lib/security/model-budget'
import { bearer, readServiceJson, serviceAuthorized, serviceJson } from '@/lib/security/service-http'

export function createModelGateway(pool: Pool, fetcher: typeof fetch = fetch) {
  const budget = new ModelBudget(pool, Number(process.env.SPECVOICE_BUILD_BUDGET_USD ?? 5))
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://gateway').pathname
    if (path === '/health' && request.method === 'GET') {
      await pool.query('SELECT 1')
      return serviceJson(response, 200, { ready: true })
    }
    if (path.startsWith('/control/')) {
      if (!serviceAuthorized(request, process.env.SPECVOICE_SERVICE_SECRET))
        return serviceJson(response, 401, { error: 'Control authentication required' })
      const input = z
        .object({ attemptId: z.string().regex(/^[1-9]\d*$/), leaseToken: z.string().uuid() })
        .strict()
        .parse(await readServiceJson(request, 1024))
      if (path === '/control/attempts' && request.method === 'POST')
        return serviceJson(response, 201, await budget.issue(input.attemptId, input.leaseToken))
      if (path === '/control/attempts' && request.method === 'DELETE') {
        await budget.revoke(input.attemptId, input.leaseToken)
        return serviceJson(response, 200, { revoked: true })
      }
      return serviceJson(response, 404, { error: 'Unknown control operation' })
    }
    const token = bearer(request)
    if (path === '/attempt-status' && request.method === 'GET') {
      const active = await budget.active(token)
      return serviceJson(response, active ? 200 : 401, { active })
    }
    if (path !== '/v1/messages' || request.method !== 'POST')
      return serviceJson(response, 404, { error: 'Unsupported model operation' })
    if (!process.env.ANTHROPIC_API_KEY) return serviceJson(response, 503, { error: 'Model provider is not configured' })
    const body = await readServiceJson(request, 1024 * 1024)
    const json = JSON.stringify(body)
    const reserved = requestReservation(body, Buffer.byteLength(json))
    const reservation = await budget.reserve(token, reserved)
    const started = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120000)
    const close = () => controller.abort()
    response.once('close', close)
    let checking = false
    const leaseCheck = setInterval(() => {
      if (checking) return
      checking = true
      void budget
        .active(token)
        .then(active => {
          if (!active) controller.abort()
        })
        .catch(() => controller.abort())
        .finally(() => {
          checking = false
        })
    }, 5000)
    let usage: ModelUsage | undefined
    let completed = false
    try {
      const upstream = await fetcher('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta':
            'interleaved-thinking-2025-05-14,context-management-2025-06-27,effort-2025-11-24,thinking-display-updates-2026-08-18',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
        },
        body: json,
      })
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel()
        return serviceJson(response, 502, { error: 'Model provider request failed' })
      }
      const streaming = upstream.headers.get('content-type')?.includes('text/event-stream')
      response.writeHead(200, {
        'Content-Type': streaming ? 'text/event-stream' : 'application/json',
        'Cache-Control': 'no-store',
      })
      let pending = ''
      let received = 0
      const decoder = new TextDecoder()
      const parseEvent = (line: string) => {
        if (!line.startsWith('data: ')) return
        try {
          const event = JSON.parse(line.slice(6))
          if (event.type === 'message_start') usage = event.message?.usage
          if (event.type === 'message_delta') usage = { ...usage, ...event.usage }
          if (event.type === 'message_stop') completed = true
        } catch {
          /* Heartbeats contain no usage. */
        }
      }
      const reader = upstream.body.getReader()
      while (true) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        received += chunk.length
        if (received > 32 * 1024 * 1024) throw new Error('Model response exceeded limit')
        pending += decoder.decode(chunk, { stream: true })
        if (streaming) {
          let newline: number
          while ((newline = pending.indexOf('\n')) !== -1) {
            parseEvent(pending.slice(0, newline).trimEnd())
            pending = pending.slice(newline + 1)
          }
          if (pending.length > 1024 * 1024) throw new Error('Model event exceeded limit')
        }
        await new Promise<void>((resolve, reject) =>
          response.write(chunk, error => (error ? reject(error) : resolve()))
        )
      }
      pending += decoder.decode()
      if (streaming) parseEvent(pending.trimEnd())
      else {
        usage = JSON.parse(pending).usage
        completed = true
      }
      // Settle durable usage before acknowledging successful completion to the caller.
      await budget.finish(reservation, completed ? usage : undefined, Date.now() - started)
      response.end()
    } finally {
      clearTimeout(timeout)
      clearInterval(leaseCheck)
      response.off('close', close)
      controller.abort()
      await budget.finish(reservation, completed ? usage : undefined, Date.now() - started)
    }
  }
  const server = createServer((request, response) => {
    void handler(request, response).catch(error =>
      serviceJson(response, error instanceof ModelBudgetError ? error.status : 400, {
        error: error instanceof ModelBudgetError ? error.message : 'Model gateway could not complete request',
      })
    )
  })
  server.requestTimeout = 150000
  server.headersTimeout = 10000
  server.maxConnections = 32
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = runtimePool()
  const server = createModelGateway(pool).listen(3201, '0.0.0.0')
  const stop = () => {
    server.closeAllConnections()
    server.close(() => {
      void pool.end()
    })
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
