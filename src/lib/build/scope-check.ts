import type { Session } from '@/lib/session/types'
import { allowedPath } from '@/lib/code/scope'
import { runGit } from './clone'

/** Sparse checkout saves work; this check controls what the worker may publish. */
export async function validateChangedPaths(dir: string, session: Session, signal?: AbortSignal, commit = 'HEAD') {
  if (!session.repositorySha) throw new Error('Build publication requires a pinned Repository Snapshot')
  if (session.scopePlan && session.scopePlan.status !== 'confirmed')
    throw new Error('Build publication requires a confirmed Scope Plan')
  const plan = session.scopePlan?.status === 'confirmed' ? session.scopePlan : undefined
  if (plan && plan.repositorySha !== session.repositorySha)
    throw new Error('Scope Plan does not match the Repository Snapshot')
  await runGit(['-C', dir, 'merge-base', '--is-ancestor', session.repositorySha, commit], undefined, signal)
  const output = await runGit(
    [
      '-C',
      dir,
      'log',
      '--format=',
      '--name-status',
      '-z',
      '--find-renames',
      '--diff-merges=separate',
      '--root',
      `${session.repositorySha}..${commit}`,
      '--',
    ],
    undefined,
    signal
  )
  const parts = output.split('\0').filter(Boolean)
  while (parts.length) {
    const status = parts.shift()!.trim()
    const paths = parts.splice(0, /^[RC]/.test(status) ? 2 : 1)
    if (!paths.length || paths.some(path => !allowedPath(path, plan) || path === 'SPEC.md' || path === 'CONTEXT.md')) {
      throw new Error(`Build changed paths outside the accepted Scope Plan: ${paths.join(', ')}`)
    }
  }
}
