import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IsolatedProcessRunner } from '@/lib/build/isolated-runner'
import type { RunOpts } from '@/lib/build/process-runner'
import { makeSession } from '../../fixtures'

const gateway = 'http://model-gateway.test'
const launcher = 'http://execution-launcher.test'
const attemptId = '42'
const leaseToken = '11111111-1111-4111-8111-111111111111'
const secret = 'test-isolated-runner-service-secret-only'
const executionFailure = 'Isolated execution failed. Check the model budget, tool permissions and execution limits.'
let dir: string
let sha: string
let runner: IsolatedProcessRunner
let opts: RunOpts

function git(...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim()
}

function patch(path = 'src/allowed.ts') {
  writeFileSync(join(dir, path), 'implemented change\n')
  const diff = git('diff', '--binary', 'HEAD', '--', path) + '\n'
  git('restore', '--source=HEAD', '--worktree', '--', path)
  return diff
}

function result(patch: string) {
  return { type: 'result', patch, verification: { exitCode: 0 } }
}

function response(...events: unknown[]) {
  return new Response(events.map(event => JSON.stringify(event) + '\n').join(''))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function services(
  launch: (signal?: AbortSignal | null) => Response | Promise<Response>,
  overrides: {
    issue?: () => Response | Promise<Response>
    stop?: () => Response | Promise<Response>
    revoke?: () => Response | Promise<Response>
  } = {}
) {
  const transport = vi.fn<typeof fetch>(async (url, options) => {
    if (url === `${gateway}/control/attempts` && options?.method === 'POST')
      return overrides.issue?.() ?? Response.json({ token: 'test-attempt-model-capability' })
    if (url === `${launcher}/attempts` && options?.method === 'POST') return launch(options.signal)
    if (url === `${launcher}/attempts/${attemptId}` && options?.method === 'DELETE')
      return overrides.stop?.() ?? Response.json({ stopped: true })
    if (url === `${gateway}/control/attempts` && options?.method === 'DELETE')
      return overrides.revoke?.() ?? Response.json({ revoked: true })
    throw new Error(`Unexpected test service request: ${options?.method} ${url}`)
  })
  vi.stubGlobal('fetch', transport)
  return transport
}

function cleanupCalls(transport: ReturnType<typeof services>) {
  return transport.mock.calls.filter(([, options]) => options?.method === 'DELETE')
}

beforeEach(() => {
  vi.stubEnv('SPECVOICE_SERVICE_SECRET', secret)
  vi.stubEnv('SPECVOICE_MODEL_GATEWAY_URL', gateway)
  vi.stubEnv('SPECVOICE_EXECUTION_LAUNCHER_URL', launcher)
  dir = mkdtempSync(join(tmpdir(), 'specvoice-isolated-runner-test-'))
  git('init', '--quiet')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/allowed.ts'), 'original content\n')
  writeFileSync(join(dir, 'outside.ts'), 'outside content\n')
  git('add', '--all')
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture'
  )
  sha = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'SPEC.md'), '# Bounded fixture spec')
  writeFileSync(join(dir, 'CONTEXT.md'), '# Fixture context')
  const session = makeSession({
    repositorySha: sha,
    scopePlan: {
      id: 'test-scope',
      repositorySha: sha,
      includedRoots: ['src'],
      excludedRoots: [],
      estimatedFiles: 1,
      estimatedBytes: 17,
      dependencyBoundaries: [],
      reason: 'Only edit src.',
      status: 'confirmed',
      createdAt: new Date().toISOString(),
    },
  })
  runner = new IsolatedProcessRunner(attemptId, leaseToken, session)
  opts = { dir, branchName: 'spec-voice/test-session/42', commitMessage: 'feat: bounded fixture', onProgress: vi.fn() }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('IsolatedProcessRunner', () => {
  it('exports only scoped files and applies a verified patch after both cleanup acknowledgements', async () => {
    const stop = deferred<Response>()
    const revoke = deferred<Response>()
    const transport = services(() => response(result(patch())), {
      stop: () => stop.promise,
      revoke: () => revoke.promise,
    })
    const running = runner.run(opts)
    await vi.waitFor(() => expect(cleanupCalls(transport)).toHaveLength(2))
    expect(git('rev-parse', 'HEAD')).toBe(sha)
    stop.resolve(Response.json({ stopped: true }))
    await Promise.resolve()
    expect(git('rev-parse', 'HEAD')).toBe(sha)
    revoke.resolve(Response.json({ revoked: true }))
    await running
    expect(git('rev-parse', 'HEAD^')).toBe(sha)
    expect(readFileSync(join(dir, 'src/allowed.ts'), 'utf8')).toBe('implemented change\n')
    const launched = transport.mock.calls.find(
      ([url, options]) => url === `${launcher}/attempts` && options?.method === 'POST'
    )
    expect(JSON.parse(String(launched?.[1]?.body))).toMatchObject({
      attemptId,
      token: 'test-attempt-model-capability',
      branchName: opts.branchName,
      spec: '# Bounded fixture spec',
      context: '# Fixture context',
      files: [
        { path: 'src/allowed.ts', content: Buffer.from('original content\n').toString('base64'), mode: '100644' },
      ],
    })
    expect(
      transport.mock.calls.every(
        ([, options]) => new Headers(options?.headers).get('Authorization') === `Bearer ${secret}`
      )
    ).toBe(true)
  })

  it('awaits progress persistence before processing later results or cleaning up', async () => {
    const persisted = deferred<void>()
    const progress = vi.fn(() => persisted.promise)
    const transport = services(() =>
      response({ type: 'progress', phase: 'writing', detail: 'src/allowed.ts' }, result(patch()))
    )
    const running = runner.run({ ...opts, onProgress: progress })
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith('writing', 'Applying approved changes'))
    expect(cleanupCalls(transport)).toHaveLength(0)
    expect(git('rev-parse', 'HEAD')).toBe(sha)
    persisted.resolve()
    await running
    expect(cleanupCalls(transport)).toHaveLength(2)
    expect(git('rev-parse', 'HEAD')).not.toBe(sha)
  })

  it('cleans up and refuses publication when progress persistence fails', async () => {
    const transport = services(() =>
      response({ type: 'progress', phase: 'writing', detail: 'src/allowed.ts' }, result(patch()))
    )
    await expect(
      runner.run({
        ...opts,
        onProgress: async () => {
          throw new Error('Persistence unavailable')
        },
      })
    ).rejects.toThrow('Persistence unavailable')
    expect(cleanupCalls(transport)).toHaveLength(2)
    expect(git('rev-parse', 'HEAD')).toBe(sha)
  })

  it('replaces repository-controlled progress text with fixed phase descriptions', async () => {
    const transcript = 'Private transcript: the customer discussed an unreleased acquisition'
    services(() =>
      response(
        ...['analyzing', 'writing', 'reviewing'].map(phase => ({ type: 'progress', phase, detail: transcript })),
        result(patch())
      )
    )
    await runner.run(opts)
    expect(opts.onProgress).toHaveBeenNthCalledWith(1, 'analyzing', 'Reading repository files')
    expect(opts.onProgress).toHaveBeenNthCalledWith(2, 'writing', 'Applying approved changes')
    expect(opts.onProgress).toHaveBeenNthCalledWith(3, 'reviewing', 'Running repository checks')
    expect(opts.onProgress).toHaveBeenCalledTimes(3)
  })

  it.each([
    'Private transcript: customer acquisition plans',
    'npm test failed with exit code 1: Private transcript: customer acquisition plans',
    'Unsupported repository: package.json is not valid JSON\nPrivate transcript: customer acquisition plans',
    'Claude Code timed out after 900000ms: Private transcript: customer acquisition plans',
    'npm test failed with exit code 123456789',
    'npm test failed with exit code 256',
    { transcript: 'Private customer acquisition plans' },
  ])('does not forward untrusted execution errors: %j', async error => {
    const transport = services(() => response({ type: 'error', error }))
    await expect(runner.run(opts)).rejects.toMatchObject({ message: executionFailure })
    expect(cleanupCalls(transport)).toHaveLength(2)
    expect(git('rev-parse', 'HEAD')).toBe(sha)
    expect(opts.onProgress).not.toHaveBeenCalled()
  })

  it.each([
    ['Unsupported repository: root package.json and package-lock.json are required'],
    ['Unsupported repository: package.json is not valid JSON'],
    ['Unsupported repository: package.json must define a nonempty scripts.test'],
    ['npm ci failed with exit code 1'],
    ['npm test failed with exit code 255'],
    ['npm ci timed out'],
    ['npm test timed out'],
    ['Claude Code timed out after 900000ms', 'Claude Code execution timed out.'],
  ])('preserves bounded toolchain diagnostics: %s', async (error, expected = error) => {
    const transport = services(() => response({ type: 'error', error }))
    await expect(runner.run(opts)).rejects.toMatchObject({ message: expected })
    expect(cleanupCalls(transport)).toHaveLength(2)
    expect(git('rev-parse', 'HEAD')).toBe(sha)
  })

  it('does not expose invalid JSON fragments through native parser error messages', async () => {
    const transport = services(() => new Response('Private transcript: customer acquisition plans\n'))
    await expect(runner.run(opts)).rejects.toMatchObject({ message: executionFailure })
    expect(cleanupCalls(transport)).toHaveLength(2)
    expect(git('rev-parse', 'HEAD')).toBe(sha)
  })

  it.each(['launcher', 'gateway'])('still attempts both cleanup requests when %s cleanup fails', async failing => {
    const fail = async () => {
      throw new Error('Cleanup unavailable')
    }
    const transport = services(
      () => response(result(patch())),
      failing === 'launcher' ? { stop: fail } : { revoke: fail }
    )
    await expect(runner.run(opts)).rejects.toThrow('Execution cleanup is not confirmed')
    expect(
      cleanupCalls(transport)
        .map(([url]) => url)
        .sort()
    ).toEqual([`${launcher}/attempts/${attemptId}`, `${gateway}/control/attempts`].sort())
    expect(git('rev-parse', 'HEAD')).toBe(sha)
  })

  it('refuses publication when cleanup returns a non-success status', async () => {
    const transport = services(() => response(result(patch())), { stop: () => new Response('busy', { status: 503 }) })
    await expect(runner.run(opts)).rejects.toThrow('Execution cleanup is not confirmed')
    expect(cleanupCalls(transport)).toHaveLength(2)
    expect(git('rev-parse', 'HEAD')).toBe(sha)
  })

  it('does not launch execution when model credential issuance fails', async () => {
    const launch = vi.fn(() => response(result(patch())))
    const transport = services(launch, { issue: () => new Response('already issued', { status: 409 }) })
    await expect(runner.run(opts)).rejects.toThrow('Cannot issue a fresh model budget')
    expect(launch).not.toHaveBeenCalled()
    expect(transport).toHaveBeenCalledOnce()
    expect(git('rev-parse', 'HEAD')).toBe(sha)
  })

  it('cleans up an issued capability after launcher rejection without publishing', async () => {
    const transport = services(() => new Response('rejected', { status: 503 }))
    await expect(runner.run(opts)).rejects.toThrow('Execution launcher rejected')
    expect(cleanupCalls(transport)).toHaveLength(2)
    expect(git('rev-parse', 'HEAD')).toBe(sha)
  })

  it.each(['partial', 'unverified', 'duplicate', 'invalid progress'])(
    'rejects a %s execution response without a commit',
    async kind => {
      const completed = result(patch())
      const transport = services(() => {
        if (kind === 'partial') return new Response(JSON.stringify(completed))
        if (kind === 'unverified') return response({ ...completed, verification: { exitCode: 1 } })
        if (kind === 'duplicate') return response(completed, completed)
        return response({ type: 'progress', phase: 'publishing', detail: 'not an execution phase' }, completed)
      })
      await expect(runner.run(opts)).rejects.toThrow(/verified patch|Isolated execution failed/)
      expect(cleanupCalls(transport)).toHaveLength(2)
      expect(git('rev-parse', 'HEAD')).toBe(sha)
    }
  )

  it('rejects an otherwise verified out-of-scope patch through the real publication boundary', async () => {
    const transport = services(() => response(result(patch('outside.ts'))))
    await expect(runner.run(opts)).rejects.toThrow('outside the accepted Scope Plan')
    expect(cleanupCalls(transport)).toHaveLength(2)
  })

  it('propagates cancellation while streaming and uses fresh signals for cleanup', async () => {
    const controller = new AbortController()
    const progress = vi.fn()
    let executionSignal: AbortSignal | null | undefined
    const transport = services(signal => {
      executionSignal = signal
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ type: 'progress', phase: 'analyzing', detail: 'src/allowed.ts' }) + '\n'
              )
            )
            signal?.addEventListener('abort', () => stream.error(signal.reason), { once: true })
          },
        })
      )
    })
    const running = runner.run({ ...opts, signal: controller.signal, onProgress: progress })
    const rejected = expect(running).rejects.toThrow('Worker ownership lost')
    await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce())
    controller.abort(new Error('Worker ownership lost'))
    await rejected
    expect(executionSignal?.aborted).toBe(true)
    expect(cleanupCalls(transport)).toHaveLength(2)
    expect(cleanupCalls(transport).every(([, options]) => options?.signal && !options.signal.aborted)).toBe(true)
    expect(git('rev-parse', 'HEAD')).toBe(sha)
  })

  it('checks cancellation again after cleanup, before applying a returned patch', async () => {
    const controller = new AbortController()
    const transport = services(() => response(result(patch())), {
      stop: () => {
        controller.abort(new Error('Cancelled during cleanup'))
        return Response.json({ stopped: true })
      },
    })
    await expect(runner.run({ ...opts, signal: controller.signal })).rejects.toThrow('Cancelled during cleanup')
    expect(cleanupCalls(transport)).toHaveLength(2)
    expect(git('rev-parse', 'HEAD')).toBe(sha)
  })
})
