import { describe, expect, it } from 'vitest'
import { InMemoryCodeSource } from '@/lib/code/in-memory-source'
import { ScopedCodeSource } from '@/lib/code/scoped-source'

const plan = {
  id: 'scope-1',
  repositorySha: 'abc123',
  includedRoots: ['src'],
  excludedRoots: ['src/generated'],
  estimatedFiles: 1,
  estimatedBytes: 10,
  dependencyBoundaries: [],
  reason: 'test',
  status: 'confirmed' as const,
  createdAt: new Date().toISOString(),
}

describe('ScopedCodeSource', () => {
  it('filters discovery and rejects reads outside the confirmed scope', async () => {
    const source = new ScopedCodeSource(
      new InMemoryCodeSource({ 'src/index.ts': 'ok', 'src/generated/out.ts': 'generated', 'README.md': 'nope' }),
      plan
    )
    await expect(source.listFiles()).resolves.toEqual({
      files: [{ path: 'src/index.ts', type: 'file', size: 2 }],
      complete: true,
    })
    await expect(source.readFile('README.md')).rejects.toThrow('outside the confirmed Scope Plan')
    await expect(source.readFile('src/generated/out.ts')).rejects.toThrow('outside the confirmed Scope Plan')
  })
})
