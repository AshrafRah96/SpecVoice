import { validateChangedPaths } from './scope-check'
import type { Session, ScopePlan } from '@/lib/session/types'
import { cloneRepo, cleanupTmpDir, pushBranch, runGit } from '@/lib/build/clone'
import { writeBuildFiles } from '@/lib/build/executor'
import { createDraftPR, remoteBranchCommit } from '@/lib/build/github-pr'

export interface CreatePRInput {
  repoUrl: string
  branchName: string
  sessionId: string
  specOutput: string
  firstDecisionSummary?: string
  signal?: AbortSignal
}

export interface WorkflowSteps {
  clone(repoUrl: string, commitSha?: string | null, scopePlan?: ScopePlan | null, signal?: AbortSignal): Promise<string>
  validateChanges(dir: string, session: Session, signal?: AbortSignal, commit?: string): Promise<void>
  writeFiles(dir: string, session: Session): void
  push(dir: string, branchName: string, commit: string, signal?: AbortSignal): Promise<void>
  createPR(input: CreatePRInput): Promise<string>
  commitSha(dir: string, signal?: AbortSignal): Promise<string>
  remoteCommit(repoUrl: string, branchName: string, signal?: AbortSignal): Promise<string | undefined>
  cleanup(dir: string): void
}

export class RealWorkflowSteps implements WorkflowSteps {
  constructor(private readonly token?: string) {}

  clone(
    repoUrl: string,
    commitSha?: string | null,
    scopePlan?: ScopePlan | null,
    signal?: AbortSignal
  ): Promise<string> {
    return cloneRepo(repoUrl, this.token, commitSha ?? undefined, scopePlan ?? undefined, signal)
  }

  validateChanges(dir: string, session: Session, signal?: AbortSignal, commit?: string) {
    return validateChangedPaths(dir, session, signal, commit)
  }

  writeFiles(dir: string, session: Session): void {
    writeBuildFiles(dir, session)
  }

  createPR(input: CreatePRInput): Promise<string> {
    return createDraftPR({ ...input, token: this.token })
  }

  push(dir: string, branchName: string, commit: string, signal?: AbortSignal): Promise<void> {
    return pushBranch(dir, branchName, commit, this.token, signal)
  }

  async commitSha(dir: string, signal?: AbortSignal) {
    return (await runGit(['-C', dir, 'rev-parse', 'HEAD'], undefined, signal)).trim()
  }

  remoteCommit(repoUrl: string, branchName: string, signal?: AbortSignal) {
    return remoteBranchCommit(repoUrl, branchName, this.token, signal)
  }

  cleanup(dir: string): void {
    cleanupTmpDir(dir)
  }
}

export class StubWorkflowSteps implements WorkflowSteps {
  public clonedRepoUrl: string | null = null
  public writtenDir: string | null = null
  public cleanedDir: string | null = null
  public pushed: { dir: string; branchName: string } | null = null
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

  async validateChanges() {}

  writeFiles(dir: string, _session: Session): void {
    this.writtenDir = dir
  }

  async createPR(input: CreatePRInput): Promise<string> {
    if (this.prError) throw this.prError
    this.prInput = input
    return this.prUrl
  }

  async push(dir: string, branchName: string, _commit: string, _signal?: AbortSignal): Promise<void> {
    this.pushed = { dir, branchName }
  }

  async commitSha() {
    return 'generated-commit'
  }
  async remoteCommit() {
    return 'generated-commit'
  }

  cleanup(dir: string): void {
    this.cleanedDir = dir
  }
}
