import type { AttemptExecution } from './attempt'
import { sessionStore } from '@/lib/session/store'
import type { SessionRepository } from '@/lib/session/repository'
import { ProcessRunner } from '@/lib/build/process-runner'
import { UnconfiguredProcessRunner } from './isolated-runner'
import { buildBranchName, checkPrerequisites } from '@/lib/build/executor'
import { RealWorkflowSteps, WorkflowSteps } from '@/lib/build/workflow-steps'
import { validateBuild, type PrereqCheck } from '@/lib/build/validate'

export class BuildPipeline {
  constructor(
    private readonly runner: ProcessRunner = new UnconfiguredProcessRunner(),
    private readonly prereqs: PrereqCheck = checkPrerequisites,
    private readonly steps: WorkflowSteps = new RealWorkflowSteps(process.env.GITHUB_TOKEN),
    private readonly store: SessionRepository = sessionStore
  ) {}

  async reconcile(
    sessionId: string,
    execution: AttemptExecution
  ): Promise<'complete' | 'failed' | 'needs_reconciliation'> {
    const session = execution.input
    if (!execution.commitSha || !session.repoUrl || !session.specOutput) {
      await this.store.failBuild(
        sessionId,
        'Generation was interrupted. Start a new Build explicitly; it will consume model quota.'
      )
      return 'failed'
    }
    try {
      await execution.assertOwnership()
      const remote = await this.steps.remoteCommit(session.repoUrl, execution.branchName, execution.signal)
      if (remote === undefined) {
        await this.store.failBuild(sessionId, 'No published branch exists. Start a new Build explicitly.')
        return 'failed'
      }
      if (remote !== execution.commitSha) {
        await this.store.failBuild(
          sessionId,
          'Published branch differs from the recorded commit. Human review is required.'
        )
        return 'failed'
      }
      await execution.assertOwnership()
      const prUrl = await this.steps.createPR({
        repoUrl: session.repoUrl,
        branchName: execution.branchName,
        sessionId,
        specOutput: session.specOutput,
        firstDecisionSummary: session.decisions[0]?.summary,
        signal: execution.signal,
      })
      await this.store.completeBuild(sessionId, prUrl)
      return 'complete'
    } catch {
      return 'needs_reconciliation'
    }
  }

  async run(
    sessionId: string,
    execution?: AttemptExecution
  ): Promise<'complete' | 'failed' | 'blocked' | 'missing' | 'needs_reconciliation'> {
    const session = execution?.input ?? (await this.store.getSession(sessionId))
    if (!session) {
      console.warn(`[BuildPipeline] session ${sessionId} not found — skipping`)
      return 'missing'
    }

    const validation = validateBuild(session, this.prereqs)

    if (validation.type === 'failed') {
      await this.store.failBuild(sessionId, validation.error)
      return 'failed'
    }

    await this.store.setComplexityAssessment(sessionId, validation.assessment)

    if (validation.type === 'blocked') {
      await this.store.blockBuild(sessionId, validation.assessment)
      return 'blocked'
    }

    let tmpDir: string | undefined

    try {
      await this.store.emitBuildProgress(sessionId, 'cloning', `Cloning ${validation.repoUrl}`)
      tmpDir = await this.steps.clone(validation.repoUrl, session.repositorySha, session.scopePlan, execution?.signal)

      const branchName = execution?.branchName ?? buildBranchName(session)
      this.steps.writeFiles(tmpDir, session)

      const commitMessage = session.decisions[0]?.summary ?? `SpecVoice implementation (${sessionId.slice(0, 8)})`

      await execution?.checkpoint('generating')
      await this.runner.run({
        dir: tmpDir,
        branchName,
        commitMessage,
        signal: execution?.signal,
        onProgress: async (phase, detail) => {
          await this.store.emitBuildProgress(sessionId, phase, detail)
        },
      })

      const commit = await this.steps.commitSha(tmpDir, execution?.signal)
      await this.steps.validateChanges(tmpDir, session, execution?.signal, commit)
      await execution?.checkpoint('push_pending', commit)
      await execution?.assertOwnership()
      await this.steps.push(tmpDir, branchName, commit, execution?.signal)
      await execution?.checkpoint('pushed')
      await this.store.emitBuildProgress(sessionId, 'pr', 'Opening draft PR')
      const prUrl = await this.steps.createPR({
        repoUrl: validation.repoUrl,
        branchName,
        sessionId,
        specOutput: session.specOutput!,
        firstDecisionSummary: session.decisions[0]?.summary,
        signal: execution?.signal,
      })

      await this.store.completeBuild(sessionId, prUrl)
      return 'complete'
    } catch (err) {
      if (execution && ['push_pending', 'pushed'].includes(execution.phase)) return 'needs_reconciliation'
      console.error('[BuildPipeline] build failed for session', sessionId, err)
      if (await this.store.getSession(sessionId)) {
        await this.store.failBuild(sessionId, err instanceof Error ? err.message : String(err))
      }
      return 'failed'
    } finally {
      if (tmpDir) this.steps.cleanup(tmpDir)
    }
  }
}
