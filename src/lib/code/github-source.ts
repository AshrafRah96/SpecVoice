import { Octokit } from '@octokit/rest'
import { createIgnoreFilter } from '@/lib/code/ignore-rules'
import { MAX_FILE_CHARS, formatNumberedLines, buildSearchContext, isBinary } from '@/lib/code/utils'
import { operationBudget } from '@/lib/code/budget'
import { allowedPath, assertReadable, canTraverse, repositoryPath, under } from '@/lib/code/scope'
import type {
  CodeSource,
  CodeOptions,
  FileInfo,
  FileContent,
  FileListing,
  SearchListing,
  SearchResult,
} from '@/lib/code/types'
import { parseOwnerRepo } from '@/lib/github/utils'

function handleRateLimit(err: unknown): never {
  const e = err as { status?: number; response?: { headers?: Record<string, string> } }
  if (e.status === 403 || e.status === 429) {
    const resetAt = e.response?.headers?.['x-ratelimit-reset']
    const minutes = resetAt ? Math.ceil((Number(resetAt) * 1000 - Date.now()) / 60000) : 'unknown'
    throw new Error(`GitHub rate limit exceeded, try again in ${minutes} minutes`)
  }
  throw err
}

type Budget = ReturnType<typeof operationBudget>
interface BlobEntry {
  path: string
  sha: string
  size: number
}

export class GitHubCodeSource implements CodeSource {
  private octokit: Octokit
  private owner: string
  private repo: string
  private commitSha?: string
  private resolvingCommit?: Promise<string>
  private ig = createIgnoreFilter()

  constructor(repoUrl: string, token?: string, commitSha?: string, requestFetch?: typeof fetch) {
    const { owner, repo } = parseOwnerRepo(repoUrl)
    this.owner = owner
    this.repo = repo
    this.commitSha = commitSha
    this.octokit = new Octokit({ auth: token, request: { fetch: requestFetch } })
  }

  getCommitSha(signal?: AbortSignal): Promise<string> {
    const deadline = AbortSignal.timeout(10_000)
    return this.resolveCommit(signal ? AbortSignal.any([signal, deadline]) : deadline)
  }

  private async resolveCommit(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (this.commitSha) return this.commitSha
    this.resolvingCommit ??= (async () => {
      try {
        const repo = await this.octokit.repos.get({ owner: this.owner, repo: this.repo, request: { signal } })
        const ref = await this.octokit.git.getRef({
          owner: this.owner,
          repo: this.repo,
          ref: `heads/${repo.data.default_branch}`,
          request: { signal },
        })
        this.commitSha = ref.data.object.sha
        return this.commitSha
      } catch (error) {
        this.resolvingCommit = undefined
        handleRateLimit(error)
      }
    })()
    return this.resolvingCommit
  }

  private stopped(error: unknown, options: CodeOptions, budget: Budget) {
    options.signal?.throwIfAborted()
    if (budget.signal.aborted) budget.stop('time')
    else handleRateLimit(error)
  }

