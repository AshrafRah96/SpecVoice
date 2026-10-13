import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionRepository } from '@/lib/session/runtime'
import { sessionNotFound } from '@/lib/api/helpers'
import { withOperator } from '@/lib/api/operator-handler'
import { getRepositorySnapshotStore } from '@/lib/repo/snapshot-store'
import { resolveCodeSource } from '@/lib/code'
import { profileRepository, profileLimits, validateScopeRoots } from '@/lib/repo/profile'

const schema = z.object({
  planId: z.string().optional(),
  confirm: z.boolean().optional(),
  includedRoots: z.array(z.string()).optional(),
  excludedRoots: z.array(z.string()).default([]),
  estimatedFiles: z.number().int().nonnegative().optional(),
  estimatedBytes: z.number().int().nonnegative().optional(),
  dependencyBoundaries: z.array(z.string()).default([]),
  reason: z.string().trim().min(1).optional(),
})

export const POST = withOperator(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const sessions = getSessionRepository()
  const session = await sessions.getSession(id)
  if (!session) return sessionNotFound(id)
  const body = schema.safeParse(await request.json().catch(() => null))
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })

  const snapshots = getRepositorySnapshotStore()
  const snapshot = await snapshots.getForSession(id)
  if (!snapshot?.profile || (snapshot.indexStatus !== 'ready' && snapshot.indexStatus !== 'partial')) {
    return NextResponse.json({ error: 'Repository profile is not ready.' }, { status: 409 })
  }
  if (body.data.confirm) {
    if (!body.data.planId)
      return NextResponse.json({ error: 'planId is required to confirm a scope plan.' }, { status: 400 })
    const proposed = snapshot.scopePlan
    if (!proposed || proposed.id !== body.data.planId || proposed.repositorySha !== session.repositorySha) {
      return NextResponse.json({ error: 'Scope plan is stale or does not belong to this snapshot.' }, { status: 409 })
    }
    const scoped = await profileRepository(
      resolveCodeSource(session),
      proposed.repositorySha,
      profileLimits(),
      new Date(),
      { scope: proposed, signal: request.signal }
    )
    if (!scoped.treeComplete || scoped.fileCount === 0) {
      return NextResponse.json(
        { error: 'Choose a smaller, nonempty scope that can be completely inventoried within the limits.' },
        { status: 409 }
      )
    }
    const plan = await snapshots.confirmScope(id, body.data.planId, {
      estimatedFiles: scoped.fileCount,
      estimatedBytes: scoped.byteCount,
    })
    if (!plan) return NextResponse.json({ error: 'Scope plan not found.' }, { status: 404 })
    await sessions.updateSession(id, { scopePlan: plan })
    return NextResponse.json({ scopePlan: plan })
  }

  const includedRoots = body.data.includedRoots ?? []
  if (!validateScopeRoots([...includedRoots, ...body.data.excludedRoots])) {
    return NextResponse.json({ error: 'Scope roots must be repository-relative paths.' }, { status: 400 })
  }
  if ((snapshot.profile.tier !== 'small' || !snapshot.profile.treeComplete) && includedRoots.length === 0) {
    return NextResponse.json(
      { error: 'A bounded repository scope is required for this repository tier.' },
      { status: 400 }
    )
  }
  const plan = await snapshots.proposeScope(id, {
    repositorySha: snapshot.profile.repositorySha,
    includedRoots,
    excludedRoots: body.data.excludedRoots,
    estimatedFiles: snapshot.profile.fileCount,
    estimatedBytes: snapshot.profile.byteCount,
    dependencyBoundaries: body.data.dependencyBoundaries,
    reason: body.data.reason ?? 'User-confirmed repository scope',
  })
  await sessions.updateSession(id, { scopePlan: plan })
  return NextResponse.json({ scopePlan: plan }, { status: 201 })
})
