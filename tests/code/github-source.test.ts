import { describe, expect, it, vi } from 'vitest'
import { GitHubCodeSource } from '@/lib/code/github-source'

const sha = 'a'.repeat(40)
const limits = { maxFiles: 100, maxBytes: 5_000_000, maxDurationMs: 1000 }
interface TreeEntry {
  path: string
  type: 'blob' | 'tree' | 'commit'
  mode: string
  sha: string
  size?: number
}
interface Tree {
  tree: TreeEntry[]
  truncated?: boolean
}
const file = (path: string, content: string): TreeEntry => ({
  path,
  type: 'blob',
  mode: '100644',
  sha: path,
  size: Buffer.byteLength(content),
})
const directory = (path: string): TreeEntry => ({ path, type: 'tree', mode: '040000', sha: path })

function mockGitHub(trees: Record<string, Tree>, blobs: Record<string, string> = {}) {
  const urls: URL[] = []
  const requestFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    urls.push(url)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const route = decodeURIComponent(url.pathname).replace('/repos/acme/repository', '')
    let data: unknown
    if (!route) data = { default_branch: 'main' }
    else if (route === '/git/ref/heads/main') data = { object: { sha } }
    else if (route === `/git/commits/${sha}`) data = { tree: { sha: 'root' } }
    else if (route.startsWith('/git/trees/')) {
      expect(url.searchParams.has('recursive')).toBe(false)
      data = trees[decodeURIComponent(route.slice('/git/trees/'.length))]
    } else if (route.startsWith('/git/blobs/')) {
      const content = blobs[decodeURIComponent(route.slice('/git/blobs/'.length))]
      if (content !== undefined)
        data = {
          encoding: 'base64',
          content: Buffer.from(content).toString('base64'),
          size: Buffer.byteLength(content),
        }
    }
    if (!data) throw new Error(`Unexpected GitHub request: ${url.pathname}`)
    return Response.json(data)
  })
  return {
    requestFetch,
    urls,
    source: new GitHubCodeSource('https://github.com/acme/repository', undefined, sha, requestFetch),
  }
}

