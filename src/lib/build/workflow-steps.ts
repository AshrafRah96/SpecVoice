import type { Session } from '@/lib/session/types'
import { cloneRepo, cleanupTmpDir } from '@/lib/build/clone'
import { writeBuildFiles } from '@/lib/build/executor'
import { createDraftPR } from '@/lib/build/github-pr'

export interface CreatePRInput {
  repoUrl: string
  branchName: string
  sessionId: string
  specOutput: string
  firstDecisionSummary?: string
}

export interface WorkflowSteps {
  clone(repoUrl: string): Promise<string>
  writeFiles(dir: string, session: Session): void
  createPR(input: CreatePRInput): Promise<string>
  cleanup(dir: string): void
}

export class RealWorkflowSteps implements WorkflowSteps {
  constructor(private readonly token?: string) {}

  clone(repoUrl: string): Promise<string> {
    return cloneRepo(repoUrl, this.token)
  }

  writeFiles(dir: string, session: Session): void {
    writeBuildFiles(dir, session)
  }

  createPR(input: CreatePRInput): Promise<string> {
    return createDraftPR({ ...input, token: this.token })
  }

  cleanup(dir: string): void {
    cleanupTmpDir(dir)
  }
}

export class StubWorkflowSteps implements WorkflowSteps {
  public clonedRepoUrl: string | null = null
  public writtenDir: string | null = null
  public cleanedDir: string | null = null
  public prInput: CreatePRInput | null = null
  public readonly prUrl: string

  private readonly prError?: Error

  constructor(opts: { prUrl?: string; prError?: Error } = {}) {
    this.prUrl = opts.prUrl ?? 'https://github.com/owner/repo/pull/1'
    this.prError = opts.prError
  }

  async clone(repoUrl: string): Promise<string> {
    this.clonedRepoUrl = repoUrl
    return '/tmp/stub-clone'
  }

  writeFiles(dir: string, _session: Session): void {
    this.writtenDir = dir
  }

  async createPR(input: CreatePRInput): Promise<string> {
    if (this.prError) throw this.prError
    this.prInput = input
    return this.prUrl
  }

  cleanup(dir: string): void {
    this.cleanedDir = dir
  }
}
