import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Clone `repoUrl` into a new temp directory. Async so the event loop stays
 * responsive during the clone — spawnSync would block all incoming requests.
 * Injects GITHUB_TOKEN into the URL if set (required for private repos and push).
 * Reads GITHUB_TOKEN from process.env directly — it is optional in the validated
 * env schema, so importing the `env` singleton (which validates ELEVENLABS_API_KEY)
 * would throw in non-Next.js contexts like tests and the Claude Code subprocess.
 */
export async function cloneRepo(repoUrl: string): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specvoice-'))
  const token = process.env.GITHUB_TOKEN
  const authedUrl = token
    ? repoUrl.replace('https://', `https://oauth2:${token}@`)
    : repoUrl
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
