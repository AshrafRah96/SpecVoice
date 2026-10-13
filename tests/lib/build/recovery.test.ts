import { describe, expect, it, vi } from 'vitest'
import type { AttemptExecution } from '@/lib/build/attempt'
import { BuildPipeline } from '@/lib/build/pipeline'
import { FakeProcessRunner } from '@/lib/build/process-runner'
import { StubWorkflowSteps, type WorkflowSteps } from '@/lib/build/workflow-steps'
import { SessionStore } from '@/lib/session/store'

function setup() {
  const store = new SessionStore()
  const session = store.createSession({
    repoUrl: 'https://github.com/owner/repo',
    repositorySha: 'a'.repeat(40),
    specOutput: '# Spec\n\nImplement the requested change.',
    buildStatus: 'building',
  })
  const runner = new FakeProcessRunner()
  const run = vi.spyOn(runner, 'run')
  const steps = new StubWorkflowSteps()
  const execution: AttemptExecution = {
    input: structuredClone(session),
    branchName: 'spec-voice/change-attempt-42',
    phase: 'queued',
    commitSha: null,
    signal: new AbortController().signal,
    checkpoint: vi.fn(async (phase, commitSha) => {
      execution.phase = phase
      if (commitSha) execution.commitSha = commitSha
    }),
    assertOwnership: vi.fn(async () => {}),
  }
  const pipeline = new BuildPipeline(runner, () => ({ ok: true }), steps, store)
  return { store, session, run, steps, execution, pipeline }
}

describe('Build Attempt recovery', () => {
  it('fails interrupted generation without running the model or inspecting remote branches', async () => {
    const { store, session, run, steps, execution, pipeline } = setup()
    execution.phase = 'generating'
    const remote = vi.spyOn(steps, 'remoteCommit')
    const pr = vi.spyOn(steps, 'createPR')

    expect(await pipeline.reconcile(session.id, execution)).toBe('failed')
    expect(store.getSession(session.id)!.buildStatus).toBe('failed')
    expect(run).not.toHaveBeenCalled()
    expect(remote).not.toHaveBeenCalled()
    expect(pr).not.toHaveBeenCalled()
    expect(
      store
        .readEvents(session.id, '0')
        .some(({ event }) => event.type === 'build_failed' && event.error.includes('Start a new Build explicitly'))
    ).toBe(true)
  })

  it('keeps the generated commit and branch when push fails', async () => {
    const { store, session, run, steps, execution, pipeline } = setup()
    const push = vi.spyOn(steps, 'push').mockRejectedValue(new Error('connection dropped'))
    const pr = vi.spyOn(steps, 'createPR')

    expect(await pipeline.run(session.id, execution)).toBe('needs_reconciliation')
    expect(execution.phase).toBe('push_pending')
    expect(execution.commitSha).toBe('generated-commit')
    expect(push).toHaveBeenCalledWith('/tmp/stub-clone', execution.branchName, 'generated-commit', execution.signal)
    expect(run).toHaveBeenCalledTimes(1)
    expect(pr).not.toHaveBeenCalled()
    expect(store.getSession(session.id)!.buildStatus).toBe('building')
    expect(steps.cleanedDir).toBe('/tmp/stub-clone')
  })

  it('recovers a pushed branch after PR creation fails without generating or pushing again', async () => {
    const { store, session, run, steps, execution, pipeline } = setup()
    const push = vi.spyOn(steps, 'push')
    const remote = vi.spyOn(steps, 'remoteCommit')
    const pr = vi.spyOn(steps, 'createPR').mockRejectedValueOnce(new Error('GitHub unavailable'))

    expect(await pipeline.run(session.id, execution)).toBe('needs_reconciliation')
    expect(execution.phase).toBe('pushed')
    expect(execution.commitSha).toBe('generated-commit')
    expect(steps.cleanedDir).toBe('/tmp/stub-clone')
    expect(await pipeline.reconcile(session.id, execution)).toBe('complete')
    expect(remote).toHaveBeenCalledWith(session.repoUrl, execution.branchName, execution.signal)
    expect(run).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledTimes(1)
    expect(pr).toHaveBeenCalledTimes(2)
    expect(store.getSession(session.id)!.prUrl).toBe(steps.prUrl)
  })

  it.each([undefined, 'unexpected-commit'])('rejects a missing or different remote commit (%s)', async remoteCommit => {
    const { store, session, run, steps, execution, pipeline } = setup()
    execution.phase = 'push_pending'
    execution.commitSha = 'generated-commit'
    const workflow: WorkflowSteps = steps
    vi.spyOn(workflow, 'remoteCommit').mockResolvedValue(remoteCommit)
    const pr = vi.spyOn(steps, 'createPR')

    expect(await pipeline.reconcile(session.id, execution)).toBe('failed')
    expect(store.getSession(session.id)!.buildStatus).toBe('failed')
    expect(pr).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('reconciles a matching commit once without cloning, generating, or pushing', async () => {
    const { session, run, steps, execution, pipeline } = setup()
    execution.phase = 'pushed'
    execution.commitSha = 'generated-commit'
    const clone = vi.spyOn(steps, 'clone')
    const push = vi.spyOn(steps, 'push')
    const pr = vi.spyOn(steps, 'createPR')

    expect(await pipeline.reconcile(session.id, execution)).toBe('complete')
    expect(pr).toHaveBeenCalledTimes(1)
    expect(pr).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: execution.branchName,
        sessionId: session.id,
        specOutput: execution.input.specOutput,
        signal: execution.signal,
      })
    )
    expect(clone).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('cannot publish after losing attempt ownership', async () => {
    const { session, steps, execution, pipeline } = setup()
    vi.mocked(execution.assertOwnership).mockRejectedValue(new Error('Build attempt lease lost'))
    const push = vi.spyOn(steps, 'push')
    const pr = vi.spyOn(steps, 'createPR')

    expect(await pipeline.run(session.id, execution)).toBe('needs_reconciliation')
    expect(execution.commitSha).toBe('generated-commit')
    expect(push).not.toHaveBeenCalled()
    expect(pr).not.toHaveBeenCalled()
    expect(steps.cleanedDir).toBe('/tmp/stub-clone')
  })

  it('uses immutable attempt inputs when the Session changes during recovery', async () => {
    const { store, session, steps, execution, pipeline } = setup()
    execution.phase = 'pushed'
    execution.commitSha = 'generated-commit'
    store.updateSession(session.id, { repoUrl: 'https://github.com/other/repository', specOutput: '# Different spec' })
    const remote = vi.spyOn(steps, 'remoteCommit')
    const pr = vi.spyOn(steps, 'createPR')

    expect(await pipeline.reconcile(session.id, execution)).toBe('complete')
    expect(remote).toHaveBeenCalledWith(execution.input.repoUrl, execution.branchName, execution.signal)
    expect(pr).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: execution.input.repoUrl,
        specOutput: execution.input.specOutput,
      })
    )
  })
})
