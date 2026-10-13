import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { validateChangedPaths } from '@/lib/build/scope-check'
import type { ScopePlan } from '@/lib/session/types'
import { makeSession } from '../../fixtures'

let dir: string
let sha: string
function git(...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim()
}
function write(name: string, contents: string | Buffer) {
  mkdirSync(dirname(join(dir, name)), { recursive: true })
  writeFileSync(join(dir, name), contents)
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
  return git('rev-parse', 'HEAD')
}
function session(overrides: Partial<ScopePlan> = {}) {
  return makeSession({
    repositorySha: sha,
    scopePlan: {
      id: 'scope-test',
      repositorySha: sha,
      includedRoots: ['src'],
      excludedRoots: ['src/excluded'],
      estimatedFiles: 10,
      estimatedBytes: 1000,
      dependencyBoundaries: [],
      reason: 'Bound publication',
      status: 'confirmed',
      createdAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'specvoice-scope-check-'))
  git('init', '--quiet')
  write('src/allowed.ts', 'original allowed content\n')
  write('outside/secret.ts', 'original outside content\n')
  write('src/excluded/generated.ts', 'generated content\n')
  write('root.txt', 'root file\n')
  write('src/binary.dat', Buffer.from([0, 1, 2]))
  sha = commit()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Build changed-path publication guard', () => {
  it('permits additions, edits, deletions, binary files, spaces, tabs, and Unicode inside scope', async () => {
    write('src/allowed.ts', 'edited allowed content\n')
    write('src/new file.ts', 'new allowed content\n')
    write('src/café.ts', 'Unicode path\n')
    write('src/file\twith\ttabs.ts', 'tab path\n')
    write('src/binary.dat', Buffer.from([0, 3, 4]))
    commit()
    await expect(validateChangedPaths(dir, session())).resolves.toBeUndefined()
    rmSync(join(dir, 'src/allowed.ts'))
    commit()
    await expect(validateChangedPaths(dir, session())).resolves.toBeUndefined()
  })

  it.each(['add', 'edit', 'delete'])('rejects an out-of-scope %s', async change => {
    if (change === 'add') write('outside/new.ts', 'not allowed\n')
    else if (change === 'edit') write('outside/secret.ts', 'changed outside scope\n')
    else rmSync(join(dir, 'outside/secret.ts'))
    commit()
    await expect(validateChangedPaths(dir, session())).rejects.toThrow(/outside the accepted Scope Plan: outside\//)
  })

  it('rejects out-of-scope history even when the final tree reverts the change', async () => {
    write('outside/temporary.txt', 'must not publish this content in history\n')
    commit()
    rmSync(join(dir, 'outside/temporary.txt'))
    commit()
    expect(git('diff', '--name-only', sha, 'HEAD')).toBe('')
    await expect(validateChangedPaths(dir, session())).rejects.toThrow(/outside\/temporary.txt/)
  })

  it('rejects a generated commit unrelated to the pinned base even when its paths are allowed', async () => {
    git('checkout', '--quiet', '--orphan', 'unrelated')
    git('rm', '-rf', '--quiet', '.')
    write('src/replacement.ts', 'this allowed path has an unrelated history\n')
    commit()
    expect(git('ls-tree', '--name-only', '-r', 'HEAD')).toBe('src/replacement.ts')
    await expect(validateChangedPaths(dir, session())).rejects.toThrow()
  })

  it.each([
    ['src/allowed.ts', 'outside/moved.ts'],
    ['outside/secret.ts', 'src/moved.ts'],
  ])('checks both rename endpoints: %s to %s', async (from, to) => {
    git('mv', from, to)
    commit()
    expect(git('diff', '--name-status', '--find-renames', sha, 'HEAD')).toMatch(/^R100\s/)
    await expect(validateChangedPaths(dir, session())).rejects.toThrow(/outside the accepted Scope Plan/)
  })

  it('permits a rename when both endpoints are allowed', async () => {
    git('mv', 'src/allowed.ts', 'src/renamed.ts')
    commit()
    await expect(validateChangedPaths(dir, session())).resolves.toBeUndefined()
  })

  it('accepts an explicit file root without allowing a similarly named sibling', async () => {
    write('root.txt', 'updated allowed root file\n')
    commit()
    const scoped = session({ includedRoots: ['root.txt'], excludedRoots: [] })
    await expect(validateChangedPaths(dir, scoped)).resolves.toBeUndefined()
    write('root.txt-other', 'outside exact file root\n')
    commit()
    await expect(validateChangedPaths(dir, scoped)).rejects.toThrow(/root.txt-other/)
  })

  it('enforces exclusions when included roots cover the entire repository', async () => {
    write('outside/secret.ts', 'whole-repository scope permits this\n')
    commit()
    const scoped = session({ includedRoots: [], excludedRoots: ['src/excluded'] })
    await expect(validateChangedPaths(dir, scoped)).resolves.toBeUndefined()
    write('src/excluded/generated.ts', 'excluded even under whole-repository scope\n')
    commit()
    await expect(validateChangedPaths(dir, scoped)).rejects.toThrow(/src\/excluded\/generated.ts/)
  })

  it.each(['SPEC.md', 'CONTEXT.md', '.env.local'])(
    'rejects generated inputs and credentials even without a required Scope Plan: %s',
    async name => {
      write(name, 'fixture-only contents\n')
      commit()
      await expect(validateChangedPaths(dir, makeSession({ repositorySha: sha, scopePlan: null }))).rejects.toThrow(
        /outside the accepted Scope Plan/
      )
    }
  )

  it('requires a pinned commit and rejects a Scope Plan for a different snapshot', async () => {
    await expect(validateChangedPaths(dir, makeSession({ repositorySha: null }))).rejects.toThrow(
      /pinned Repository Snapshot/
    )
    await expect(validateChangedPaths(dir, session({ repositorySha: 'f'.repeat(40) }))).rejects.toThrow(
      /does not match/
    )
  })

  it.each(['proposed', 'rejected'] as const)('rejects a present %s Scope Plan', async status => {
    write('outside/secret.ts', 'must not silently expand scope\n')
    commit()
    await expect(validateChangedPaths(dir, session({ status }))).rejects.toThrow(/confirm/i)
  })

  it('honors cancellation before inspecting the generated commit', async () => {
    await expect(validateChangedPaths(dir, session(), AbortSignal.abort(new Error('cancelled')))).rejects.toThrow(
      'cancelled'
    )
  })
})
