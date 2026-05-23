import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sessionStore } from '@/lib/session/store'
import { BuildPipeline } from '@/lib/build/pipeline'
import { FakeProcessRunner } from '@/lib/build/process-runner'
import { StubWorkflowSteps } from '@/lib/build/workflow-steps'
import type { SessionEvent } from '@/lib/session/types'

const passingPrereqs = () => ({ ok: true as const })
const failingPrereqs = (msg: string) => () => ({ ok: false as const, error: msg })

function makeSession(overrides: Record<string, unknown> = {}) {
  return sessionStore.createSession({
    repoUrl: 'https://github.com/octocat/Hello-World',
    specOutput: '# Spec\n\n- Implement foo',
    buildStatus: 'building',
    ...overrides,
  })
}

function captureEvents(sessionId: string): SessionEvent[] {
  const events: SessionEvent[] = []
  sessionStore.subscribe(sessionId, (e) => events.push(e))
  return events
}

describe('BuildPipeline.run', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('warns and returns silently when session is not found', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pipeline = new BuildPipeline(new FakeProcessRunner(), passingPrereqs, new StubWorkflowSteps())
    await pipeline.run('nonexistent-session')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not found'))
    warnSpy.mockRestore()
  })

  it('blocks when session has open questions: resets to ready, emits build_blocked', async () => {
    const session = makeSession({
      openQuestions: [
        { id: 'q1', question: 'Migrate?', context: 'ctx', timestamp: new Date().toISOString() },
      ],
    })
    const events = captureEvents(session.id)
    const pipeline = new BuildPipeline(new FakeProcessRunner(), passingPrereqs, new StubWorkflowSteps())
    await pipeline.run(session.id)

    expect(sessionStore.getSession(session.id)!.buildStatus).toBe('ready')
    const blocked = events.find(e => e.type === 'build_blocked')
    expect(blocked).toBeDefined()
    expect((blocked as Extract<SessionEvent, { type: 'build_blocked' }>).assessment.blocked).toBe(true)
    expect((blocked as Extract<SessionEvent, { type: 'build_blocked' }>).assessment.blockReason).toBe('open_questions')
  })

  it('sets buildStatus to failed and emits build_failed when prerequisites fail', async () => {
    const session = makeSession()
    const events = captureEvents(session.id)
    const pipeline = new BuildPipeline(new FakeProcessRunner(), failingPrereqs('claude CLI not found'), new StubWorkflowSteps())
    await pipeline.run(session.id)

    expect(sessionStore.getSession(session.id)!.buildStatus).toBe('failed')
    const failEvent = events.find(e => e.type === 'build_failed') as Extract<SessionEvent, { type: 'build_failed' }> | undefined
    expect(failEvent?.error).toContain('claude CLI not found')
  })

  it('sets buildStatus to failed when session has no repoUrl', async () => {
    const session = makeSession({ repoUrl: undefined })
    const events = captureEvents(session.id)
    const pipeline = new BuildPipeline(new FakeProcessRunner(), passingPrereqs, new StubWorkflowSteps())
    await pipeline.run(session.id)

    expect(sessionStore.getSession(session.id)!.buildStatus).toBe('failed')
    const failEvent = events.find(e => e.type === 'build_failed') as Extract<SessionEvent, { type: 'build_failed' }> | undefined
    expect(failEvent?.error).toContain('no repository URL')
  })

  it('completes successfully: buildStatus complete, prUrl set, build_complete emitted', async () => {
    const session = makeSession()
    const events = captureEvents(session.id)
    const pipeline = new BuildPipeline(new FakeProcessRunner(), passingPrereqs, new StubWorkflowSteps())
    await pipeline.run(session.id)

    const updated = sessionStore.getSession(session.id)!
    expect(updated.buildStatus).toBe('complete')
    expect(updated.prUrl).toBe('https://github.com/owner/repo/pull/1')
    expect(events.find(e => e.type === 'build_complete')).toBeDefined()
  })

  it('broadcasts build_progress events from the runner', async () => {
    const session = makeSession()
    const events = captureEvents(session.id)
    const pipeline = new BuildPipeline(new FakeProcessRunner(), passingPrereqs, new StubWorkflowSteps())
    await pipeline.run(session.id)

    const progressEvents = events.filter(e => e.type === 'build_progress')
    // FakeProcessRunner emits 3 phases + cloning + pr = at least 4
    expect(progressEvents.length).toBeGreaterThanOrEqual(4)
  })

  it('sets buildStatus to failed and emits build_failed when runner throws', async () => {
    const session = makeSession()
    const events = captureEvents(session.id)
    const pipeline = new BuildPipeline(
      new FakeProcessRunner({ error: new Error('subprocess crashed') }),
      passingPrereqs,
      new StubWorkflowSteps()
    )
    await pipeline.run(session.id)

    expect(sessionStore.getSession(session.id)!.buildStatus).toBe('failed')
    const failEvent = events.find(e => e.type === 'build_failed') as Extract<SessionEvent, { type: 'build_failed' }> | undefined
    expect(failEvent?.error).toContain('subprocess crashed')
  })

  it('cleans up tmpDir even when runner throws', async () => {
    const steps = new StubWorkflowSteps()
    const session = makeSession()
    const pipeline = new BuildPipeline(
      new FakeProcessRunner({ error: new Error('boom') }),
      passingPrereqs,
      steps
    )
    await pipeline.run(session.id)
    expect(steps.cleanedDir).toBe('/tmp/stub-clone')
  })
})
