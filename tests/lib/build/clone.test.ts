import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cloneRepo, cleanupTmpDir, runGit } from '@/lib/build/clone'
import type { ScopePlan } from '@/lib/session/types'
let repo: string
const cleanups: string[] = []
function git(...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim()
}
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'specvoice-clone-fixture-'))
  git('init', '--quiet')
})
afterEach(() => {
  for (const dir of cleanups.splice(0)) cleanupTmpDir(dir)
  rmSync(repo, { recursive: true, force: true })
})
describe('Git workflow lifetime and sparse scope', () => {
  it('pins an older commit and checks out literal files/directories before generation', async () => {
    mkdirSync(join(repo, 'src space'))
    writeFileSync(join(repo, 'src space', 'keep.ts'), 'old')
    writeFileSync(join(repo, 'src space', 'excluded.ts'), 'excluded')
    writeFileSync(join(repo, 'root file '), 'trailing space is literal')
    writeFileSync(join(repo, 'outside.ts'), 'outside')
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
      'base'
    )
    const sha = git('rev-parse', 'HEAD')
    writeFileSync(join(repo, 'src space', 'keep.ts'), 'new')
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
      'moving HEAD'
    )
    const plan: ScopePlan = {
      id: 'scope',
      repositorySha: sha,
      includedRoots: ['src space', 'root file '],
      excludedRoots: ['src space/excluded.ts'],
      estimatedFiles: 2,
      estimatedBytes: 32,
      dependencyBoundaries: [],
      reason: 'fixture',
      status: 'confirmed',
      createdAt: new Date().toISOString(),
    }
    const checkout = await cloneRepo(pathToFileURL(repo).href, '', sha, plan)
    cleanups.push(checkout)
    expect(readFileSync(join(checkout, 'src space', 'keep.ts'), 'utf8')).toBe('old')
    expect(readFileSync(join(checkout, 'root file '), 'utf8')).toBe('trailing space is literal')
    expect(existsSync(join(checkout, 'outside.ts'))).toBe(false)
    expect(existsSync(join(checkout, 'src space', 'excluded.ts'))).toBe(false)
  })
  it('awaits Git child termination before permitting checkout cleanup', async () => {
    const script = join(repo, 'wait.cjs')
    const ready = join(repo, 'ready')
    const stopped = join(repo, 'stopped')
    writeFileSync(
      script,
      `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},100);`
    )
    const controller = new AbortController()
    const command = `!"${process.execPath}" "${script}"`
    const running = runGit(['-c', `alias.fixturewait=${command}`, 'fixturewait'], undefined, controller.signal)
    const result = running.catch(error => error)
    await expect.poll(() => existsSync(ready)).toBe(true)
    controller.abort()
    expect(await result).toMatchObject({ message: 'Git operation cancelled' })
    expect(existsSync(stopped)).toBe(true)
    cleanupTmpDir(repo)
    expect(existsSync(repo)).toBe(false)
  })
})
