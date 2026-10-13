import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from '@/lib/session/types'
import type { ProcessRunner, RunOpts } from './process-runner'
import { executionFiles, applyExecutionPatch } from './publication'

const progressDetails = {
  analyzing: 'Reading repository files',
  writing: 'Applying approved changes',
  reviewing: 'Running repository checks',
}
const executionFailure = 'Isolated execution failed. Check the model budget, tool permissions and execution limits.'
const safeExecutionErrors = new Set([
  'Unsupported repository: root package.json and package-lock.json are required',
  'Unsupported repository: package.json is not valid JSON',
  'Unsupported repository: package.json must define a nonempty scripts.test',
  'npm ci timed out',
  'npm test timed out',
])

function executionError(error: unknown): string {
  if (typeof error !== 'string') return executionFailure
  if (safeExecutionErrors.has(error)) return error
  const failed = /^npm (ci|test) failed with exit code ([1-9]\d{0,2})$/.exec(error)
  if (failed && Number(failed[2]) <= 255) return `npm ${failed[1]} failed with exit code ${Number(failed[2])}`
  if (/^Claude Code timed out after \d+ms$/.test(error)) return 'Claude Code execution timed out.'
  return executionFailure
}

export class IsolatedProcessRunner implements ProcessRunner {
  constructor(
    private readonly attemptId: string,
    private readonly leaseToken: string,
    private readonly session: Session
  ) {}

  async run(opts: RunOpts): Promise<void> {
    const secret = process.env.SPECVOICE_SERVICE_SECRET
    if (!secret || secret.length < 32) throw new Error('Configure the isolated execution services before building')
    const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }
    const gateway = process.env.SPECVOICE_MODEL_GATEWAY_URL ?? 'http://model-gateway:3201'
    const launcher = process.env.SPECVOICE_EXECUTION_LAUNCHER_URL ?? 'http://execution-launcher:3202'
    const files = await executionFiles(opts.dir, this.session.scopePlan, opts.signal)
    const spec = await readFile(join(opts.dir, 'SPEC.md'), 'utf8')
    const context = await readFile(join(opts.dir, 'CONTEXT.md'), 'utf8')
    const controller = new AbortController()
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal
    const identity = JSON.stringify({ attemptId: this.attemptId, leaseToken: this.leaseToken })
    let patch: string | undefined
    let issued = false
    try {
      const credential = await fetch(`${gateway}/control/attempts`, {
        method: 'POST',
        headers,
        body: identity,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      })
      if (!credential.ok)
        throw new Error(
          'Cannot issue a fresh model budget for this attempt. Check gateway configuration; start a new Build after repair.'
        )
      issued = true
      const { token } = (await credential.json()) as { token: string }
      const result = await fetch(`${launcher}/attempts`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          attemptId: this.attemptId,
          token,
          repoUrl: this.session.repoUrl,
          files,
          spec,
          context,
          branchName: opts.branchName,
        }),
      })
      if (!result.ok || !result.body)
        throw new Error('Execution launcher rejected this attempt. Check its readiness and resource limits.')
      const reader = result.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > 64 * 1024 * 1024) throw new Error('Execution result exceeds the publication limit')
          pending += decoder.decode(value, { stream: true })
          let newline: number
          while ((newline = pending.indexOf('\n')) !== -1) {
            let event
            try {
              event = JSON.parse(pending.slice(0, newline))
            } catch {
              throw new Error(executionFailure)
            }
            pending = pending.slice(newline + 1)
            if (!event || typeof event !== 'object') throw new Error(executionFailure)
            if (
              event.type === 'progress' &&
              typeof event.phase === 'string' &&
              Object.hasOwn(progressDetails, event.phase) &&
              typeof event.detail === 'string'
            ) {
              const phase = event.phase as keyof typeof progressDetails
              await opts.onProgress(phase, progressDetails[phase])
            } else if (
              event.type === 'result' &&
              typeof event.patch === 'string' &&
              patch === undefined &&
              event.verification?.exitCode === 0
            )
              patch = event.patch
            else throw new Error(executionError(event.type === 'error' ? event.error : undefined))
          }
        }
        if (pending.trim() || patch === undefined)
          throw new Error('Execution ended without a verified patch. Start a new Build explicitly.')
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    } finally {
      controller.abort()
      if (issued) {
        const cleanup = await Promise.allSettled([
          fetch(`${launcher}/attempts/${this.attemptId}`, {
            method: 'DELETE',
            headers,
            signal: AbortSignal.timeout(35000),
          }),
          fetch(`${gateway}/control/attempts`, {
            method: 'DELETE',
            headers,
            body: identity,
            signal: AbortSignal.timeout(10000),
          }),
        ])
        if (cleanup.some(result => result.status === 'rejected' || !result.value.ok))
          throw new Error('Execution cleanup is not confirmed. Publication refused.')
      }
    }
    opts.signal?.throwIfAborted()
    await applyExecutionPatch(opts.dir, patch!, this.session, opts.commitMessage, opts.signal)
  }
}

export class UnconfiguredProcessRunner implements ProcessRunner {
  async run(): Promise<void> {
    throw new Error(
      'Builds require PostgreSQL and the isolated Docker execution services. Start the local Compose stack.'
    )
  }
}
