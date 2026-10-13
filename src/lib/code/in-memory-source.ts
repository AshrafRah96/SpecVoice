import type { CodeSource, CodeOptions, FileInfo, SearchResult } from './types'
import { operationBudget } from './budget'
import { MAX_FILE_CHARS, formatNumberedLines, buildSearchContext } from './utils'
import { allowedPath, assertReadable, repositoryPath, under } from './scope'

export class InMemoryCodeSource implements CodeSource {
  constructor(
    private readonly files: Record<string, string> = {},
    private readonly sha = 'fixture-commit'
  ) {}
  async getCommitSha(signal?: AbortSignal) {
    signal?.throwIfAborted()
    return this.sha
  }
  async listFiles(path?: string, options: CodeOptions = {}) {
    if (path) repositoryPath(path)
    const budget = operationBudget(options)
    const files: FileInfo[] = []
    for (const [name, content] of Object.entries(this.files)) {
      if (!allowedPath(name, options.scope) || (path && !under(name, path))) continue
      if (!budget.take(Buffer.byteLength(content))) break
      files.push({ path: name, type: 'file', size: Buffer.byteLength(content) })
    }
    return { files, ...budget.result() }
  }
  async readFile(path: string, startLine = 1, endLine?: number, options: CodeOptions = {}) {
    options.signal?.throwIfAborted()
    assertReadable(path, options.scope)
    if (!(path in this.files)) throw new Error(`File not found: ${path}`)
    const budget = operationBudget(options)
    if (!budget.take(Buffer.byteLength(this.files[path]))) throw new Error('File exceeds discovery budget')
    const allLines = this.files[path].split('\n')
    const lines = allLines.slice(startLine - 1, endLine)
    const content = formatNumberedLines(lines, allLines.length, startLine).join('\n')
    return {
      path,
      content: content.slice(0, MAX_FILE_CHARS),
      lineCount: lines.length,
      truncated: content.length > MAX_FILE_CHARS,
    }
  }
  async searchCode(query: string, maxResults = 20, options: CodeOptions = {}) {
    if (!Number.isInteger(maxResults) || maxResults < 1) throw new Error('Search result limit must be positive')
    const listing = await this.listFiles(undefined, options)
    const results: SearchResult[] = []
    for (const file of listing.files) {
      const lines = this.files[file.path].split('\n')
      for (const [i, line] of lines.entries()) {
        if (!line.toLowerCase().includes(query.toLowerCase())) continue
        if (results.length >= maxResults) return { results, complete: false, stopReason: 'results' as const }
        results.push({ path: file.path, lineNumber: i + 1, lineContent: line, context: buildSearchContext(lines, i) })
      }
    }
    return { results, complete: listing.complete, stopReason: listing.stopReason }
  }
}