  private async inventory(dirPath: string | undefined, options: CodeOptions, budget: Budget) {
    if (dirPath) repositoryPath(dirPath)
    const files: FileInfo[] = []
    const blobs: BlobEntry[] = []
    let providerPartial = false
    let directories = 0
    const visit = async (treeSha: string, prefix: string): Promise<boolean> => {
      budget.signal.throwIfAborted()
      const { data } = await this.octokit.git.getTree({
        owner: this.owner,
        repo: this.repo,
        tree_sha: treeSha,
        request: { signal: budget.signal },
      })
      providerPartial ||= data.truncated
      for (const item of data.tree) {
        budget.signal.throwIfAborted()
        if (!item.path || !item.sha) continue
        const path = prefix + item.path
        const directory = item.type === 'tree'
        if (!allowedPath(path) || this.ig.ignores(directory ? `${path}/` : path)) continue
        const selected = !dirPath || under(path, dirPath)
        if (directory) {
          if (!canTraverse(path, options.scope) || (dirPath && !selected && !under(dirPath, path))) continue
          if (++directories > budget.limits.maxFiles) {
            budget.stop('files')
            return false
          }
          if (selected && allowedPath(path, options.scope)) files.push({ path, type: 'dir' })
          if (!(await visit(item.sha, `${path}/`))) return false
        } else if (item.type === 'blob' && (item.mode === '100644' || item.mode === '100755')) {
          if (!selected || !allowedPath(path, options.scope)) continue
          if (item.size === undefined) {
            providerPartial = true
            continue
          }
          if (!budget.take(item.size)) return false
          files.push({ path, type: 'file', size: item.size })
          blobs.push({ path, sha: item.sha, size: item.size })
        }
      }
      return true
    }
    try {
      const sha = await this.resolveCommit(budget.signal)
      const { data } = await this.octokit.git.getCommit({
        owner: this.owner,
        repo: this.repo,
        commit_sha: sha,
        request: { signal: budget.signal },
      })
      await visit(data.tree.sha, '')
    } catch (error) {
      this.stopped(error, options, budget)
    }
    if (providerPartial) budget.stop('provider')
    files.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1))
    return { files, blobs }
  }

  async listFiles(dirPath?: string, options: CodeOptions = {}): Promise<FileListing> {
    const budget = operationBudget(options)
    const { files } = await this.inventory(dirPath, options, budget)
    return { files, ...budget.result() }
  }

  private async readBlob(file: BlobEntry, budget: Budget): Promise<Buffer> {
    budget.signal.throwIfAborted()
    const { data } = await this.octokit.git.getBlob({
      owner: this.owner,
      repo: this.repo,
      file_sha: file.sha,
      request: { signal: budget.signal },
    })
    if (data.encoding !== 'base64' || data.size !== file.size || data.size > budget.limits.maxBytes) {
      throw new Error(`GitHub blob exceeds the budget or differs from the pinned tree: ${file.path}`)
    }
    const encoded = data.content.replace(/\s/g, '')
    if (encoded.length > Math.ceil(file.size / 3) * 4) {
      throw new Error(`GitHub blob exceeds the pinned file size: ${file.path}`)
    }
    const buffer = Buffer.from(encoded, 'base64')
    if (buffer.length !== file.size) throw new Error(`GitHub blob size differs from the pinned tree: ${file.path}`)
    return buffer
  }

  async readFile(
    filePath: string,
    startLine?: number,
    endLine?: number,
    options: CodeOptions = {}
  ): Promise<FileContent> {
    assertReadable(filePath, options.scope)
    const budget = operationBudget(options)
    const { blobs } = await this.inventory(filePath, options, budget)
    const file = blobs.find(item => item.path === filePath)
    if (!file) throw new Error(`File is unavailable within the discovery budget: ${filePath}`)
    let buffer: Buffer
    try {
      buffer = await this.readBlob(file, budget)
    } catch (error) {
      options.signal?.throwIfAborted()
      handleRateLimit(error)
    }
    if (isBinary(buffer)) throw new Error(`Cannot read a binary file: ${filePath}`)
    let lines = buffer.toString('utf8').split('\n')
    const totalLines = lines.length
    const start = Math.max(1, startLine ?? 1)
    if (startLine !== undefined || endLine !== undefined) lines = lines.slice(start - 1, endLine)
    const joined = formatNumberedLines(lines, totalLines, start).join('\n')
    return {
      path: filePath,
      content: joined.slice(0, MAX_FILE_CHARS),
      lineCount: lines.length,
      truncated: joined.length > MAX_FILE_CHARS,
    }
  }

  async searchCode(query: string, maxResults = 20, options: CodeOptions = {}): Promise<SearchListing> {
    if (!Number.isInteger(maxResults) || maxResults < 1) throw new Error('Search result limit must be positive')
    const budget = operationBudget(options)
    // GitHub code search is branch-scoped; immutable sessions scan only the allowed pinned blobs.
    const { blobs } = await this.inventory(undefined, options, budget)
    const results: SearchResult[] = []
    const lowerQuery = query.toLowerCase()
    try {
      for (const file of blobs) {
        const buffer = await this.readBlob(file, budget)
        if (isBinary(buffer)) continue
        const lines = buffer.toString('utf8').split('\n')
        for (let index = 0; index < lines.length; index++) {
          budget.signal.throwIfAborted()
          if (!lines[index].toLowerCase().includes(lowerQuery)) continue
          results.push({
            path: file.path,
            lineNumber: index + 1,
            lineContent: lines[index].trim(),
            context: buildSearchContext(lines, index),
          })
          if (results.length === maxResults) {
            budget.stop('results')
            return { results, ...budget.result() }
          }
        }
      }
    } catch (error) {
      this.stopped(error, options, budget)
    }
    return { results, ...budget.result() }
  }
}
