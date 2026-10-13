import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyExecutionPatch, executionFiles } from '@/lib/build/publication'
import type { ScopePlan } from '@/lib/session/types'
import { makeSession } from '../../fixtures'

let dir: string
let sha: string

function git(...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
}
function write(path: string, content: string | Buffer) {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), content)
}
function commit() {
  git('add', '--all', '--force')
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
  return git('rev-parse', 'HEAD').trim()
}
function scope(overrides: Partial<ScopePlan> = {}): ScopePlan {
  return {
    id: 'execution-scope',
    repositorySha: sha,
    includedRoots: ['src'],
    excludedRoots: ['src/excluded'],
    estimatedFiles: 10,
    estimatedBytes: 1000,
    dependencyBoundaries: [],
    reason: 'Fixture',
    status: 'confirmed',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
function session(plan: ScopePlan | null = scope()) {
  return makeSession({ repositorySha: sha, scopePlan: plan })
}
function makePatch(change: () => void) {
  change()
  git('add', '--all', '--force')
  const patch = git('diff', '--binary', 'HEAD')
  git('restore', '--source=HEAD', '--staged', '--worktree', '--', '.')
  return patch
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'specvoice-publication-test-'))
  git('init', '--quiet')
  write('src/allowed.ts', 'original allowed content\n')
  write('src/excluded/generated.ts', 'excluded content\n')
  write('outside/secret.ts', 'outside content\n')
  write('src/binary.dat', Buffer.from([0, 255, 1, 128]))
  write('src/run.sh', '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'src/run.sh'), 0o755)
  sha = commit()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('execution file export', () => {
  it('exports scoped tracked bytes and executable modes without untracked files or generated inputs', async () => {
    write('src/untracked.ts', 'not committed')
    write('SPEC.md', 'generated input')
    write('CONTEXT.md', 'generated input')
    const files = await executionFiles(dir, scope())
    expect(files.map(file => file.path)).toEqual(['src/allowed.ts', 'src/binary.dat', 'src/run.sh'])
    expect(Buffer.from(files[1].content, 'base64')).toEqual(Buffer.from([0, 255, 1, 128]))
    expect(files[2].mode).toBe('100755')
    expect(files[0].mode).toBe('100644')
  })

  it('never exports tracked build inputs, credentials or Git metadata', async () => {
    write('SPEC.md', 'tracked input')
    write('CONTEXT.md', 'tracked context')
    write('.env.local', 'fixture-only value')
    commit()
    const files = await executionFiles(dir)
    expect(files.some(file => ['SPEC.md', 'CONTEXT.md', '.env.local'].includes(file.path))).toBe(false)
    expect(files.some(file => file.path.startsWith('.git/'))).toBe(false)
  })

  it('uses literal explicit-file roots and excludes unwanted paths before reading them', async () => {
    write('src/file with spaces.ts', 'permitted\n')
    symlinkSync('../outside/secret.ts', join(dir, 'src/excluded/link'))
    sha = commit()
    const files = await executionFiles(dir, scope({ includedRoots: ['src/file with spaces.ts'] }))
    expect(files).toEqual([
      { path: 'src/file with spaces.ts', content: Buffer.from('permitted\n').toString('base64'), mode: '100644' },
    ])
    await expect(executionFiles(dir, scope())).resolves.toHaveLength(4)
  })

  it('rejects dirty tracked bytes instead of exporting content outside the pinned snapshot', async () => {
    write('src/allowed.ts', 'dirty workspace bytes')
    await expect(executionFiles(dir, scope())).rejects.toThrow(/clean trusted checkout/)
  })

  it('checks tracked content even when Git is configured to assume the file is unchanged', async () => {
    git('update-index', '--assume-unchanged', 'src/allowed.ts')
    write('src/allowed.ts', 'hidden dirty bytes')
    await expect(executionFiles(dir, scope())).rejects.toThrow(/differ from the pinned commit/)
  })

  it('rejects tracked symlinks', async () => {
    symlinkSync('../outside/secret.ts', join(dir, 'src/link'))
    sha = commit()
    await expect(executionFiles(dir, scope())).rejects.toThrow(/symlinks or submodules: src\/link/)
  })

  it('rejects Git submodule entries without exporting their working trees', async () => {
    git('update-index', '--add', '--cacheinfo', '160000', sha, 'src/submodule')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'submodule'
    )
    sha = git('rev-parse', 'HEAD').trim()
    await expect(executionFiles(dir, scope())).rejects.toThrow(/symlinks or submodules: src\/submodule/)
  })

  it('requires a narrower scope when selected tracked content exceeds 64 MiB', async () => {
    write('src/large.bin', Buffer.alloc(64 * 1024 * 1024 + 1))
    sha = commit()
    await expect(executionFiles(dir, scope())).rejects.toThrow(/64 MiB.*narrower Scope Plan/)
  })

  it('rejects more than 100000 selected files before reading their contents', async () => {
    const blob = git('rev-parse', 'HEAD:src/allowed.ts').trim()
    const input = Array.from({ length: 100001 }, (_, index) => `100644 ${blob}\tsrc/many/${index}.ts\n`).join('')
    execFileSync('git', ['-C', dir, 'update-index', '--index-info'], { input, stdio: ['pipe', 'pipe', 'pipe'] })
    await expect(executionFiles(dir, scope())).rejects.toThrow(/100000 files.*narrower Scope Plan/)
  })

  it('rejects unconfirmed or mismatched scope and honors cancellation', async () => {
    await expect(executionFiles(dir, scope({ status: 'proposed' }))).rejects.toThrow(/confirmed Scope Plan/)
    await expect(executionFiles(dir, scope({ repositorySha: 'f'.repeat(40) }))).rejects.toThrow(/does not match/)
    await expect(executionFiles(dir, scope(), AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
  })
})

describe('trusted execution patch publication', () => {
  it('commits an allowed binary patch with the pinned parent and fixed author', async () => {
    const patch = makePatch(() => {
      write('src/allowed.ts', 'implemented change\n')
      write('src/binary.dat', Buffer.from([0, 250, 3, 129]))
    })
    const commit = await applyExecutionPatch(dir, patch, session(), 'feat: literal $(not-a-shell-command)')
    expect(git('rev-parse', `${commit}^`).trim()).toBe(sha)
    expect(git('show', '--format=%an <%ae>', '--no-patch', commit).trim()).toBe(
      'SpecVoice <specvoice@noreply.github.com>'
    )
    expect(readFileSync(join(dir, 'src/binary.dat'))).toEqual(Buffer.from([0, 250, 3, 129]))
    expect(git('show', '--format=%s', '--no-patch', commit).trim()).toBe('feat: literal $(not-a-shell-command)')
  })

  it('allows an in-scope deletion', async () => {
    const patch = makePatch(() => rmSync(join(dir, 'src/allowed.ts')))
    await expect(applyExecutionPatch(dir, patch, session(), 'delete allowed file')).resolves.toMatch(/^[a-f0-9]{40}$/)
    expect(existsSync(join(dir, 'src/allowed.ts'))).toBe(false)
  })

  it('accepts a bounded binary delta', async () => {
    const original = Buffer.alloc(16 * 1024)
    write('src/binary.dat', original)
    sha = commit()
    const modified = Buffer.concat([original, Buffer.from([2])])
    const patch = makePatch(() => write('src/binary.dat', modified))
    expect(patch.match(/GIT binary patch\n(\w+) /)?.[1]).toBe('delta')
    await expect(applyExecutionPatch(dir, patch, session(), 'binary delta')).resolves.toMatch(/^[a-f0-9]{40}$/)
    expect(readFileSync(join(dir, 'src/binary.dat')).equals(modified)).toBe(true)
  })

  it.each(['delete', 'rename-out', 'rename-in'])('rejects an out-of-scope %s', async change => {
    const patch = makePatch(() => {
      if (change === 'delete') rmSync(join(dir, 'outside/secret.ts'))
      else if (change === 'rename-out') git('mv', 'src/allowed.ts', 'outside/moved.ts')
      else git('mv', 'outside/secret.ts', 'src/moved.ts')
    })
    await expect(applyExecutionPatch(dir, patch, session(), 'rejected change')).rejects.toThrow(
      /outside the accepted Scope Plan/
    )
  })

  it.each(['../escaped', '.git/config'])('rejects malicious patch path %s without changing HEAD', async path => {
    const patch = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+untrusted\n`
    await expect(applyExecutionPatch(dir, patch, session(), 'invalid path')).rejects.toThrow()
    expect(git('rev-parse', 'HEAD').trim()).toBe(sha)
    expect(readFileSync(join(dir, '.git/config'), 'utf8')).not.toContain('untrusted')
    expect(existsSync(join(dir, '..', 'escaped'))).toBe(false)
  })

  it.each(['SPEC.md', 'CONTEXT.md', '.env.local'])('rejects reserved output %s even without scope', async path => {
    const patch = makePatch(() => write(path, 'reserved content\n'))
    await expect(applyExecutionPatch(dir, patch, session(null), 'reserved change')).rejects.toThrow(
      /outside the accepted Scope Plan/
    )
  })

  it('does not execute a pre-commit hook', async () => {
    const patch = makePatch(() => write('src/allowed.ts', 'safe output\n'))
    const marker = join(dir, 'hook-ran')
    write('.git/hooks/pre-commit', '#!/bin/sh\necho unexpected > hook-ran\nexit 1\n')
    chmodSync(join(dir, '.git/hooks/pre-commit'), 0o755)
    await expect(applyExecutionPatch(dir, patch, session(), 'hooks disabled')).resolves.toMatch(/^[a-f0-9]{40}$/)
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects a compressed literal that expands past the transfer limit before writing it', async () => {
    const patch = makePatch(() => write('src/bomb.bin', Buffer.alloc(64 * 1024 * 1024 + 1)))
    expect(Buffer.byteLength(patch)).toBeLessThan(1024 * 1024)
    await expect(applyExecutionPatch(dir, patch, session(), 'literal bomb')).rejects.toThrow(/64 MiB expanded/)
    expect(existsSync(join(dir, 'src/bomb.bin'))).toBe(false)
    expect(git('rev-parse', 'HEAD').trim()).toBe(sha)
  })

  it('checks the delta result length rather than just the delta instruction length', async () => {
    const original = Buffer.alloc(64 * 1024 * 1024)
    write('src/binary.dat', original)
    sha = commit()
    const patch = makePatch(() => write('src/binary.dat', Buffer.concat([original, Buffer.from([2])])))
    expect(patch.match(/GIT binary patch\n(\w+) /)?.[1]).toBe('delta')
    expect(Buffer.byteLength(patch)).toBeLessThan(1024 * 1024)
    await expect(applyExecutionPatch(dir, patch, session(), 'delta bomb')).rejects.toThrow(/64 MiB expanded/)
    expect(readFileSync(join(dir, 'src/binary.dat')).equals(original)).toBe(true)
    expect(git('rev-parse', 'HEAD').trim()).toBe(sha)
  })

  it('caps the aggregate expanded bytes of multiple individually permitted binary files', async () => {
    const patch = makePatch(() => {
      write('src/one.bin', Buffer.alloc(33 * 1024 * 1024))
      write('src/two.bin', Buffer.alloc(33 * 1024 * 1024))
    })
    expect(Buffer.byteLength(patch)).toBeLessThan(1024 * 1024)
    await expect(applyExecutionPatch(dir, patch, session(), 'aggregate bomb')).rejects.toThrow(/64 MiB expanded/)
    expect(existsSync(join(dir, 'src/one.bin'))).toBe(false)
    expect(existsSync(join(dir, 'src/two.bin'))).toBe(false)
  })

  it('counts text together with expanded binary data against the transfer budget', async () => {
    const patch = makePatch(() => {
      write('src/big.bin', Buffer.alloc(63 * 1024 * 1024))
      write('src/text.txt', 'a'.repeat(2 * 1024 * 1024))
    })
    expect(Buffer.byteLength(patch)).toBeLessThan(4 * 1024 * 1024)
    await expect(applyExecutionPatch(dir, patch, session(), 'mixed bomb')).rejects.toThrow(/64 MiB expanded/)
    expect(existsSync(join(dir, 'src/big.bin'))).toBe(false)
    expect(existsSync(join(dir, 'src/text.txt'))).toBe(false)
  })

  it('fails closed for malformed binary blocks and newly introduced symlinks', async () => {
    const binary = makePatch(() => write('src/binary.dat', Buffer.from([0, 250, 3, 129])))
    await expect(
      applyExecutionPatch(dir, binary.replace(/literal \d+/, 'literal 999'), session(), 'malformed')
    ).rejects.toThrow(/Malformed/)
    const symlink = makePatch(() => symlinkSync('../outside/secret.ts', join(dir, 'src/link')))
    await expect(applyExecutionPatch(dir, symlink, session(), 'symlink')).rejects.toThrow(/symlinks or submodules/)
    expect(existsSync(join(dir, 'src/link'))).toBe(false)
  })

  it('rejects missing/moved pins, dirty checkout, oversized patch and cancellation before applying', async () => {
    const patch = makePatch(() => write('src/allowed.ts', 'patch output\n'))
    await expect(applyExecutionPatch(dir, patch, makeSession(), 'no pin')).rejects.toThrow(/pinned Repository Snapshot/)
    await expect(
      applyExecutionPatch(dir, patch, makeSession({ repositorySha: 'f'.repeat(40) }), 'wrong pin')
    ).rejects.toThrow(/does not match/)
    await expect(applyExecutionPatch(dir, ' '.repeat(64 * 1024 * 1024 + 1), session(), 'large')).rejects.toThrow(
      /64 MiB/
    )
    await expect(
      applyExecutionPatch(dir, patch, session(), 'cancelled', AbortSignal.abort(new Error('cancelled')))
    ).rejects.toThrow('cancelled')
    write('src/allowed.ts', 'dirty\n')
    await expect(applyExecutionPatch(dir, patch, session(), 'dirty')).rejects.toThrow(/clean trusted checkout/)
    expect(git('rev-parse', 'HEAD').trim()).toBe(sha)
  })
})
