import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export function buildCloneArgs(repoUrl: string, targetDir: string): string[] {
  return ['clone', '--depth', '1', repoUrl, targetDir]
}

export async function cloneRepo(repoUrl: string, token?: string): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specvoice-'))
  const resolvedToken = token ?? process.env.GITHUB_TOKEN
  const askpassPath = `${tmpDir}.askpass`
  const tokenPath = `${tmpDir}.token`
  if (resolvedToken) {
    fs.writeFileSync(tokenPath, resolvedToken, { mode: 0o600 })
    fs.writeFileSync(
      askpassPath,
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf \'%s\\n\' oauth2 ;;\n  *) cat "$GIT_ASKPASS_TOKEN_FILE" ;;\nesac\n',
      { mode: 0o700 }
    )
  }
  const { GITHUB_TOKEN: _ignoredToken, ...baseEnv } = process.env
  return new Promise((resolve, reject) => {
    const proc = spawn('git', buildCloneArgs(repoUrl, tmpDir), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...baseEnv,
        ...(resolvedToken ? { GIT_ASKPASS: askpassPath, GIT_ASKPASS_TOKEN_FILE: tokenPath, GIT_TERMINAL_PROMPT: '0' } : {}),
      },
    })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('close', (code) => {
      cleanupCredentialFiles(askpassPath, tokenPath)
      if (code === 0) {
        resolve(tmpDir)
      } else {
        cleanupTmpDir(tmpDir)
        reject(new Error(`git clone failed: ${stderr.trim() || 'unknown error'}`))
      }
    })
    proc.on('error', (err) => {
      cleanupCredentialFiles(askpassPath, tokenPath)
      cleanupTmpDir(tmpDir)
      reject(err)
    })
  })
}

function cleanupCredentialFiles(...files: string[]): void {
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // best effort — the clone result still determines the request outcome
    }
  }
}

/**
 * Delete `dir` recursively. Best-effort: never throws.
 */
export function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best effort — log but don't propagate
  }
}
