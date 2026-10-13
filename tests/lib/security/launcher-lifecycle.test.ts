import { EventEmitter } from 'node:events'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createExecutionLauncher } from '@/execution-launcher'

const mocks = vi.hoisted(() => ({ docker: vi.fn(), spawn: vi.fn(), fetch: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.docker }),
  spawn: mocks.spawn,
}))

const secret = 'fixture-launcher-service-secret-'.padEnd(43, 'x')
const input = {
  attemptId: '1',
  token: 'fixture-attempt-token-'.padEnd(43, 'x'),
  repoUrl: 'https://github.com/example/repository',
  files: [],
  spec: 'Approved Spec',
  context: 'Repository evidence',
  branchName: 'spec-voice/session/1',
}
const container = `specvoice-attempt-1-${input.token.slice(0, 10).toLowerCase()}`
const result = { type: 'result', patch: 'fixture patch', verification: { exitCode: 0 } }
const releases = new Set<() => void>()
let launcher: Awaited<ReturnType<typeof createExecutionLauncher>>
let port: number
let child: ReturnType<typeof fakeChild>
let create: () => Promise<void>
let stop: () => Promise<void>
let remove: () => Promise<void>

function gate() {
  let release!: () => void
  const wait = new Promise<void>(resolve => {
    release = () => {
      releases.delete(release)
      resolve()
    }
  })
  releases.add(release)
  return { wait, release }
}

function fakeChild() {
  let closed = false
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      finish(137)
      return true
    }),
  })
  function finish(code = 0) {
    if (closed) return
    closed = true
    process.stdout.end()
    process.stderr.end()
    queueMicrotask(() => process.emit('close', code))
  }
  return Object.assign(process, { finish })
}

function send(method: string, path: string, body?: unknown) {
  let request!: ClientRequest
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request = httpRequest(
      { hostname: '127.0.0.1', port, path, method, headers: { Authorization: `Bearer ${secret}` } },
      incoming => {
        let text = ''
        incoming.setEncoding('utf8')
        incoming.on('data', chunk => (text += chunk))
        incoming.once('error', reject)
        incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, body: text }))
      }
    )
    request.once('error', reject)
    request.end(body === undefined ? undefined : JSON.stringify(body))
  })
  return { request, response }
}

const commands = (operation: string) => mocks.docker.mock.calls.filter(([, args]) => args[0] === operation)
const started = () => vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
const expectRejectedResult = (body: string) => {
  expect(body).toContain('"type":"error"')
  expect(body).not.toContain('"type":"result"')
}

beforeEach(async () => {
  vi.stubEnv('SPECVOICE_SERVICE_SECRET', secret)
  vi.stubEnv('SPECVOICE_EXECUTION_DEADLINE_MS', '1800000')
  vi.stubEnv('SPECVOICE_EXECUTION_NETWORK', 'fixture-execution')
  vi.stubEnv('SPECVOICE_EXECUTION_IMAGE', 'fixture-image')
  mocks.docker.mockReset()
  mocks.spawn.mockReset()
  mocks.fetch.mockReset().mockImplementation(async () => Response.json({ active: true }))
  vi.stubGlobal('fetch', mocks.fetch)
  child = fakeChild()
  create = async () => {}
  stop = async () => child.finish()
  remove = async () => {}
  mocks.spawn.mockReturnValue(child)
  mocks.docker.mockImplementation(async (_file: string, args: string[]) => {
    if (args[0] === 'network')
      return {
        stdout: JSON.stringify({
          Internal: true,
          EnableIPv6: false,
          Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
        }),
      }
    if (args[0] === 'image') return { stdout: `sha256:${'a'.repeat(64)}` }
    if (args[0] === 'create') await create()
    if (args[0] === 'stop') await stop()
    if (args[0] === 'rm') await remove()
    return { stdout: '' }
  })
  launcher = await createExecutionLauncher()
  await new Promise<void>((resolve, reject) => {
    launcher.server.once('error', reject)
    launcher.server.listen(0, '127.0.0.1', resolve)
  })
  const address = launcher.server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a local launcher port')
  port = address.port
})