function blockedFetch() {
  let requested: () => void = () => {}
  const started = new Promise<void>(resolve => {
    requested = resolve
  })
  const requestFetch = vi.fn<typeof fetch>(async (_input, init) => {
    const signal = init?.signal
    if (!signal) throw new Error('Expected request cancellation signal')
    signal.throwIfAborted()
    requested()
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  return { started, requestFetch }
}

describe('GitHubCodeSource transport', () => {
  it('keeps a supplied commit immutable and reads its blobs', async () => {
    const { source, urls } = mockGitHub(
      { root: { tree: [file('hello.ts', 'first\nsecond')] } },
      { 'hello.ts': 'first\nsecond' }
    )
    expect(await source.getCommitSha()).toBe(sha)
    expect(await source.readFile('hello.ts', 2, 2)).toEqual({
      path: 'hello.ts',
      content: '2 | second',
      lineCount: 1,
      truncated: false,
    })
    expect(urls.map(url => url.pathname)).toEqual([
      `/repos/acme/repository/git/commits/${sha}`,
      '/repos/acme/repository/git/trees/root',
      '/repos/acme/repository/git/blobs/hello.ts',
    ])
  })

  it('resolves a default branch once, then reuses the same commit', async () => {
    const { requestFetch, urls } = mockGitHub({ root: { tree: [] } })
    const source = new GitHubCodeSource('https://github.com/acme/repository', undefined, undefined, requestFetch)
    expect(await Promise.all([source.getCommitSha(), source.getCommitSha()])).toEqual([sha, sha])
    await source.listFiles()
    expect(urls.filter(url => decodeURIComponent(url.pathname).endsWith('/git/ref/heads/main'))).toHaveLength(1)
    expect(urls.at(-2)?.pathname).toBe(`/repos/acme/repository/git/commits/${sha}`)
  })

  it('preserves provider truncation as partial while retaining returned files', async () => {
    const { source } = mockGitHub({ root: { tree: [file('one.ts', 'one')], truncated: true } })
    expect(await source.listFiles()).toEqual({
      files: [{ path: 'one.ts', type: 'file', size: 3 }],
      complete: false,
      stopReason: 'provider',
    })
  })

  it('prunes excluded directories before fetching their trees or blobs', async () => {
    const { source, urls } = mockGitHub(
      {
        root: { tree: [directory('docs'), directory('src')] },
        src: { tree: [directory('vendor'), file('chosen.ts', 'needle')] },
      },
      { 'chosen.ts': 'needle' }
    )
    const result = await source.searchCode('needle', 20, {
      scope: { includedRoots: ['src'], excludedRoots: ['src/vendor'] },
      limits: { ...limits, maxFiles: 1 },
    })
    expect(result).toMatchObject({
      complete: true,
      results: [{ path: 'src/chosen.ts', lineNumber: 1, lineContent: 'needle' }],
    })
    expect(urls.some(url => /\/(docs|vendor)$/.test(url.pathname))).toBe(false)
    expect(urls.filter(url => url.pathname.includes('/git/blobs/'))).toHaveLength(1)
  })

  it('searches a small scope in a repository exceeding 100 files without spending limits outside it', async () => {
    const outside = Array.from({ length: 150 }, (_, index) => file(`outside-${index}.ts`, 'needle'))
    const { source, urls } = mockGitHub(
      {
        root: { tree: [...outside, directory('src')] },
        src: { tree: [file('target.ts', 'before\nneedle\nafter')] },
      },
      { 'target.ts': 'before\nneedle\nafter' }
    )
    const result = await source.searchCode('needle', 1, {
      scope: { includedRoots: ['src/target.ts'], excludedRoots: [] },
      limits: { ...limits, maxFiles: 1 },
    })
    expect(result.results).toEqual([
      { path: 'src/target.ts', lineNumber: 2, lineContent: 'needle', context: ['before', 'after'] },
    ])
    expect(result).toMatchObject({ complete: false, stopReason: 'results' })
    expect(urls.filter(url => url.pathname.includes('/git/blobs/')).map(url => url.pathname)).toEqual([
      '/repos/acme/repository/git/blobs/target.ts',
    ])
  })

  it('marks file and byte exhaustion before reading prohibited blobs', async () => {
    const { source, urls } = mockGitHub(
      { root: { tree: [file('one.ts', 'needle'), file('two.ts', 'needle')] } },
      { 'one.ts': 'needle' }
    )
    expect(await source.searchCode('needle', 20, { limits: { ...limits, maxFiles: 1 } })).toMatchObject({
      complete: false,
      stopReason: 'files',
      results: [{ path: 'one.ts' }],
    })
    expect(urls.some(url => url.pathname.endsWith('/git/blobs/two.ts'))).toBe(false)
    expect(await source.listFiles(undefined, { limits: { ...limits, maxBytes: 5 } })).toEqual({
      files: [],
      complete: false,
      stopReason: 'bytes',
    })
  })

  it('searches raw content past the display cap with true line numbers and context', async () => {
    const content = `${'x'.repeat(4100)}\nnearby\nneedle\nafter`
    const { source } = mockGitHub({ root: { tree: [file('large.ts', content)] } }, { 'large.ts': content })
    expect(await source.searchCode('needle')).toEqual({
      complete: true,
      results: [
        { path: 'large.ts', lineNumber: 3, lineContent: 'needle', context: ['x'.repeat(4100), 'nearby', 'after'] },
      ],
    })
    const display = await source.readFile('large.ts')
    expect(display.truncated).toBe(true)
    expect(display.content).toHaveLength(4000)
  })

  it('rejects traversal, secret paths and out-of-scope reads without any request', async () => {
    const { source, requestFetch } = mockGitHub({ root: { tree: [] } })
    await expect(source.readFile('../secret')).rejects.toThrow('Invalid repository path')
    await expect(source.readFile('.env.local')).rejects.toThrow('outside')
    await expect(
      source.readFile('other.ts', undefined, undefined, { scope: { includedRoots: ['src'], excludedRoots: [] } })
    ).rejects.toThrow('outside')
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it('omits symlinks, submodules and secret directories', async () => {
    const { source, urls } = mockGitHub({
      root: {
        tree: [
          { path: 'link', type: 'blob', mode: '120000', sha: 'link', size: 3 },
          { path: 'submodule', type: 'commit', mode: '160000', sha: 'module' },
          directory('.env'),
          directory('.git'),
        ],
      },
    })
    expect(await source.listFiles()).toEqual({ files: [], complete: true })
    await expect(source.readFile('link')).rejects.toThrow('unavailable')
    expect(urls.some(url => url.pathname.includes('/git/blobs/'))).toBe(false)
  })

  it('aborts an in-flight request when the caller cancels', async () => {
    const { requestFetch, started } = blockedFetch()
    const controller = new AbortController()
    const source = new GitHubCodeSource('https://github.com/acme/repository', undefined, sha, requestFetch)
    const listing = source.listFiles(undefined, { signal: controller.signal })
    await started
    controller.abort(new Error('Cancelled discovery'))
    await expect(listing).rejects.toThrow('Cancelled discovery')
  })

  it('returns partial metadata when the request exceeds its operation deadline', async () => {
    const { requestFetch } = blockedFetch()
    const source = new GitHubCodeSource('https://github.com/acme/repository', undefined, sha, requestFetch)
    expect(await source.listFiles(undefined, { limits: { ...limits, maxDurationMs: 10 } })).toEqual({
      files: [],
      complete: false,
      stopReason: 'time',
    })
  })

  it('keeps rate-limit errors actionable', async () => {
    const requestFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ message: 'API rate limit exceeded' }, { status: 429 })
    )
    const source = new GitHubCodeSource('https://github.com/acme/repository', undefined, sha, requestFetch)
    await expect(source.listFiles()).rejects.toThrow('GitHub rate limit exceeded, try again in unknown minutes')
  })

  it('never replaces a missing pinned commit with the current branch', async () => {
    const requestFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ message: 'Commit not found' }, { status: 404 })
    )
    const source = new GitHubCodeSource('https://github.com/acme/repository', undefined, sha, requestFetch)
    await expect(source.listFiles()).rejects.toThrow('Commit not found')
    expect(requestFetch).toHaveBeenCalledOnce()
    expect(await source.getCommitSha()).toBe(sha)
  })
})
