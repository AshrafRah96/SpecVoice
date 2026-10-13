import { NextRequest, NextResponse } from 'next/server'
import { getSessionRepository } from '@/lib/session/runtime'
import { sessionNotFound } from '@/lib/api/helpers'
import { withOperator } from '@/lib/api/operator-handler'
import { getRepositorySnapshotStore } from '@/lib/repo/snapshot-store'
import { processNextProfile } from '@/lib/repo/profile-worker'
import { resolveCodeSource } from '@/lib/code'
import { repositoryCommitSha } from '@/lib/repo/profile'

export const GET = withOperator(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await getSessionRepository().getSession(id)
  if (!session) return sessionNotFound(id)
  const snapshot = await getRepositorySnapshotStore().getForSession(id)
  return NextResponse.json({ snapshot: snapshot ?? null })
})

export const POST = withOperator(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const sessions = getSessionRepository()
  const session = await sessions.getSession(id)
  if (!session) return sessionNotFound(id)
  const snapshots = getRepositorySnapshotStore()
  let pinnedSession = session
  if (!session.repositorySha) {
    const commitSha = await repositoryCommitSha(resolveCodeSource(session), request.signal)
    pinnedSession = await sessions.updateSession(session.id, { repositorySha: commitSha })
  }
  await snapshots.ensureForSession(pinnedSession, pinnedSession.repositorySha ?? undefined)
  await snapshots.retryProfile(id)
  const snapshot = (await snapshots.getForSession(id))!
  if (snapshot.indexStatus === 'pending' && !process.env.DATABASE_URL) {
    void processNextProfile(snapshots, sessions).catch(error => console.error('[profile] persistence failed', error))
  }
  return NextResponse.json({ accepted: true, snapshotId: snapshot.id, status: snapshot.indexStatus }, { status: 202 })
})
