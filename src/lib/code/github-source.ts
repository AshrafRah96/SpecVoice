import { Octokit } from '@octokit/rest'
import { createIgnoreFilter } from '@/lib/code/ignore-rules'
import { MAX_FILE_CHARS, formatNumberedLines, buildSearchContext } from '@/lib/code/utils'
import type { CodeSource, FileInfo, FileContent, SearchResult } from '@/lib/code/types'
import { parseOwnerRepo } from '@/lib/github/utils'

function handleRateLimit(err: unknown): never {
  const e = err as { status?: number; response?: { headers?: Record<string, string> } }
  if (e.status === 403 || e.status === 429) {
    const resetAt = e.response?.headers?.['x-ratelimit-reset']
    const minutes = resetAt
      ? Math.ceil((Number(resetAt) * 1000 - Date.now()) / 60000)
      : 'unknown'
    throw new Error(`GitHub rate limit exceeded, try again in ${minutes} minutes`)
  }
  throw err
}

export class GitHubCodeSource implements CodeSource {
  private octokit: Octokit
  private owner: string
  private repo: string
  private token?: string
  private ig = createIgnoreFilter()

  constructor(repoUrl: string, token?: string) {
    const { owner, repo } = parseOwnerRepo(repoUrl)
    this.owner = owner
    this.repo = repo
    this.token = token
    this.octokit = new Octokit({ auth: token })
  }

  async listFiles(dirPath?: string): Promise<FileInfo[]> {
    let data: Awaited<ReturnType<typeof this.octokit.git.getTree>>['data']
    try {
      const response = await this.octokit.git.getTree({
        owner: this.owner,
        repo: this.repo,
        tree_sha: 'HEAD',
        recursive: '1',
      })
      data = response.data
    } catch (err) {
      handleRateLimit(err)
    }

    if (data.truncated) {
      console.warn(`[GitHubCodeSource] Tree truncated for ${this.owner}/${this.repo} — repo exceeds 100k entries`)
    }

    const prefix = dirPath ? dirPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' : ''
    const results: FileInfo[] = []

    for (const item of data.tree ?? []) {
      if (!item.path) continue
      if (this.ig.ignores(item.path)) continue
      if (prefix && !item.path.startsWith(prefix) && item.path !== dirPath) continue

      results.push({
        path: item.path,
        type: item.type === 'tree' ? 'dir' : 'file',
        size: item.size ?? undefined,
      })
    }

    results.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.path.localeCompare(b.path)
    })

    return results
  }

  async readFile(filePath: string, startLine?: number, endLine?: number): Promise<FileContent> {
    let responseData: Awaited<ReturnType<typeof this.octokit.repos.getContent>>['data']
    try {
      const response = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
      })
      responseData = response.data
    } catch (err) {
      handleRateLimit(err)
    }

    if (Array.isArray(responseData) || responseData.type !== 'file') {
      throw new Error(`Path is a directory, not a file: ${filePath}`)
    }

    const decoded = Buffer.from(responseData.content, 'base64').toString('utf-8')
    let lines = decoded.split('\n')
    const totalLines = lines.length

    if (startLine !== undefined || endLine !== undefined) {
      const start = Math.max(0, (startLine ?? 1) - 1)
      const end = endLine !== undefined ? endLine : lines.length
      lines = lines.slice(start, end)
    }

    const numbered = formatNumberedLines(lines, totalLines, startLine)

    const joined = numbered.join('\n')
    const truncated = joined.length > MAX_FILE_CHARS
    const content = truncated ? joined.slice(0, MAX_FILE_CHARS) : joined

    return {
      path: filePath,
      content,
      lineCount: lines.length,
      truncated,
    }
  }

  async searchCode(query: string, maxResults = 20): Promise<SearchResult[]> {
    // Try GitHub code search API first (requires auth token)
    if (this.token) {
      try {
        const { data } = await this.octokit.search.code({
          q: `${query} repo:${this.owner}/${this.repo}`,
          per_page: maxResults,
        })
        return data.items.map(item => ({
          path: item.path,
          lineNumber: 1,
          lineContent: item.name,
          context: [],
        }))
      } catch {
        // Fall through to manual scan
      }
    }

    // Fallback: manual scan (only viable for small repos)
    const files = await this.listFiles()
    const fileOnlyPaths = files.filter(f => f.type === 'file').map(f => f.path)

    if (fileOnlyPaths.length > 100) {
      throw new Error(
        `Repo too large for unauthenticated search (${fileOnlyPaths.length} files). ` +
          'Set GITHUB_TOKEN in .env.local for code search.'
      )
    }

    const results: SearchResult[] = []
    const lowerQuery = query.toLowerCase()

    for (const filePath of fileOnlyPaths) {
      if (results.length >= maxResults) break
      let fileContent: FileContent
      try {
        fileContent = await this.readFile(filePath)
      } catch {
        continue
      }
      const lines = fileContent.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) break
        if (lines[i].toLowerCase().includes(lowerQuery)) {
          results.push({
            path: filePath,
            lineNumber: i + 1,
            lineContent: lines[i].trim(),
            context: buildSearchContext(lines, i),
          })
        }
      }
    }

    return results
  }
}
