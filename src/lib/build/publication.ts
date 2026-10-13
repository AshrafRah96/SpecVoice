import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { ScopePlan, Session } from '@/lib/session/types'
import { allowedPath, repositoryPath } from '@/lib/code/scope'
import { runGit } from './clone'
import { validateChangedPaths } from './scope-check'

const MAX_BYTES = 64 * 1024 * 1024
const MAX_FILES = 100_000
const identity: NodeJS.ProcessEnv = {
  NODE_ENV: process.env.NODE_ENV,
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'SpecVoice',
  GIT_AUTHOR_EMAIL: 'specvoice@noreply.github.com',
  GIT_COMMITTER_NAME: 'SpecVoice',
  GIT_COMMITTER_EMAIL: 'specvoice@noreply.github.com',
}

function git(dir: string, args: string[], signal?: AbortSignal) {
  return runGit(
    ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args],
    identity,
    signal
  )
}

async function requireClean(dir: string, paths: string[], signal?: AbortSignal) {
  try {
    await git(dir, ['diff', '--quiet', 'HEAD', '--', ...paths], signal)
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error('Execution requires a clean trusted checkout; tracked files differ from the pinned commit.', {
      cause: error,
    })
  }
}

function checkPatchBudget(patch: string) {
  let bytes = Buffer.byteLength(patch, 'utf8')
  const limit = () => {
    if (bytes > MAX_BYTES) throw new Error('Execution patch exceeds the 64 MiB expanded transfer limit.')
  }
  limit()
  if (/^(?:new file mode|new mode) (?:120000|160000)\r?$/m.test(patch))
    throw new Error('Execution patches do not support symlinks or submodules.')
  const marker = /^GIT binary patch(?:\r?\n|$)/gm
  const header = /(literal|delta) (\d+)\r?\n/y
  // Git's binary format uses its own base85 alphabet, not ASCII85.
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~'
  while (marker.exec(patch)) {
    let cursor = marker.lastIndex
    let blocks = 0
    while (blocks < 2) {
      header.lastIndex = cursor
      const block = header.exec(patch)
      if (!block) break
      const start = cursor
      cursor = header.lastIndex
      const declared = Number(block[2])
      if (!Number.isSafeInteger(declared) || declared > MAX_BYTES)
        throw new Error('Execution patch exceeds the 64 MiB expanded transfer limit.')
      const compressed: Buffer[] = []
      for (;;) {
        const end = patch.indexOf('\n', cursor)
        if (end < 0) throw new Error('Malformed binary execution patch')
        const line = patch.slice(cursor, end).replace(/\r$/, '')
        cursor = end + 1
        if (!line) break
        const prefix = line.charCodeAt(0)
        const count = prefix >= 65 && prefix <= 90 ? prefix - 64 : prefix >= 97 && prefix <= 122 ? prefix - 70 : 0
        if (!count || line.length !== 1 + Math.ceil(count / 4) * 5) throw new Error('Malformed binary execution patch')
        const decoded = Buffer.alloc(Math.ceil(count / 4) * 4)
        for (let index = 1; index < line.length; index += 5) {
          let value = 0
          for (const character of line.slice(index, index + 5)) {
            const digit = alphabet.indexOf(character)
            if (digit < 0) throw new Error('Malformed binary execution patch')
            value = value * 85 + digit
          }
          if (value > 0xffffffff) throw new Error('Malformed binary execution patch')
          decoded.writeUInt32BE(value, ((index - 1) / 5) * 4)
        }
        compressed.push(decoded.subarray(0, count))
      }
      let data: Buffer
      try {
        data = inflateSync(Buffer.concat(compressed), { maxOutputLength: declared + 1 })
      } catch (error) {
        throw new Error('Malformed or oversized binary execution patch', { cause: error })
      }
      if (data.length !== declared) throw new Error('Malformed binary execution patch')
      let expanded = declared
      if (block[1] === 'delta') {
        let offset = 0
        const readSize = () => {
          let value = 0
          for (let shift = 0; shift < 56 && offset < data.length; shift += 7) {
            const byte = data[offset++]
            value += (byte & 127) * 2 ** shift
            if (!(byte & 128) && Number.isSafeInteger(value)) return value
          }
          throw new Error('Malformed binary execution delta')
        }
        if (readSize() > MAX_BYTES) throw new Error('Execution patch exceeds the 64 MiB expanded transfer limit.')
        expanded = readSize()
      }
      bytes += expanded - Buffer.byteLength(patch.slice(start, cursor), 'utf8')
      limit()
      blocks++
    }
    if (!blocks || /^(literal|delta) /.test(patch.slice(cursor))) throw new Error('Malformed binary execution patch')
    marker.lastIndex = cursor
  }
}

