import { existsSync, statSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import path from 'path'
import { createIgnoreFilter, loadGitignoreRules } from '@/lib/code/ignore-rules'
import { MAX_FILE_CHARS, isBinary, formatNumberedLines, buildSearchContext } from '@/lib/code/utils'
import type { CodeSource, FileInfo, FileContent, SearchResult } from '@/lib/code/types'

export class LocalCodeSource implements CodeSource {
  private rootPath: string
  private ig: ReturnType<typeof createIgnoreFilter>

  constructor(rootPath: string) {
    const resolved = path.resolve(rootPath)
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error(
        `Local repo path is not a directory: ${rootPath}. ` +
          'Check that the path exists and is accessible.'
      )
    }
    this.rootPath = resolved
    const gitignoreRules = loadGitignoreRules(resolved)
    this.ig = createIgnoreFilter(gitignoreRules)
  }

  async listFiles(dirPath?: string): Promise<FileInfo[]> {
    const entries = await readdir(this.rootPath, { recursive: true, withFileTypes: true })

    const results: FileInfo[] = []
    for (const entry of entries) {
      // Build relative path with forward slashes
      const rel = path
        .join(entry.parentPath ?? entry.path, entry.name)
        .slice(this.rootPath.length + 1)
        .replace(/\\/g, '/')

      if (this.ig.ignores(rel)) continue

      if (dirPath) {
        const prefix = dirPath.replace(/\\/g, '/').replace(/\/$/, '')
        if (!rel.startsWith(prefix + '/') && rel !== prefix) continue
      }

      results.push({
        path: rel,
        type: entry.isDirectory() ? 'dir' : 'file',
      })
    }

    // Dirs first, then files; alphabetical within each group
    results.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.path.localeCompare(b.path)
    })

    return results
  }

  async readFile(filePath: string, startLine?: number, endLine?: number): Promise<FileContent> {
    const fullPath = path.join(this.rootPath, filePath)

    let rawBuffer: Buffer
    try {
      rawBuffer = await readFile(fullPath)
    } catch {
      throw new Error(`File not found: ${filePath}`)
    }

    if (isBinary(rawBuffer)) {
      throw new Error(`File appears to be binary and cannot be read as text: ${filePath}`)
    }

    const rawContent = rawBuffer.toString('utf-8')
    let lines = rawContent.split('\n')
    const totalLines = lines.length

    // Apply line range (1-indexed, inclusive)
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
    const files = await this.listFiles()
    const fileOnlyPaths = files.filter(f => f.type === 'file').map(f => f.path)

    const results: SearchResult[] = []
    const lowerQuery = query.toLowerCase()

    for (const filePath of fileOnlyPaths) {
      if (results.length >= maxResults) break

      let rawBuffer: Buffer
      try {
        rawBuffer = await readFile(path.join(this.rootPath, filePath))
      } catch {
        continue
      }

      if (isBinary(rawBuffer)) continue

      const lines = rawBuffer.toString('utf-8').split('\n')

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
