import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryCodeSource } from '@/lib/code/in-memory-source'
import type { FileInfo } from '@/lib/code/types'
import { profileRepository, repositoryTier, type ProfileLimits } from '@/lib/repo/profile'

const limits: ProfileLimits = {
  smallMaxFiles: 2,
  smallMaxBytes: 100,
  midMaxFiles: 4,
  midMaxBytes: 200,
  largeMaxFiles: 8,
  largeMaxBytes: 400,
  maxFiles: 8,
  maxBytes: 400,
  maxDurationMs: 10_000,
}

afterEach(() => vi.restoreAllMocks())

describe('repository profiling', () => {
  it('classifies configurable repository tiers', () => {
    expect(repositoryTier(1, 20, limits)).toBe('small')
    expect(repositoryTier(3, 20, limits)).toBe('mid')
    expect(repositoryTier(7, 20, limits)).toBe('large')
    expect(repositoryTier(9, 20, limits)).toBe('very-large')
  })

  it('reports languages, packages, generated roots, and bounded completeness', async () => {
    const profile = await profileRepository(
      new InMemoryCodeSource({
        'package.json': '{}',
        'src/index.ts': 'export {}',
        'dist/bundle.js': 'generated',
      }),
      'abc123',
      limits
    )
    expect(profile.repositorySha).toBe('abc123')
    expect(profile.fileCount).toBe(3)
    expect(profile.packages[0]?.manifest).toBe('package.json')
    expect(profile.generatedRoots).toEqual(['dist'])
    expect(profile.treeComplete).toBe(true)
  })
  it('keeps nested package roots and reports lower bounds when enumeration stops', async () => {
    const source = new InMemoryCodeSource({
      'apps/web/package.json': '{}',
      'apps/web/page.ts': 'code',
      'apps/api/package.json': '{}',
    })
    const complete = await profileRepository(source, 'pinned', limits)
    expect(complete.packages.map(item => item.path)).toEqual(['apps/web', 'apps/api'])
    expect(complete.packages[0].fileCount).toBe(2)
    const partial = await profileRepository(source, 'pinned', { ...limits, maxFiles: 1 })
    expect(partial).toMatchObject({ fileCount: 1, treeComplete: false, indexStatus: 'partial', tier: 'small' })
  })

  it('counts nested descendants regardless of manifest order without merging similarly named roots', async () => {
    const source = new InMemoryCodeSource({
      'packages/app/src/before.ts': 'x',
      'packages/app/nested/package.json': '{}',
      'packages/app/nested/index.ts': 'x',
      'packages/application/index.ts': 'x',
      'package.json': '{}',
      'packages/app/package.json': '{}',
      'packages/app/pyproject.toml': 'x',
    })
    const complete = await profileRepository(source, 'pinned', limits)
    expect(complete.packages).toEqual([
      { path: 'packages/app/nested', manifest: 'packages/app/nested/package.json', fileCount: 2 },
      { path: '', manifest: 'package.json', fileCount: 7 },
      { path: 'packages/app', manifest: 'packages/app/package.json', fileCount: 5 },
    ])
    expect(complete).toMatchObject({
      fileCount: 7,
      byteCount: 10,
      treeComplete: true,
      languages: { ts: 3, json: 3, toml: 1 },
    })
    const partial = await profileRepository(source, 'pinned', { ...limits, maxFiles: 3 })
    expect(partial).toMatchObject({ fileCount: 3, treeComplete: false, indexStatus: 'partial' })
    expect(partial.packages).toEqual([
      { path: 'packages/app/nested', manifest: 'packages/app/nested/package.json', fileCount: 2 },
    ])
  })

  it('profiles many packages without repeatedly reading the whole listing for each manifest', async () => {
    let pathReads = 0
    const files: FileInfo[] = []
    for (let index = 499; index >= 0; index--) {
      for (const name of ['src/index.ts', 'src/nested/helper.ts', 'package.json']) {
        files.push({
          get path() {
            pathReads++
            return `packages/package-${index}/${name}`
          },
          type: 'file',
          size: 1,
        })
      }
    }
    files.push({ path: 'package.json', type: 'file', size: 1 })
    files.push({ path: 'packages', type: 'dir' })
    const source = new InMemoryCodeSource()
    vi.spyOn(source, 'listFiles').mockResolvedValue({ files, complete: true })
    const result = await profileRepository(source, 'pinned', { ...limits, maxFiles: 2000, maxBytes: 2000 })
    expect(result).toMatchObject({ fileCount: 1501, byteCount: 1501, treeComplete: true })
    expect(result.packages).toHaveLength(501)
    for (let index = 0; index < 500; index++) {
      expect(result.packages[index]).toEqual({
        path: `packages/package-${499 - index}`,
        manifest: `packages/package-${499 - index}/package.json`,
        fileCount: 3,
      })
    }
    expect(result.packages[500]).toEqual({ path: '', manifest: 'package.json', fileCount: 1501 })
    // Input-access count is deterministic; wall-clock speed varies across CI hosts.
    expect(pathReads).toBeLessThan(files.length * 10)
  })

  it('yields during CPU profiling so cancellation stops before the entire listing is processed', async () => {
    const controller = new AbortController()
    const visited = new Set<number>()
    let scheduled = false
    const files: FileInfo[] = Array.from({ length: 2000 }, (_, index) => ({
      get path() {
        visited.add(index)
        if (!scheduled) {
          scheduled = true
          setImmediate(() => controller.abort(new Error('Profile cancelled during aggregation')))
        }
        return `src/file-${index}.ts`
      },
      type: 'file',
      size: 1,
    }))
    const source = new InMemoryCodeSource()
    vi.spyOn(source, 'listFiles').mockResolvedValue({ files, complete: true })
    await expect(
      profileRepository(source, 'pinned', { ...limits, maxFiles: 2000, maxBytes: 2000 }, undefined, {
        signal: controller.signal,
      })
    ).rejects.toThrow('Profile cancelled during aggregation')
    expect(visited.size).toBeGreaterThan(0)
    expect(visited.size).toBeLessThan(files.length)
  })

  it('includes listing and CPU aggregation in the time budget and preserves partial lower bounds', async () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const files: FileInfo[] = [
      {
        get path() {
          clock = limits.maxDurationMs + 1
          return 'package.json'
        },
        type: 'file',
        size: 2,
      },
      { path: 'src/not-processed.ts', type: 'file', size: 50 },
    ]
    const source = new InMemoryCodeSource()
    vi.spyOn(source, 'listFiles').mockImplementation(async () => {
      clock = limits.maxDurationMs / 2
      return { files, complete: true }
    })
    const result = await profileRepository(source, 'pinned', limits)
    expect(result).toMatchObject({
      fileCount: 1,
      byteCount: 2,
      treeComplete: false,
      indexStatus: 'partial',
      languages: { json: 1 },
    })
    expect(result.packages).toEqual([{ path: '', manifest: 'package.json', fileCount: 1 }])
  })
})