/** Only tracked, scoped regular-file bytes cross into the untrusted execution container. */
export async function executionFiles(
  dir: string,
  scopePlan?: ScopePlan | null,
  signal?: AbortSignal
): Promise<Array<{ path: string; content: string; mode: '100644' | '100755' }>> {
  signal?.throwIfAborted()
  if (scopePlan && scopePlan.status !== 'confirmed') throw new Error('Execution requires a confirmed Scope Plan')
  if (scopePlan && (await git(dir, ['rev-parse', 'HEAD'], signal)).trim() !== scopePlan.repositorySha)
    throw new Error('Scope Plan does not match the pinned checkout')
  const paths = [
    ...(scopePlan?.includedRoots ?? []).map(path => `:(top,literal)${repositoryPath(path)}`),
    ...(scopePlan?.excludedRoots ?? []).map(path => `:(top,exclude,literal)${repositoryPath(path)}`),
  ]
  const listing = await git(dir, ['ls-files', '--stage', '-z', '--', ...paths], signal)
  const entries = listing
    .split('\0')
    .filter(Boolean)
    .map(entry => {
      const tab = entry.indexOf('\t')
      const [mode, oid, stage] = entry.slice(0, tab).split(' ')
      if (tab < 0 || stage !== '0') throw new Error('Execution requires an unambiguous tracked-file index')
      return { path: entry.slice(tab + 1), mode, oid }
    })
    .filter(entry => allowedPath(entry.path, scopePlan ?? undefined) && !['SPEC.md', 'CONTEXT.md'].includes(entry.path))
    .map((entry): { path: string; mode: '100644' | '100755'; oid: string } => {
      if (entry.mode !== '100644' && entry.mode !== '100755')
        throw new Error(`Execution does not support symlinks or submodules: ${entry.path}`)
      return { path: entry.path, mode: entry.mode, oid: entry.oid }
    })
  if (entries.length > MAX_FILES) throw new Error('Execution exceeds 100000 files; confirm a narrower Scope Plan.')
  await requireClean(dir, paths, signal)
  const root = await realpath(dir)
  const files: Array<{ path: string; content: string; mode: '100644' | '100755' }> = []
  let bytes = 0
  for (const entry of entries) {
    signal?.throwIfAborted()
    const path = join(root, entry.path)
    const stat = await lstat(path)
    if (!stat.isFile() || !(await realpath(path)).startsWith(`${root}${sep}`))
      throw new Error(`Execution requires a regular file inside the trusted checkout: ${entry.path}`)
    if (bytes + stat.size > MAX_BYTES) throw new Error('Execution exceeds 64 MiB; confirm a narrower Scope Plan.')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const chunks: Buffer[] = []
    try {
      for await (const chunk of file.createReadStream()) {
        signal?.throwIfAborted()
        bytes += chunk.length
        if (bytes > MAX_BYTES) throw new Error('Execution exceeds 64 MiB; confirm a narrower Scope Plan.')
        chunks.push(chunk)
      }
    } finally {
      await file.close()
    }
    const content = Buffer.concat(chunks)
    const oid = createHash(entry.oid.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest('hex')
    if (oid !== entry.oid) throw new Error(`Tracked bytes differ from the pinned commit: ${entry.path}`)
    files.push({ path: entry.path, content: content.toString('base64'), mode: entry.mode })
  }
  return files
}

/** Apply data, never the executor's Git configuration, to the worker-owned checkout. */
export async function applyExecutionPatch(
  dir: string,
  patch: string,
  session: Session,
  commitMessage: string,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  checkPatchBudget(patch)
  if (!session.repositorySha) throw new Error('Build publication requires a pinned Repository Snapshot')
  if ((await git(dir, ['rev-parse', 'HEAD'], signal)).trim() !== session.repositorySha)
    throw new Error('Trusted publication checkout does not match the pinned Repository Snapshot')
  await validateChangedPaths(dir, session, signal, session.repositorySha)
  await requireClean(dir, [], signal)
  const temporary = await mkdtemp(join(tmpdir(), 'specvoice-publication-'))
  try {
    const file = join(temporary, 'execution.patch')
    await writeFile(file, patch, { mode: 0o600, signal })
    await git(dir, ['apply', '--index', '--binary', '--', file], signal)
    await git(dir, ['commit', '--no-gpg-sign', '-m', commitMessage, '--'], signal)
    const commit = (await git(dir, ['rev-parse', 'HEAD'], signal)).trim()
    await validateChangedPaths(dir, session, signal, commit)
    return commit
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
