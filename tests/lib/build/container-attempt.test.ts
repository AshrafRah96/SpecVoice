import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runGit } from '@/lib/build/clone'
import { executeContainerAttempt, type ContainerAttemptInput } from '@/execution/attempt'
import type { RunOpts } from '@/lib/build/process-runner'

const model = vi.hoisted(() => ({ run: vi.fn<(options: RunOpts) => Promise<void>>() }))
vi.mock('@/lib/build/process-runner', () => ({
  ClaudeProcessRunner: class {
    run = model.run
  },
}))

const file = (path: string, content: string, mode: '100644' | '100755' = '100644') => ({
  path,
  content: Buffer.from(content).toString('base64'),
  mode,
})

function fixture(
  test = `node -e "if(require('fs').readFileSync('value.txt','utf8') !== 'after') process.exit(1)"`
): ContainerAttemptInput {
  const packageJson = {
    name: 'container-fixture',
    version: '1.0.0',
    scripts: {
      test,
      preinstall: 'node -e "process.exit(51)"',
      pretest: 'node -e "process.exit(52)"',
      posttest: 'node -e "process.exit(53)"',
    },
  }
  return {
    files: [
      file('package.json', JSON.stringify(packageJson)),
      file(
        'package-lock.json',
        JSON.stringify({
          name: packageJson.name,
          version: packageJson.version,
          lockfileVersion: 3,
          packages: { '': { name: packageJson.name, version: packageJson.version, hasInstallScript: true } },
        })
      ),
      file('value.txt', 'before'),
      file('executable.sh', '#!/bin/sh\nexit 0\n', '100755'),
    ],
    spec: 'Change value.txt to after.',
    context: 'Synthetic container test.',
    branchName: 'spec-voice/test/1',
  }
}