afterEach(async () => {
  for (const release of releases) release()
  child.finish(1)
  launcher?.server.closeAllConnections()
  await launcher?.shutdown().catch(() => {})
  if (launcher) await new Promise<void>(resolve => launcher.server.close(() => resolve()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('execution launcher cancellation and cleanup', () => {
  it.each([
    { Internal: false, EnableIPv6: false, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' } },
    { Internal: true, EnableIPv6: false, Options: {} },
    { Internal: true, EnableIPv6: true, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' } },
  ])('rejects networks that permit direct host or external traffic: %j', async configuration => {
    mocks.docker.mockResolvedValueOnce({ stdout: JSON.stringify(configuration) })
    await expect(createExecutionLauncher()).rejects.toThrow('isolated gateway modes')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('does not create a container after cancellation during the initial lease check', async () => {
    const lease = gate()
    mocks.fetch.mockImplementation(async () => {
      await lease.wait
      return Response.json({ active: true })
    })
    const build = send('POST', '/attempts', input)
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce())
    expect((await send('DELETE', '/attempts/1').response).status).toBe(200)
    lease.release()
    expect((await build.response).status).toBe(400)
    expect(commands('create')).toHaveLength(0)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('waits for a pending create before confirming cancellation and never starts it', async () => {
    const creation = gate()
    create = () => creation.wait
    const build = send('POST', '/attempts', input)
    await vi.waitFor(() => expect(commands('create')).toHaveLength(1))
    let cancelled = false
    const received = new Promise<void>(resolve => launcher.server.once('request', () => resolve()))
    const cancellation = send('DELETE', '/attempts/1').response.then(response => {
      cancelled = true
      return response
    })
    await received
    expect(commands('stop')).toHaveLength(0)
    expect(commands('rm')).toHaveLength(0)
    expect(cancelled).toBe(false)
    creation.release()
    expect((await cancellation).status).toBe(200)
    expect((await build.response).status).toBe(400)
    expect(commands('rm').map(([, args]) => args)).toEqual([['rm', '--force', container]])
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('removes a container created after its worker connection disconnected', async () => {
    const creation = gate()
    create = () => creation.wait
    const closed = new Promise<void>(resolve =>
      launcher.server.once('request', (_request, response) => response.once('close', () => resolve()))
    )
    const build = send('POST', '/attempts', input)
    const disconnected = build.response.catch(() => undefined)
    await vi.waitFor(() => expect(commands('create')).toHaveLength(1))
    build.request.destroy()
    await Promise.all([disconnected, closed])
    expect(commands('rm')).toHaveLength(0)
    creation.release()
    await vi.waitFor(() => expect(commands('rm')).toHaveLength(1))
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it.each(['DELETE', 'deadline', 'invalid lease', 'unavailable lease'])(
    'rejects an already emitted result after %s even when the container exits successfully',
    async reason => {
      const intervals = vi.spyOn(globalThis, 'setInterval')
      const timeouts = vi.spyOn(globalThis, 'setTimeout')
      const build = send('POST', '/attempts', input)
      await started()
      child.stdout.write(`${JSON.stringify(result)}\n`)
      if (reason === 'DELETE') {
        expect((await send('DELETE', '/attempts/1').response).status).toBe(200)
      } else if (reason === 'deadline') {
        const callback = timeouts.mock.calls.find(([, delay]) => delay === 1800000)?.[0]
        if (typeof callback !== 'function') throw new Error('Execution deadline was not scheduled')
        callback()
      } else {
        if (reason === 'invalid lease') mocks.fetch.mockResolvedValue(new Response(null, { status: 401 }))
        else mocks.fetch.mockRejectedValue(new Error('Gateway unavailable'))
        const callback = intervals.mock.calls.find(([, delay]) => delay === 5000)?.[0]
        if (typeof callback !== 'function') throw new Error('Lease polling was not scheduled')
        callback()
      }
      expectRejectedResult((await build.response).body)
      expect(commands('rm')).toHaveLength(1)
    }
  )

  it('rejects cancellation arriving while successful execution is being removed', async () => {
    const removal = gate()
    remove = () => removal.wait
    const build = send('POST', '/attempts', input)
    await started()
    child.stdout.end(`${JSON.stringify(result)}\n`)
    child.finish()
    await vi.waitFor(() => expect(commands('rm')).toHaveLength(1))
    const received = new Promise<void>(resolve => launcher.server.once('request', () => resolve()))
    const cancellation = send('DELETE', '/attempts/1').response
    await received
    removal.release()
    expect((await cancellation).status).toBe(200)
    expectRejectedResult((await build.response).body)
  })

  it('returns a successful result only after removal completes', async () => {
    const removal = gate()
    remove = () => removal.wait
    let completed = false
    const build = send('POST', '/attempts', input).response.then(response => {
      completed = true
      return response
    })
    await started()
    child.stdout.end(`${JSON.stringify(result)}\n`)
    child.finish()
    await vi.waitFor(() => expect(commands('rm')).toHaveLength(1))
    expect(completed).toBe(false)
    removal.release()
    expect(JSON.parse((await build).body)).toEqual(result)
    expect(commands('rm')).toHaveLength(1)
  })

  it('refuses publication and marks readiness failed when removal fails', async () => {
    remove = async () => {
      throw new Error('Docker unavailable')
    }
    const build = send('POST', '/attempts', input)
    await started()
    child.stdout.end(`${JSON.stringify(result)}\n`)
    child.finish()
    expectRejectedResult((await build.response).body)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect((await send('GET', '/health').response).status).toBe(503)
    expect((await send('POST', '/attempts', input).response).status).toBe(409)
  })
})
