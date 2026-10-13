import type { ScopePlan } from '@/lib/session/types'

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
export type StopReason = 'files' | 'bytes' | 'time' | 'provider' | 'results'
export interface Completeness {
  complete: boolean
  stopReason?: StopReason
}
export interface FileListing extends Completeness {
  files: FileInfo[]
}
export interface SearchListing extends Completeness {
  results: SearchResult[]
}
export interface CodeOptions {
  scope?: Pick<ScopePlan, 'includedRoots' | 'excludedRoots'>
  limits?: { maxFiles: number; maxBytes: number; maxDurationMs: number }
  signal?: AbortSignal
}
export interface CodeSource {
  getCommitSha(signal?: AbortSignal): Promise<string>
  listFiles(path?: string, options?: CodeOptions): Promise<FileListing>
  readFile(path: string, startLine?: number, endLine?: number, options?: CodeOptions): Promise<FileContent>
  searchCode(query: string, maxResults?: number, options?: CodeOptions): Promise<SearchListing>
}
