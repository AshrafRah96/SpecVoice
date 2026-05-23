import { describe, it, expect, afterEach } from 'vitest'
import { z } from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { createToolHandler, createCodeToolHandler } from '@/lib/api/tool-handler'
import { InMemoryCodeSource, registerCodeSource } from '@/lib/code/index'

function makeRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeInvalidRequest(url: string): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json{{{',
  })
}

const echoSchema = z.object({ value: z.string() })
const echoHandler = createToolHandler(echoSchema, async (_session, input) =>
  NextResponse.json({ value: input.value })
)

describe('createToolHandler', () => {
  it('returns 400 for non-JSON body', async () => {
    const req = makeInvalidRequest('http://localhost/api/tools/echo')
    const res = await echoHandler(req)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/valid JSON/)
  })

  it('returns 400 when session_id is missing', async () => {
    const req = makeRequest('http://localhost/api/tools/echo', { value: 'hi' })
    const res = await echoHandler(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 when domain schema validation fails', async () => {
    const session = sessionStore.createSession()
    const req = makeRequest('http://localhost/api/tools/echo', {
      session_id: session.id,
      // missing required `value`
    })
    const res = await echoHandler(req)
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown session_id', async () => {
    const req = makeRequest('http://localhost/api/tools/echo', {
      session_id: 'nonexistent-id',
      value: 'hi',
    })
    const res = await echoHandler(req)
    expect(res.status).toBe(404)
  })

  it('calls fn with session and validated input on valid request', async () => {
    const session = sessionStore.createSession()
    const req = makeRequest('http://localhost/api/tools/echo', {
      session_id: session.id,
      value: 'hello',
    })
    const res = await echoHandler(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ value: 'hello' })
  })

  it('returns 500 when fn throws', async () => {
    const throwingHandler = createToolHandler(echoSchema, async () => {
      throw new Error('something went wrong')
    })
    const session = sessionStore.createSession()
    const req = makeRequest('http://localhost/api/tools/echo', {
      session_id: session.id,
      value: 'hi',
    })
    const res = await throwingHandler(req)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('something went wrong')
  })

  it('strips session_id from input passed to fn', async () => {
    let capturedInput: Record<string, unknown> = {}
    const captureHandler = createToolHandler(echoSchema, async (_session, input) => {
      capturedInput = input as Record<string, unknown>
      return NextResponse.json({})
    })
    const session = sessionStore.createSession()
    await captureHandler(
      makeRequest('http://localhost/api/tools/echo', {
        session_id: session.id,
        value: 'test',
      })
    )
    expect(capturedInput).not.toHaveProperty('session_id')
    expect(capturedInput).toEqual({ value: 'test' })
  })
})

describe('createCodeToolHandler', () => {
  let deregister: (() => void) | undefined
  afterEach(() => { deregister?.(); deregister = undefined })

  it('passes a CodeSource to fn alongside session and input', async () => {
    let receivedSource: unknown = null
    const handler = createCodeToolHandler(echoSchema, async (_session, source, input) => {
      receivedSource = source
      return NextResponse.json({ value: input.value })
    })
    const session = sessionStore.createSession()
    deregister = registerCodeSource(session.id, new InMemoryCodeSource({ 'src/a.ts': 'hello' }))
    const req = makeRequest('http://localhost/api/tools/echo', {
      session_id: session.id,
      value: 'hi',
    })
    const res = await handler(req)
    expect(res.status).toBe(200)
    expect(receivedSource).toBeInstanceOf(InMemoryCodeSource)
  })

  it('InMemoryCodeSource.readFile returns injected file content', async () => {
    let capturedContent = ''
    const readSchema = z.object({ path: z.string() })
    const handler = createCodeToolHandler(readSchema, async (_session, source, input) => {
      const file = await source.readFile(input.path)
      capturedContent = file.content
      return NextResponse.json({})
    })
    const session = sessionStore.createSession()
    deregister = registerCodeSource(session.id, new InMemoryCodeSource({ 'src/foo.ts': 'export const x = 1' }))
    await handler(makeRequest('http://localhost/api/tools/read', { session_id: session.id, path: 'src/foo.ts' }))
    expect(capturedContent).toBe('export const x = 1')
  })
})
