import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { LocalCodeSource } from '@/lib/code/local-source'
import type { CodeOptions } from '@/lib/code/types'

let root: string
let sha: string
function git(...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim()
}
function write(relative: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
  fs.writeFileSync(path.join(root, relative), content)
}
function commit() {
  git('add', '--force', '.')
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
const limits = (overrides: Partial<NonNullable<CodeOptions['limits']>> = {}) => ({
  maxFiles: 100,
  maxBytes: 1024 * 1024,
  maxDurationMs: 10_000,
  ...overrides,
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'specvoice-local-source-'))
  vi.stubEnv('SPECVOICE_LOCAL_REPO_ROOT', root)
  git('init', '--quiet')
  write('.gitignore', 'vendor/\nhidden.txt\n*.tmp\n')
  write('README.md', 'First line\n  TODO preserve spaces  \nLast line\n')
  write('src/index.ts', 'export const version = "pinned"\n')
  write('src/.gitignore', 'generated.txt\n!keep.tmp\n')
  write('src/generated.txt', 'hidden generated match\n')
  write('src/keep.tmp', 'retained by nested ignore override\n')
  write('vendor/ignored.ts', 'ignored vendor match\n')
  write('hidden.txt', 'ignored root match\n')
  write('.env.local', 'FAKE_SECRET=fixture-only\n')
  write('binary.dat', Buffer.from([0, 1, 2]))
  fs.symlinkSync('/etc/passwd', path.join(root, 'linked.txt'))
  sha = commit()
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('LocalCodeSource committed snapshots', () => {
  it('returns committed files while applying pinned root and nested ignore rules', async () => {
    const source = new LocalCodeSource(root, sha)
    const listing = await source.listFiles()
    expect(listing.complete).toBe(true)
    expect(listing.files.map(file => file.path)).toContain('src/index.ts')
    expect(listing.files.map(file => file.path)).toContain('src/keep.tmp')
    for (const excluded of [
      'vendor',
      'vendor/ignored.ts',
      'hidden.txt',
      'src/generated.txt',
      '.env.local',
      'linked.txt',
    ]) {
      expect(listing.files.map(file => file.path)).not.toContain(excluded)
    }
    for (const excluded of ['vendor/ignored.ts', 'hidden.txt', 'src/generated.txt', 'linked.txt']) {
      await expect(source.readFile(excluded)).rejects.toThrow(/File not found/)
    }
    await expect(source.readFile('.env.local')).rejects.toThrow(/outside the confirmed Scope Plan/)
  })

  it('keeps content and ignore rules immutable after dirty edits, untracked files, and moving HEAD', async () => {
    const source = new LocalCodeSource(root)
    expect(await source.getCommitSha()).toBe(sha)
    write('README.md', 'dirty replacement\n')
    write('.gitignore', '')
    write('untracked.ts', 'untracked data')
    expect((await source.readFile('README.md')).content).toContain('TODO preserve spaces')
    expect((await source.listFiles()).files.map(file => file.path)).not.toContain('untracked.ts')
    const later = commit()
    expect(later).not.toBe(sha)
    expect(await source.getCommitSha()).toBe(sha)
    expect((await source.readFile('README.md')).content).toContain('TODO preserve spaces')
    expect((await source.listFiles()).files.map(file => file.path)).not.toContain('hidden.txt')
    expect((await new LocalCodeSource(root, sha).readFile('README.md')).content).toContain('TODO preserve spaces')
  })

  it('supports a selected directory nested under the Git root', async () => {
    const source = new LocalCodeSource(path.join(root, 'src'), sha)
    const listing = await source.listFiles()
    expect(listing.files.map(file => file.path)).toEqual(['.gitignore', 'index.ts', 'keep.tmp'])
    expect((await source.readFile('index.ts')).content).toContain('pinned')
    await expect(source.readFile('../README.md')).rejects.toThrow(/escapes repository root/)
  })

  it('rejects a missing commit and a non-Git directory instead of reading the working tree', async () => {
    await expect(new LocalCodeSource(root, 'f'.repeat(40)).getCommitSha()).rejects.toThrow(/Cannot resolve committed/)
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true })
    await expect(new LocalCodeSource(root).listFiles()).rejects.toThrow(/Cannot resolve committed/)
  })

  it('rejects directories that exist only in the working tree', async () => {
    write('new-directory/file.ts', 'not committed')
    await expect(new LocalCodeSource(path.join(root, 'new-directory'), sha).getCommitSha()).rejects.toThrow(
      /Cannot resolve committed/
    )
  })

  it('preserves numbered line ranges and truncates large committed text at4000 characters', async () => {
    write('long.txt', 'x'.repeat(6000))
    const source = new LocalCodeSource(root, commit())
    const line = await source.readFile('README.md', 2, 2)
    expect(line).toMatchObject({ content: '2 |   TODO preserve spaces  ', lineCount: 1, truncated: false })
    const long = await source.readFile('long.txt')
    expect(long.truncated).toBe(true)
    expect(long.content.length).toBe(4000)
    await expect(source.readFile('binary.dat')).rejects.toThrow(/binary/)
    await expect(source.readFile('missing.ts')).rejects.toThrow(/File not found/)
    await expect(source.readFile('src')).rejects.toThrow(/File not found/)
  })

  it.each(['../README.md', '/README.md', 'src/../README.md', 'src/*.ts', 'src\\index.ts', 'src//index.ts'])(
    'rejects nonliteral path %s',
    async invalid => {
      const source = new LocalCodeSource(root, sha)
      await expect(source.readFile(invalid)).rejects.toThrow(/Invalid repository path/)
      await expect(source.listFiles(invalid)).rejects.toThrow(/Invalid repository path/)
    }
  )

  it('rejects a symlinked root outside the allowed directory', () => {
    fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'))
    expect(() => new LocalCodeSource(path.join(root, 'outside'))).toThrow(/SPECVOICE_LOCAL_REPO_ROOT/)
  })

  it('skips committed submodule references', async () => {
    git('update-index', '--add', '--cacheinfo', `160000,${sha},submodule`)
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
    const source = new LocalCodeSource(root, git('rev-parse', 'HEAD'))
    expect((await source.listFiles()).files.map(file => file.path)).not.toContain('submodule')
    await expect(source.readFile('submodule')).rejects.toThrow(/File not found/)
  })

  it('counts only scoped candidates when unrelated paths exceed the default file budget', async () => {
    for (let index = 0; index < 130; index++) write(`many/file-${index}.txt`, 'match outside scope\n')
    write('selected/index.ts', 'before\n  MaTcH inside scope  \nafter\n')
    write('selected/excluded/file.ts', 'match excluded\n')
    const source = new LocalCodeSource(root, commit())
    const options: CodeOptions = {
      scope: { includedRoots: ['selected'], excludedRoots: ['selected/excluded'] },
      limits: limits({ maxFiles: 2 }),
    }
    const listing = await source.listFiles(undefined, options)
    expect(listing).toMatchObject({ complete: true })
    expect(listing.files.map(file => file.path)).toEqual(['selected', 'selected/index.ts'])
    const search = await source.searchCode('match', 10, options)
    expect(search).toEqual({
      complete: true,
      results: [
        {
          path: 'selected/index.ts',
          lineNumber: 2,
          lineContent: '  MaTcH inside scope  ',
          context: ['before', 'after', ''],
        },
      ],
    })
    await expect(source.readFile('README.md', undefined, undefined, options)).rejects.toThrow(
      /outside the confirmed Scope Plan/
    )
  })

  it('supports literal file roots and narrows directory requests before enumeration', async () => {
    const source = new LocalCodeSource(root, sha)
    const options: CodeOptions = { scope: { includedRoots: ['src/index.ts', 'README.md'], excludedRoots: [] } }
    expect((await source.listFiles('src', options)).files.map(file => file.path)).toEqual(['src/index.ts'])
    expect((await source.listFiles(undefined, options)).files.map(file => file.path)).toEqual([
      'README.md',
      'src/index.ts',
    ])
    expect((await source.listFiles('vendor', options)).files).toEqual([])
  })

  it('returns explicit partial listings at file and byte budgets', async () => {
    const source = new LocalCodeSource(root, sha)
    const files = await source.listFiles(undefined, { limits: limits({ maxFiles: 1 }) })
    expect(files).toMatchObject({ complete: false, stopReason: 'files' })
    expect(files.files.filter(file => file.type === 'file')).toHaveLength(1)
    const bytes = await source.listFiles('README.md', { limits: limits({ maxBytes: 30 }) })
    expect(bytes).toMatchObject({ complete: false, stopReason: 'bytes', files: [] })
    await expect(
      source.readFile('README.md', undefined, undefined, { limits: limits({ maxBytes: 30 }) })
    ).rejects.toThrow(/bytes budget/)
  })

  it('returns partial searches when a result or file budget prevents completion', async () => {
    write('matches.txt', 'match one\nmatch two\n')
    const source = new LocalCodeSource(root, commit())
    const scope = { includedRoots: ['matches.txt'], excludedRoots: [] }
    expect(await source.searchCode('match', 1, { scope })).toMatchObject({
      complete: false,
      stopReason: 'results',
      results: [{ lineContent: 'match one' }],
    })
    expect(await source.searchCode('match', 3, { scope })).toMatchObject({ complete: true })
    expect(await source.searchCode('no matches', 20, { limits: limits({ maxFiles: 1 }) })).toMatchObject({
      complete: false,
      stopReason: 'files',
    })
  })

  it('charges nested ignore-rule reads against the cumulative byte budget without spending file slots', async () => {
    write('.gitignore', `#${'r'.repeat(598)}\n`)
    write('src/.gitignore', `#${'s'.repeat(598)}\n`)
    write('src/target.ts', 'x')
    const pinned = commit()
    const options = { limits: limits({ maxBytes: 1000, maxFiles: 1 }) }
    expect(await new LocalCodeSource(root, pinned).listFiles('src/target.ts', options)).toEqual({
      files: [],
      complete: false,
      stopReason: 'bytes',
    })
    expect(
      await new LocalCodeSource(root, pinned).listFiles('src/target.ts', {
        limits: limits({ maxBytes: 1201, maxFiles: 1 }),
      })
    ).toEqual({ files: [{ path: 'src/target.ts', type: 'file', size: 1 }], complete: true })
  })

  it('propagates caller cancellation and returns partial results for an expired operation deadline', async () => {
    const source = new LocalCodeSource(root, sha)
    const signal = AbortSignal.abort(new Error('cancelled by test'))
    await expect(source.listFiles(undefined, { signal })).rejects.toThrow('cancelled by test')
    await expect(source.readFile('README.md', undefined, undefined, { signal })).rejects.toThrow('cancelled by test')
    await expect(source.searchCode('match', 1, { signal })).rejects.toThrow('cancelled by test')
    await source.getCommitSha()
    expect(await source.listFiles(undefined, { limits: limits({ maxDurationMs: 1 }) })).toMatchObject({
      complete: false,
      stopReason: 'time',
    })
    const controller = new AbortController()
    const search = source.searchCode('match', 10, { signal: controller.signal })
    const timer = setTimeout(() => controller.abort(new Error('cancelled while running')), 1)
    try {
      await expect(search).rejects.toThrow('cancelled while running')
    } finally {
      clearTimeout(timer)
    }
  })
})