describe('disposable container attempt', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'specvoice-container-test-'))
    vi.stubEnv('SPECVOICE_EXECUTION_ROOT', root)
    vi.stubEnv('SPECVOICE_ALLOW_INSTALL_SCRIPTS', '')
    vi.stubEnv('npm_config_cache', join(root, 'npm-cache'))
    model.run.mockReset()
    model.run.mockImplementation(async opts => {
      await opts.onProgress('writing', 'value.txt')
      await runGit(['-C', opts.dir, 'checkout', '-b', opts.branchName], process.env, opts.signal)
      writeFileSync(join(opts.dir, 'value.txt'), 'after')
      await runGit(['-C', opts.dir, 'add', '--', 'value.txt'], process.env, opts.signal)
      await runGit(['-C', opts.dir, 'commit', '-m', 'Update fixture'], process.env, opts.signal)
    })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it.each([
    '../escape',
    '/absolute',
    'src/../escape',
    'src/*',
    '.git/config',
    'src/.GIT/config',
    'SPEC.md',
    'CONTEXT.md/nested',
  ])('rejects unsafe input path %s before execution', async path => {
    const input = fixture()
    input.files.push(file(path, 'unsafe'))
    await expect(executeContainerAttempt(input)).rejects.toThrow()
    expect(model.run).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'repo'))).toBe(false)
  })

  it('rejects duplicate paths, file/directory collisions, malformed base64, and excessive file counts', async () => {
    const input = fixture()
    await expect(
      executeContainerAttempt({ ...input, files: [...input.files, file('value.txt', 'duplicate')] })
    ).rejects.toThrow('Duplicate')
    await expect(
      executeContainerAttempt({ ...input, files: [...input.files, file('value.txt/nested', 'collision')] })
    ).rejects.toThrow('collision')
    await expect(
      executeContainerAttempt({ ...input, files: [...input.files, { ...file('invalid', ''), content: '?not-base64' }] })
    ).rejects.toThrow('base64')
    await expect(executeContainerAttempt({ ...input, files: Array(100_001).fill(file('x', '')) })).rejects.toThrow(
      'Invalid'
    )
    expect(model.run).not.toHaveBeenCalled()
  })

  it('caps decoded repository bytes before running Git or Claude', async () => {
    const input = fixture()
    input.files.push({ ...file('large', ''), content: 'A'.repeat(4 * Math.ceil((64 * 1024 * 1024 + 1) / 3)) })
    await expect(executeContainerAttempt(input)).rejects.toThrow('64 MiB')
    expect(model.run).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'repo'))).toBe(false)
  })

  it.each(['package.json', 'package-lock.json'])(
    'rejects a repository missing %s before calling Claude',
    async missing => {
      const input = fixture()
      input.files = input.files.filter(item => item.path !== missing)
      await expect(executeContainerAttempt(input)).rejects.toThrow('Unsupported repository')
      expect(model.run).not.toHaveBeenCalled()
    }
  )

  it.each(['{}', '{"scripts":{"test":"  "}}', 'not json'])(
    'requires a parseable Node test contract: %s',
    async content => {
      const input = fixture()
      input.files[0] = file('package.json', content)
      await expect(executeContainerAttempt(input)).rejects.toThrow('Unsupported repository')
      expect(model.run).not.toHaveBeenCalled()
    }
  )

  it('rejects invalid branch names and pre-cancelled attempts without starting a model', async () => {
    await expect(executeContainerAttempt({ ...fixture(), branchName: 'test; echo unsafe' })).rejects.toThrow('Invalid')
    await expect(executeContainerAttempt(fixture(), { signal: AbortSignal.abort() })).rejects.toThrow()
    expect(model.run).not.toHaveBeenCalled()
  })

  it('installs without lifecycle scripts, runs the real test command, and returns only the committed patch', async () => {
    const onProgress = vi.fn()
    const result = await executeContainerAttempt(fixture(), { onProgress })
    expect(result.verification).toEqual({ command: 'npm test --ignore-scripts', exitCode: 0 })
    expect(result.patch).toContain('-before')
    expect(result.patch).toContain('+after')
    expect(result.patch).not.toContain('SPEC.md')
    expect(result.patch).not.toContain('CONTEXT.md')
    expect(onProgress).toHaveBeenCalledWith('writing', 'value.txt')
    expect(statSync(join(root, 'repo', 'executable.sh')).mode & 0o111).toBe(0o111)
    expect(await runGit(['-C', join(root, 'repo'), 'status', '--porcelain'])).toBe('')
  }, 15_000)

  it('honors the server-owned install lifecycle override before Claude', async () => {
    vi.stubEnv('SPECVOICE_ALLOW_INSTALL_SCRIPTS', 'true')
    await expect(executeContainerAttempt(fixture())).rejects.toThrow('npm ci failed')
    expect(model.run).not.toHaveBeenCalled()
  }, 15_000)

  it('rejects generated code whose actual npm test fails', async () => {
    await expect(executeContainerAttempt(fixture('node -e "process.exit(7)"'))).rejects.toThrow('npm test failed')
    expect(model.run).toHaveBeenCalledOnce()
  }, 15_000)

  it('rejects an uncommitted model output even when tests pass', async () => {
    model.run.mockImplementation(async opts => {
      writeFileSync(join(opts.dir, 'value.txt'), 'after')
    })
    await expect(executeContainerAttempt(fixture())).rejects.toThrow('uncommitted changes')
  }, 15_000)

  it('will not reuse an existing checkout', async () => {
    await executeContainerAttempt(fixture())
    await expect(executeContainerAttempt(fixture())).rejects.toThrow('EEXIST')
    expect(model.run).toHaveBeenCalledOnce()
  }, 15_000)

  it.skipIf(process.platform === 'win32')(
    'awaits cancellation of a running npm test and its child',
    async () => {
      const input = fixture('node wait.cjs')
      input.files.push(
        file(
          'wait.cjs',
          "require('fs').writeFileSync('.git/test.pid', String(process.pid)); setInterval(() => {}, 1000)"
        )
      )
      const controller = new AbortController()
      const attempt = executeContainerAttempt(input, { signal: controller.signal })
      const rejected = expect(attempt).rejects.toThrow('cancelled')
      const pidPath = join(root, 'repo', '.git', 'test.pid')
      await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true), { timeout: 10_000 })
      const pid = Number(readFileSync(pidPath, 'utf8'))
      controller.abort()
      await rejected
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1000 })
    },
    15_000
  )
})
