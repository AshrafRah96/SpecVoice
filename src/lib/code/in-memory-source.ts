import type { CodeSource, FileContent, FileInfo, SearchResult } from '@/lib/code/types'

export class InMemoryCodeSource implements CodeSource {
  constructor(private readonly files: Record<string, string> = {}) {}

  async listFiles(_path?: string): Promise<FileInfo[]> {
    return Object.keys(this.files).map(path => ({ path, type: 'file' as const }))
  }

  async readFile(path: string): Promise<FileContent> {
    const content = this.files[path] ?? ''
    return { path, content, lineCount: content.split('\n').length, truncated: false }
  }

  async searchCode(query: string, _maxResults?: number): Promise<SearchResult[]> {
    const results: SearchResult[] = []
    for (const [path, content] of Object.entries(this.files)) {
      content.split('\n').forEach((line, i) => {
        if (line.includes(query)) {
          results.push({ path, lineNumber: i + 1, lineContent: line, context: [] })
        }
      })
    }
    return results
  }
}
