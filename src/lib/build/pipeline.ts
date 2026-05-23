import { sessionStore } from '@/lib/session/store'
import { ClaudeProcessRunner, ProcessRunner } from '@/lib/build/process-runner'
import { buildBranchName, checkPrerequisites } from '@/lib/build/executor'
import { RealWorkflowSteps, WorkflowSteps } from '@/lib/build/workflow-steps'
import { validateBuild, type PrereqCheck } from '@/lib/build/validate'

export class BuildPipeline {
  constructor(
    private readonly runner: ProcessRunner = new ClaudeProcessRunner(),
    private readonly prereqs: PrereqCheck = checkPrerequisites,
    private readonly steps: WorkflowSteps = new RealWorkflowSteps(process.env.GITHUB_TOKEN)
  ) {}

  async run(sessionId: string): Promise<void> {
    const session = sessionStore.getSession(sessionId)
    if (!session) {
      console.warn(`[BuildPipeline] session ${sessionId} not found — skipping`)
      return
    }

    const validation = validateBuild(session, this.prereqs)
    sessionStore.setComplexityAssessment(sessionId, validation.assessment)

    if (validation.type === 'blocked') {
      sessionStore.blockBuild(sessionId, validation.assessment)
      return
    }

    if (validation.type === 'failed') {
      sessionStore.failBuild(sessionId, validation.error)
      return
    }

    let tmpDir: string | undefined

    try {
      sessionStore.emitBuildProgress(sessionId, 'cloning', `Cloning ${validation.repoUrl}`)
      tmpDir = await this.steps.clone(validation.repoUrl)

      const branchName = buildBranchName(session)
      this.steps.writeFiles(tmpDir, session)

      const commitMessage =
        session.decisions[0]?.summary ?? `SpecVoice implementation (${sessionId.slice(0, 8)})`

      await this.runner.run({
        dir: tmpDir,
        branchName,
        commitMessage,
        onProgress: (phase, detail) => sessionStore.emitBuildProgress(sessionId, phase, detail),
      })

      sessionStore.emitBuildProgress(sessionId, 'pr', 'Opening draft PR')
      const prUrl = await this.steps.createPR({
        repoUrl: validation.repoUrl,
        branchName,
        sessionId,
        specOutput: session.specOutput!,
        firstDecisionSummary: session.decisions[0]?.summary,
      })

      sessionStore.completeBuild(sessionId, prUrl)
    } catch (err) {
      console.error('[BuildPipeline] build failed for session', sessionId, err)
      if (sessionStore.getSession(sessionId)) {
        sessionStore.failBuild(sessionId, err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (tmpDir) this.steps.cleanup(tmpDir)
    }
  }
}
