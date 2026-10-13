import type { CodeSource, CodeOptions } from './types'
import type { ScopePlan } from '@/lib/session/types'
import { assertReadable, repositoryPath } from './scope'

/** Restricts work before the adapter enumerates files or searches content. */
export class ScopedCodeSource implements CodeSource {
  constructor(
    private readonly source: CodeSource,
    private readonly plan: ScopePlan
  ) {
    for (const root of [...plan.includedRoots, ...plan.excludedRoots]) repositoryPath(root)
  }
  getCommitSha(signal?: AbortSignal) {
    return this.source.getCommitSha(signal)
  }
  listFiles(path?: string, options?: CodeOptions) {
    return this.source.listFiles(path, { ...options, scope: this.plan })
  }
  async readFile(path: string, startLine?: number, endLine?: number, options?: CodeOptions) {
    assertReadable(path, this.plan)
    return this.source.readFile(path, startLine, endLine, { ...options, scope: this.plan })
  }
  searchCode(query: string, maxResults?: number, options?: CodeOptions) {
    return this.source.searchCode(query, maxResults, { ...options, scope: this.plan })
  }
}
