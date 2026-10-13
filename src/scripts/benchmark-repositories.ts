import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { LocalCodeSource } from '@/lib/code/local-source'
import { profileLimits, profileRepository } from '@/lib/repo/profile'

const exec = promisify(execFile)
const sizes = [5_000, 25_000, 100_000, 100_001]
const limits = profileLimits()
const results: object[] = []

// Git objects avoid checking out 100,000 files while exercising the real immutable adapter.
async function fixture(directory: string, count: number) {
  await exec('git', ['init', '--quiet', directory])
  const commands = [
    'blob\nmark :1\ndata 3\n{}\n',
    'blob\nmark :2\ndata 23\nexport const needle = 1\n',
    'commit refs/heads/main\ncommitter Synthetic <fixture@example.invalid> 1000000000 +0000\ndata 8\nfixture\n',
    'M 100644 :1 package.json\n',
  ]
  for (let index = 1; index < count; index++) {
    const root = `packages/p${String(index % 100).padStart(3, '0')}`
    commands.push(`M 100644 :${index <= 100 ? 1 : 2} ${root}/${index <= 100 ? 'package.json' : `file${index}.ts`}\n`)
  }
  commands.push('\ndone\n')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-C', directory, 'fast-import', '--quiet'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: 60_000,
    })
    child.stdin.on('error', reject)
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error('Synthetic Git import failed'))))
    child.stderr.resume()
    child.stdin.end(commands.join(''))
  })
  await exec('git', ['-C', directory, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'specvoice-scale-'))
  const previousRoot = process.env.SPECVOICE_LOCAL_REPO_ROOT
  process.env.SPECVOICE_LOCAL_REPO_ROOT = directory
  try {
    for (const count of sizes) {
      const repository = join(directory, String(count))
      await fixture(repository, count)
      const source = new LocalCodeSource(repository)
      const sha = await source.getCommitSha()
      const started = performance.now()
      const profile = await profileRepository(source, sha, limits)
      const profileMs = Math.round(performance.now() - started)
      assert.equal(profile.repositorySha, sha)
      assert.equal(profile.fileCount, Math.min(count, limits.maxFiles))
      assert.equal(profile.treeComplete, count <= limits.maxFiles)
      const scopedStart = performance.now()
      const includedRoots = Array.from({ length: 25 }, (_, index) => `packages/p001/file${101 + index * 100}.ts`)
      const search = await source.searchCode('needle', 100, {
        scope: { includedRoots, excludedRoots: [] },
      })
      assert.equal(search.complete, true)
      assert.equal(search.results.length, 25)
      assert.ok(search.results.every(result => includedRoots.includes(result.path)))
      results.push({
        fixtureFiles: count,
        inventoriedFiles: profile.fileCount,
        complete: profile.treeComplete,
        tier: profile.tier,
        packages: profile.packages.length,
        profileMs,
        scopedSearchMs: Math.round(performance.now() - scopedStart),
        scopedMatches: search.results.length,
        processRssBytes: process.memoryUsage().rss,
      })
    }
    await mkdir('artifacts', { recursive: true })
    const report = {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      adapter: 'LocalCodeSource / real Git objects',
      limitation: 'Synthetic small text files; excludes GitHub transport, clone/install and live model latency.',
      limits,
      results,
    }
    await writeFile('artifacts/repository-scale.json', JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  } finally {
    if (previousRoot === undefined) delete process.env.SPECVOICE_LOCAL_REPO_ROOT
    else process.env.SPECVOICE_LOCAL_REPO_ROOT = previousRoot
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Repository benchmark failed')
  process.exitCode = 1
})
