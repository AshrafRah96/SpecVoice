export interface FileInfo {
  path: string
  type: 'file' | 'dir'
  size?: number
}

export interface FileContent {
  path: string
  content: string
  lineCount: number
  truncated: boolean
}

export interface SearchResult {
  path: string
  lineNumber: number
  lineContent: string
  context: string[]
}

export interface CodeSource {
  listFiles(path?: string): Promise<FileInfo[]>
  readFile(path: string, startLine?: number, endLine?: number): Promise<FileContent>
  searchCode(query: string, maxResults?: number): Promise<SearchResult[]>
}
