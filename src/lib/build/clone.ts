import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export function injectTokenIntoUrl(repoUrl: string, token: string | undefined): string {
  if (!token) return repoUrl
  if (!repoUrl.startsWith('https://')) return repoUrl
  return repoUrl.replace('https://', `https://oauth2:${token}@`)
}

export async function cloneRepo(repoUrl: string, token?: string): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specvoice-'))
  const resolvedToken = token ?? process.env.GITHUB_TOKEN
  const authedUrl = injectTokenIntoUrl(repoUrl, resolvedToken)
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['clone', '--depth', '1', authedUrl, tmpDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(tmpDir)
      } else {
        cleanupTmpDir(tmpDir)
        reject(new Error(`git clone failed: ${stderr.trim() || 'unknown error'}`))
      }
    })
    proc.on('error', (err) => {
      cleanupTmpDir(tmpDir)
      reject(err)
    })
  })
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
