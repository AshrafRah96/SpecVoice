import type { ChildProcess, SpawnOptions } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeProcessRunner, FakeProcessRunner, type RunOpts } from '@/lib/build/process-runner'

const fixture = vi.hoisted(() => ({
  script: '',
  child: undefined as ChildProcess | undefined,
  options: undefined as SpawnOptions | undefined,
  spawn: vi.fn(),
}))

vi.mock('child_process', async importOriginal => {
  const original = await importOriginal<typeof import('child_process')>()
  return {
    ...original,
    spawn: fixture.spawn.mockImplementation((_command, _args, options: SpawnOptions) => {
      fixture.options = options
      fixture.child = original.spawn(process.execPath, ['-e', fixture.script], options)
      return fixture.child
    }),
  }
})

const progress = (path: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path } }] },
  })

describe('ClaudeProcessRunner lifetime', () => {
  let dir: string
  let opts: RunOpts
  const safeNpmDir = () => fixture.options!.env!.PATH!.split(':')[0]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'specvoice-runner-test-'))
    fixture.spawn.mockClear()
    fixture.child = undefined
    fixture.options = undefined
    fixture.script = ''
    opts = { dir, branchName: 'spec-voice/test', commitMessage: 'test', onProgress: vi.fn() }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    if (fixture.child?.pid) {
      try {
        if (process.platform !== 'win32') process.kill(-fixture.child.pid, 'SIGKILL')
        else fixture.child.kill('SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not spawn for a previously cancelled request', async () => {
    await expect(new ClaudeProcessRunner().run({ ...opts, signal: AbortSignal.abort() })).rejects.toThrow('cancelled')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('awaits progress in order before resolving and removes temporary npm configuration', async () => {
    fixture.script = `process.stdout.write(${JSON.stringify(`${progress('first')}\n${progress('second')}\n`)})`
    const seen: string[] = []
    let active = 0
    await new ClaudeProcessRunner().run({
      ...opts,
      onProgress: async (_phase, detail) => {
        expect(active++).toBe(0)
        expect(existsSync(safeNpmDir())).toBe(true)
        await new Promise(resolve => setTimeout(resolve, 30))
        seen.push(detail)
        active--
      },
    })
    expect(seen).toEqual(['first', 'second'])
    expect(fixture.child!.exitCode).toBe(0)
    expect(existsSync(safeNpmDir())).toBe(false)
    expect(fixture.spawn.mock.calls[0][1]).toContain('80')
  })

  it('terminates and waits for close when progress persistence rejects', async () => {
    fixture.script = `process.stdout.write(${JSON.stringify(`${progress('first')}\n${progress('second')}\n`)}); setInterval(() => {}, 1000)`
    let closed = false
    const onProgress = vi.fn(async () => {
      fixture.child!.on('close', () => {
        closed = true
      })
      throw new Error('storage unavailable')
    })
    await expect(new ClaudeProcessRunner().run({ ...opts, onProgress })).rejects.toThrow('storage unavailable')
    expect(closed).toBe(true)
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(existsSync(safeNpmDir())).toBe(false)
  })

  it('bounds runtime and waits for termination before cleaning up', async () => {
    fixture.script = 'setInterval(() => {}, 1000)'
    await expect(new ClaudeProcessRunner().run({ ...opts, timeoutMs: 100 })).rejects.toThrow('timed out after 100ms')
    expect(fixture.child!.signalCode).toBe('SIGTERM')
    expect(existsSync(safeNpmDir())).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'kills descendants and escalates after five seconds if SIGTERM is ignored',
    async () => {
      const controller = new AbortController()
      fixture.script = `
      process.on('SIGTERM', () => {});
      const child = require('child_process').spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"
      ], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.once('data', () => process.stdout.write(${JSON.stringify(`${progress('ready')}\n`)}));
      setInterval(() => {}, 1000);
    `
      let closed = false
      let abortTime = 0
      let childClosed: Promise<void> | undefined
      await expect(
        new ClaudeProcessRunner().run({
          ...opts,
          signal: controller.signal,
          onProgress: () => {
            childClosed = new Promise(resolve =>
              fixture.child!.once('close', () => {
                expect(existsSync(safeNpmDir())).toBe(true)
                closed = true
                resolve()
              })
            )
            abortTime = Date.now()
            controller.abort()
            expect(closed).toBe(false)
            expect(existsSync(safeNpmDir())).toBe(true)
          },
        })
      ).rejects.toThrow('cancelled')
      await childClosed
      expect(closed).toBe(true)
      expect(Date.now() - abortTime).toBeGreaterThanOrEqual(4900)
      expect(fixture.child!.signalCode).toBe('SIGKILL')
      expect(existsSync(safeNpmDir())).toBe(false)
    },
    10_000
  )

  it('rejects a terminal failure even if the process exits successfully', async () => {
    fixture.script = 'process.stdout.write(JSON.stringify({type:"result", subtype:"error_max_turns"}) + "\\n")'
    await expect(new ClaudeProcessRunner().run(opts)).rejects.toThrow('error_max_turns')
    expect(existsSync(safeNpmDir())).toBe(false)
  })

  it('cleans temporary configuration after an asynchronous spawn error', async () => {
    await expect(new ClaudeProcessRunner().run({ ...opts, dir: join(dir, 'missing') })).rejects.toThrow('ENOENT')
    expect(existsSync(safeNpmDir())).toBe(false)
  })

  it('bounds stderr, redacts known secrets, and excludes worker credentials from the child', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-provider-secret')
    vi.stubEnv('GITHUB_TOKEN', 'test-github-secret')
    vi.stubEnv('DATABASE_URL', 'test-database-secret')
    fixture.script = 'process.stderr.write("x".repeat(100000) + process.env.ANTHROPIC_API_KEY, () => process.exit(1))'
    const error = await new ClaudeProcessRunner().run(opts).catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message.length).toBeLessThan(66_000)
    expect((error as Error).message).toContain('[REDACTED]')
    expect((error as Error).message).not.toContain('test-provider-secret')
    expect(fixture.options!.env!.GITHUB_TOKEN).toBeUndefined()
    expect(fixture.options!.env!.DATABASE_URL).toBeUndefined()
  })

  it('makes the fake runner honor asynchronous progress failures', async () => {
    const onProgress = vi.fn(async () => {
      throw new Error('storage unavailable')
    })
    await expect(new FakeProcessRunner().run({ ...opts, onProgress })).rejects.toThrow('storage unavailable')
    expect(onProgress).toHaveBeenCalledTimes(1)
  })
})
