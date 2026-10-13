import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionRepository } from '@/lib/session/runtime'
import { parseRequestBody, validationError } from '@/lib/api/helpers'
import { validateLocalRepoPath } from '@/lib/code/path-policy'
import { withOperator } from '@/lib/api/operator-handler'
import { getRepositorySnapshotStore } from '@/lib/repo/snapshot-store'
import { resolveCodeSource } from '@/lib/code'
import { processNextProfile } from '@/lib/repo/profile-worker'
import { repositoryCommitSha } from '@/lib/repo/profile'

const schema = z
  .object({
    repoUrl: z.string().url().optional(),
    repoLocalPath: z.string().optional(),
  })
  .refine(data => Boolean(data.repoUrl) !== Boolean(data.repoLocalPath), {
    message: 'Exactly one of repoUrl or repoLocalPath is required',
  })

export const POST = withOperator(async function POST(request: NextRequest) {
  const body = await parseRequestBody(request)
  if (body === null) return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })

  const result = schema.safeParse(body)
  if (!result.success) return validationError(result.error.issues)
  const { repoUrl, repoLocalPath } = result.data

  if (repoLocalPath) {
    const localPath = validateLocalRepoPath(repoLocalPath)
    if (!localPath.ok) return NextResponse.json({ error: localPath.error }, { status: 400 })
  }

  let commitSha: string
  try {
    commitSha = await repositoryCommitSha(resolveCodeSource({ id: 'pending', repoUrl, repoLocalPath }), request.signal)
  } catch {
    return NextResponse.json(
      { error: 'Cannot pin repository. Check its URL, Git commit, and access credentials.' },
      { status: 400 }
    )
  }
  const repository = getSessionRepository()
  const session = await repository.createSession({ repoUrl, repoLocalPath, repositorySha: commitSha })
  const snapshots = getRepositorySnapshotStore()
  await snapshots.ensureForSession(session, commitSha)
  if (!process.env.DATABASE_URL)
    void processNextProfile(snapshots, repository).catch(error => console.error('[profile] persistence failed', error))

  return NextResponse.json({ session }, { status: 201 })
})

export const GET = withOperator(async (request: NextRequest) => {
  const before = request.nextUrl.searchParams.get('before') ?? undefined
  if (before && !/^.{1,150}$/.test(before))
    return NextResponse.json({ error: 'Invalid history cursor.' }, { status: 400 })
  const sessions = await getSessionRepository().listSessions(before)
  const last = sessions.at(-1)
  return NextResponse.json(
    {
      sessions: sessions.map(({ id, repoUrl, repoLocalPath, buildStatus, createdAt, updatedAt }) => ({
        id,
        repoUrl,
        repoLocalPath,
        buildStatus,
        createdAt,
        updatedAt,
      })),
      next: sessions.length === 20 && last ? `${last.createdAt}|${last.id}` : null,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
})
