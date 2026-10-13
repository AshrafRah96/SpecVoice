import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { repositoryPath } from '@/lib/code/scope'
import type { ScopePlan } from '@/lib/session/types'

export function buildCloneArgs(repoUrl: string, targetDir: string): string[] {
  return ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', repoUrl, targetDir]
}

/** Git work is bounded and fully stopped before callers clean up its directory. */
export async function runGit(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'], env, detached: process.platform !== 'win32' })
    let stdout = ''
    let stderr = ''
    let failure: Error | undefined
    let force: ReturnType<typeof setTimeout> | undefined
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, sig)
        else proc.kill(sig)
      } catch {
        /* Already exited. */
      }
    }
    const stop = (error: Error) => {
      if (failure) return
      failure = error
      kill('SIGTERM')
      force = setTimeout(() => kill('SIGKILL'), 5000)
      force.unref()
    }
    const abort = () => stop(new Error('Git operation cancelled'))
    const timeout = setTimeout(() => stop(new Error('Git operation timed out after 120000ms')), 120_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    proc.stdout.on('data', (chunk: Buffer) => {
      if (failure) return
      stdout += chunk.toString()
      if (stdout.length > 16 * 1024 * 1024) stop(new Error('Git output exceeded its limit'))
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192)
    })
    proc.on('error', error => {
      failure = error
    })
    proc.on('close', code => {
      // A Git hook may outlive its parent with inherited streams closed.
      if (process.platform !== 'win32') kill('SIGKILL')
      clearTimeout(timeout)
      if (force) clearTimeout(force)
      signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`git ${args[0]} failed: ${stderr.trim() || 'unknown error'}`))
      else resolve(stdout)
    })
  })
}

async function withCredentials<T>(
  dir: string,
  token: string | undefined,
  work: (env: NodeJS.ProcessEnv) => Promise<T>
) {
  const askpassPath = `${dir}.askpass`
  const tokenPath = `${dir}.token`
  const {
    GITHUB_TOKEN: _github,
    ANTHROPIC_API_KEY: _anthropic,
    DATABASE_URL: _database,
    SESSION_CAPABILITY_SECRET: _capability,
    ELEVENLABS_API_KEY: _eleven,
    ELEVENLABS_WEBHOOK_SECRET: _webhook,
    ...env
  } = process.env
  try {
    if (token) {
      fs.writeFileSync(tokenPath, token, { mode: 0o600 })
      fs.writeFileSync(
        askpassPath,
        '#!/bin/sh\ncase "$1" in\n  *Username*) printf \'%s\\n\' oauth2 ;;\n  *) cat "$GIT_ASKPASS_TOKEN_FILE" ;;\nesac\n',
        { mode: 0o700 }
      )
    }
    return await work({
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      ...(token ? { GIT_ASKPASS: askpassPath, GIT_ASKPASS_TOKEN_FILE: tokenPath } : {}),
    })
  } finally {
    for (const file of [askpassPath, tokenPath]) fs.rmSync(file, { force: true })
  }
}

export async function cloneRepo(
  repoUrl: string,
  token?: string,
  commitSha?: string,
  scopePlan?: ScopePlan,
  signal?: AbortSignal
): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specvoice-'))
  try {
    await withCredentials(dir, token ?? process.env.GITHUB_TOKEN, async env => {
      await runGit(buildCloneArgs(repoUrl, dir), env, signal)
      if (commitSha) await runGit(['-C', dir, 'fetch', '--depth', '1', 'origin', commitSha], env, signal)
      if (scopePlan && (scopePlan.includedRoots.length || scopePlan.excludedRoots.length)) {
        // Sparse patterns trim unescaped trailing spaces; scope entries stay literal.
        const included = scopePlan.includedRoots.map(root => repositoryPath(root).replace(/ /g, '\\ '))
        const excluded = scopePlan.excludedRoots.map(root => repositoryPath(root).replace(/ /g, '\\ '))
        const patterns = included.length ? included.flatMap(root => [`/${root}`, `/${root}/**`]) : ['/*']
        patterns.push(...excluded.flatMap(root => [`!/${root}`, `!/${root}/**`]))
        await runGit(['-C', dir, 'sparse-checkout', 'init', '--no-cone'], env, signal)
        fs.writeFileSync(path.join(dir, '.git', 'info', 'sparse-checkout'), `${patterns.join('\n')}\n`)
      }
      await runGit(['-C', dir, 'checkout', '--detach', commitSha ?? 'HEAD'], env, signal)
    })
    return dir
  } catch (error) {
    cleanupTmpDir(dir)
    throw error
  }
}

export async function pushBranch(
  dir: string,
  branchName: string,
  commit: string,
  token?: string,
  signal?: AbortSignal
): Promise<void> {
  await withCredentials(dir, token ?? process.env.GITHUB_TOKEN, env =>
    runGit(['-C', dir, 'push', '-u', 'origin', `${commit}:refs/heads/${branchName}`], env, signal)
  )
}

/**
 * Delete `dir` recursively. Best-effort: never throws.
 */
export function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort — log but don't propagate */
  }
}
