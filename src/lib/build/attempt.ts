import type { Pool } from 'pg'
import { PostgresBuildQueue, type BuildJob, type AttemptPhase } from '@/lib/jobs/queue'
import { PostgresSessionRepository } from '@/lib/session/postgres-repository'
import { BuildPipeline } from './pipeline'
import type { Session } from '@/lib/session/types'
import { IsolatedProcessRunner } from './isolated-runner'
import { executionDeadlineMs } from '@/execution/limits'

export interface AttemptExecution {
  input: Session
  branchName: string
  phase: AttemptPhase
  commitSha: string | null
  signal: AbortSignal
  checkpoint: (phase: AttemptPhase, commitSha?: string) => Promise<void>
  assertOwnership: () => Promise<void>
}

/** Owns one claimed attempt's lease and recovery policy; never regenerates interrupted work. */
export async function executeBuildAttempt(pool: Pool, job: BuildJob, shutdown?: AbortSignal) {
  const queue = new PostgresBuildQueue(pool)
  const repository = new PostgresSessionRepository(pool, { id: job.id, token: job.leaseToken })
  if (!job.input || !job.branchName) {
    await repository.failBuild(
      job.sessionId,
      'Legacy attempt has no immutable recovery data. Start a new Build explicitly.'
    )
    return
  }
  const controller = new AbortController()
  const deadline = setTimeout(
    () => controller.abort(new Error('Build exceeded its configured total deadline')),
    executionDeadlineMs()
  )
  const stop = () => controller.abort(new Error('Build worker stopping'))
  if (shutdown?.aborted) stop()
  shutdown?.addEventListener('abort', stop, { once: true })
  let renewing = false
  const timer = setInterval(() => {
    if (renewing) return
    renewing = true
    void queue
      .renew(job)
      .catch(error => controller.abort(error))
      .finally(() => {
        renewing = false
      })
  }, 30_000)
  const execution: AttemptExecution = {
    input: job.input,
    branchName: job.branchName,
    phase: job.phase,
    commitSha: job.commitSha,
    signal: controller.signal,
    checkpoint: async (phase, sha) => {
      controller.signal.throwIfAborted()
      await queue.checkpoint(job, phase, sha)
      execution.phase = phase
      execution.commitSha = job.commitSha
    },
    assertOwnership: async () => {
      controller.signal.throwIfAborted()
      await queue.renew(job)
    },
  }
  const recovering = job.phase !== 'queued'
  try {
    const pipeline = new BuildPipeline(
      new IsolatedProcessRunner(job.id, job.leaseToken, job.input),
      undefined,
      undefined,
      repository
    )
    const result =
      job.phase === 'queued'
        ? await pipeline.run(job.sessionId, execution)
        : await pipeline.reconcile(job.sessionId, execution)
    if (result === 'needs_reconciliation')
      await queue.recoverLater(job, 'Publication interrupted; reconciling the recorded branch and commit.', recovering)
  } catch (error) {
    // Lease loss leaves durable checkpoints for the next owner; never force a stale write.
    console.error('[attempt]', job.id, error instanceof Error ? error.message : 'Execution interrupted')
  } finally {
    clearInterval(timer)
    clearTimeout(deadline)
    shutdown?.removeEventListener('abort', stop)
  }
}
