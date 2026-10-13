import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export async function readServiceJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('Request body exceeds its limit')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function serviceJson(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed) return
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

export function bearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
}

export function serviceAuthorized(request: IncomingMessage, secret: string | undefined): boolean {
  const token = bearer(request)
  return Boolean(
    secret &&
      secret.length >= 32 &&
      Buffer.byteLength(token) === Buffer.byteLength(secret) &&
      timingSafeEqual(Buffer.from(token), Buffer.from(secret))
  )
}
