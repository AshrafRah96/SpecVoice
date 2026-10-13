import { existsSync, realpathSync, statSync } from 'fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'path'
import ignore from 'ignore'
import { createIgnoreFilter } from '@/lib/code/ignore-rules'
import { MAX_FILE_CHARS, isBinary, formatNumberedLines, buildSearchContext } from '@/lib/code/utils'
import type { CodeSource, CodeOptions, FileInfo, FileContent, FileListing, SearchListing } from '@/lib/code/types'
import { assertLocalRepoPathAllowed, isWithinDirectory } from '@/lib/code/path-policy'
import { operationBudget } from './budget'
import { allowedPath, assertReadable, canTraverse, repositoryPath, under } from './scope'

type Budget = ReturnType<typeof operationBudget>
interface Snapshot {
  sha: string
  top: string
  prefix: string
}
interface Entry extends FileInfo {
  oid: string
}
const exec = promisify(execFile)

export class LocalCodeSource implements CodeSource {
  readonly rootPath: string
  private snapshot?: Promise<Snapshot>
  private readonly ignores = new Map<string, ReturnType<typeof ignore>>()
  private readonly defaults = createIgnoreFilter()

  constructor(
    rootPath: string,
    private readonly expectedCommitSha?: string
  ) {
    const resolved = realpathSync(assertLocalRepoPathAllowed(rootPath))
    const allowedRoot = process.env.SPECVOICE_LOCAL_REPO_ROOT || undefined
    if (allowedRoot && !isWithinDirectory(realpathSync(/* turbopackIgnore: true */ allowedRoot), resolved)) {
      throw new Error('Local repo path resolves outside SPECVOICE_LOCAL_REPO_ROOT.')
    }
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error(`Local repo path is not a directory: ${rootPath}. Check that the path exists and is accessible.`)
    }
    this.rootPath = resolved
  }

  async getCommitSha(signal?: AbortSignal): Promise<string> {
    return (await this.pinned(signal)).sha
  }

  private pinned(signal?: AbortSignal): Promise<Snapshot> {
    signal?.throwIfAborted()
    if (!this.snapshot) {
      this.snapshot = this.resolveSnapshot(signal).catch(error => {
        this.snapshot = undefined
        throw error
      })
    }
    return this.snapshot
  }

  private async resolveSnapshot(signal?: AbortSignal): Promise<Snapshot> {
    const options = { signal, timeout: 10_000, maxBuffer: 64 * 1024 }
    try {
      const { stdout: top } = await exec('git', ['-C', this.rootPath, 'rev-parse', '--show-toplevel'], options)
      const { stdout: sha } = await exec(
        'git',
        [
          '-C',
          this.rootPath,
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${this.expectedCommitSha ?? 'HEAD'}^{commit}`,
        ],
        options
      )
      const snapshot = {
        sha: sha.trim(),
        top: top.trim(),
        prefix: path.relative(top.trim(), this.rootPath).split(path.sep).join('/'),
      }
      if (snapshot.prefix) {
        const { stdout: type } = await exec(
          'git',
          ['-C', snapshot.top, 'cat-file', '-t', `${snapshot.sha}:${snapshot.prefix}`],
          options
        )
        if (type.trim() !== 'tree') throw new Error('Selected directory is not a committed tree')
      }
      return snapshot
    } catch (error) {
      signal?.throwIfAborted()
      throw new Error(
        `Cannot resolve committed local repository${this.expectedCommitSha ? ` at ${this.expectedCommitSha}` : ''}.`,
        { cause: error }
      )
    }
  }

  private tree(snapshot: Snapshot, dir: string): string {
    const prefix = [snapshot.prefix, dir].filter(Boolean).join('/')
    return prefix ? `${snapshot.sha}:${prefix}` : snapshot.sha
  }

  private parse(record: string, dir: string): Entry | undefined {
    const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\s+(-|\d+)\t([\s\S]*)$/.exec(record)
    if (!match || (match[2] !== 'tree' && !match[1].startsWith('100'))) return undefined
    const relative = [dir, match[5]].filter(Boolean).join('/')
    try {
      repositoryPath(relative)
    } catch {
      return undefined
    }
    return {
      path: relative,
      type: match[2] === 'tree' ? 'dir' : 'file',
      size: match[4] === '-' ? undefined : Number(match[4]),
      oid: match[3],
    }
  }

  private async *entries(snapshot: Snapshot, dir: string, signal: AbortSignal, name?: string): AsyncGenerator<Entry> {
    signal.throwIfAborted()
    const args = [
      '-C',
      snapshot.top,
      'ls-tree',
      '-l',
      '-z',
      this.tree(snapshot, dir),
      ...(name ? ['--', `:(literal)${name}`] : []),
    ]
    const proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let error: Error | undefined
    let stderr = ''
    const closed = new Promise<number | null>(resolve => {
      proc.once('error', caught => {
        error = caught
      })
      proc.once('close', resolve)
    })
    const stop = () => {
      proc.kill('SIGKILL')
    }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096)
    })
    proc.stdout.setEncoding('utf8')
    let complete = false
    try {
      let pending = ''
      for await (const chunk of proc.stdout) {
        pending += chunk
        let end: number
        while ((end = pending.indexOf('\0')) !== -1) {
          const entry = this.parse(pending.slice(0, end), dir)
          pending = pending.slice(end + 1)
          if (entry) yield entry
        }
      }
      complete = true
    } finally {
      if (!complete) stop()
      const code = await closed
      signal.removeEventListener('abort', stop)
      signal.throwIfAborted()
      if (error) throw error
      if (complete && code !== 0) throw new Error(`Cannot inspect committed directory ${dir || '.'}: ${stderr.trim()}`)
    }
  }

  private async blob(snapshot: Snapshot, entry: Entry, budget: Budget): Promise<Buffer> {
    const { stdout } = await exec('git', ['-C', snapshot.top, 'cat-file', 'blob', entry.oid], {
      encoding: 'buffer',
      signal: budget.signal,
      maxBuffer: budget.limits.maxBytes,
    })
    return stdout
  }

  private async loadIgnore(snapshot: Snapshot, dir: string, budget: Budget): Promise<boolean> {
    if (this.ignores.has(dir)) return true
    let rules = ''
    for await (const entry of this.entries(snapshot, dir, budget.signal, '.gitignore')) {
      if (entry.type !== 'file') continue
      // Rule-loading work consumes bytes independently of inventoried source content.
      if (!budget.takeBytes(entry.size ?? 0)) return false
      rules = (await this.blob(snapshot, entry, budget)).toString('utf8')
    }
    this.ignores.set(dir, ignore().add(rules))
    return true
  }

  private ignored(relative: string, directory: boolean): boolean {
    const suffix = directory ? '/' : ''
    let ignored = this.defaults.ignores(relative + suffix)
    const parts = relative.split('/')
    for (let index = 0; index < parts.length; index++) {
      const dir = parts.slice(0, index).join('/')
      const filter = this.ignores.get(dir)
      if (!filter) continue
      const match = filter.test(parts.slice(index).join('/') + suffix)
      if (match.ignored) ignored = true
      if (match.unignored) ignored = false
    }
    return ignored
  }

  private async *inventory(
    snapshot: Snapshot,
    options: CodeOptions,
    budget: Budget,
    dirPath?: string
  ): AsyncGenerator<Entry> {
    if (dirPath) repositoryPath(dirPath)
    for (const root of [...(options.scope?.includedRoots ?? []), ...(options.scope?.excludedRoots ?? [])])
      repositoryPath(root)
    const includes = options.scope?.includedRoots.length ? options.scope.includedRoots : ['']
    const roots = includes
      .flatMap(root =>
        !dirPath ? [root] : !root || under(dirPath, root) ? [dirPath] : under(root, dirPath) ? [root] : []
      )
      .filter(
        (root, index, all) =>
          !all.some(
            (other, otherIndex) =>
              (otherIndex < index && other === root) || (other !== root && (!other || under(root, other)))
          )
      )
    const queue: string[] = []
    let directories = 0
    const allowed = (entry: Entry) =>
      allowedPath(entry.path) &&
      (entry.type === 'dir' ? canTraverse(entry.path, options.scope) : allowedPath(entry.path, options.scope)) &&
      !this.ignored(entry.path, entry.type === 'dir')
    const accept = (entry: Entry) => {
      if (!allowed(entry)) return false
      if (entry.type === 'file') return budget.take(entry.size ?? 0)
      if (directories >= budget.limits.maxFiles) {
        budget.stop('files')
        return false
      }
      directories++
      return true
    }
    for (const root of roots) {
      if (!root) {
        queue.push('')
        continue
      }
      if (!allowedPath(root) || !canTraverse(root, options.scope)) continue
      const parts = root.split('/')
      let blocked = false
      for (let index = 0; index < parts.length; index++) {
        const parent = parts.slice(0, index).join('/')
        if (!(await this.loadIgnore(snapshot, parent, budget))) return
        if (index < parts.length - 1 && this.ignored(parts.slice(0, index + 1).join('/'), true)) {
          blocked = true
          break
        }
      }
      if (blocked) continue
      const parent = parts.slice(0, -1).join('/')
      for await (const entry of this.entries(snapshot, parent, budget.signal, parts.at(-1))) {
        if (accept(entry)) {
          yield entry
          if (entry.type === 'dir') queue.push(entry.path)
        }
        if (!budget.result().complete) return
      }
    }
    for (let index = 0; index < queue.length; index++) {
      const dir = queue[index]
      if (!(await this.loadIgnore(snapshot, dir, budget))) return
      for await (const entry of this.entries(snapshot, dir, budget.signal)) {
        if (accept(entry)) {
          yield entry
          if (entry.type === 'dir') queue.push(entry.path)
        }
        if (!budget.result().complete) return
      }
    }
  }

  private aborted(options: CodeOptions, budget: Budget, error: unknown): void {
    options.signal?.throwIfAborted()
    if (budget.signal.aborted) budget.stop('time')
    else throw error
  }

  async listFiles(dirPath?: string, options: CodeOptions = {}): Promise<FileListing> {
    const budget = operationBudget(options)
    const files: FileInfo[] = []
    try {
      const snapshot = await this.pinned(budget.signal)
      for await (const entry of this.inventory(snapshot, options, budget, dirPath)) {
        files.push({ path: entry.path, type: entry.type, ...(entry.size === undefined ? {} : { size: entry.size }) })
      }
    } catch (error) {
      this.aborted(options, budget, error)
    }
    // Dirs first, then files; alphabetical within each group
    files.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.path.localeCompare(b.path)))
    return { files, ...budget.result() }
  }

  async readFile(
    filePath: string,
    startLine?: number,
    endLine?: number,
    options: CodeOptions = {}
  ): Promise<FileContent> {
    assertReadable(filePath, options.scope)
    const budget = operationBudget(options)
    const snapshot = await this.pinned(budget.signal)
    for await (const entry of this.inventory(snapshot, options, budget, filePath)) {
      if (entry.path !== filePath) continue
      if (entry.type !== 'file') break
      const raw = await this.blob(snapshot, entry, budget)
      if (isBinary(raw)) throw new Error(`File appears to be binary and cannot be read as text: ${filePath}`)
      const allLines = raw.toString('utf8').split('\n')
      // Apply line range (1-indexed, inclusive)
      const start = Math.max(1, startLine ?? 1)
      const lines = allLines.slice(start - 1, endLine)
      const numbered = formatNumberedLines(lines, allLines.length, start).join('\n')
      return {
        path: filePath,
        content: numbered.slice(0, MAX_FILE_CHARS),
        lineCount: lines.length,
        truncated: numbered.length > MAX_FILE_CHARS,
      }
    }
    if (!budget.result().complete)
      throw new Error(`File exceeds discovery ${budget.result().stopReason} budget: ${filePath}`)
    throw new Error(`File not found in repository snapshot: ${filePath}`)
  }

  async searchCode(query: string, maxResults = 20, options: CodeOptions = {}): Promise<SearchListing> {
    if (!Number.isInteger(maxResults) || maxResults < 1) throw new Error('maxResults must be a positive integer')
    const budget = operationBudget(options)
    const results: SearchListing['results'] = []
    const lowerQuery = query.toLowerCase()
    try {
      const snapshot = await this.pinned(budget.signal)
      outer: for await (const entry of this.inventory(snapshot, options, budget)) {
        if (entry.type !== 'file') continue
        const raw = await this.blob(snapshot, entry, budget)
        if (isBinary(raw)) continue
        const lines = raw.toString('utf8').split('\n')
        for (let index = 0; index < lines.length; index++) {
          if (!lines[index].toLowerCase().includes(lowerQuery)) continue
          if (results.length === maxResults) {
            budget.stop('results')
            break outer
          }
          results.push({
            path: entry.path,
            lineNumber: index + 1,
            lineContent: lines[index],
            context: buildSearchContext(lines, index),
          })
        }
      }
    } catch (error) {
      this.aborted(options, budget, error)
    }
    return { results, ...budget.result() }
  }
}
