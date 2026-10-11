import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { sessionStore } from '@/lib/session/store'
import { parseRequestBody, validationError } from '@/lib/api/helpers'
import { issueSessionCapability } from '@/lib/session/capability'
import { validateLocalRepoPath } from '@/lib/code/path-policy'
import { requireInMemorySessionStore } from '@/lib/session/deployment'

const schema = z
  .object({
    repoUrl: z.string().url().optional(),
    repoLocalPath: z.string().optional(),
  })
  .refine(data => Boolean(data.repoUrl) !== Boolean(data.repoLocalPath), {
    message: 'Exactly one of repoUrl or repoLocalPath is required',
  })

export async function POST(request: NextRequest) {
  const unavailable = requireInMemorySessionStore()
  if (unavailable) return unavailable
  const body = await parseRequestBody(request)
  if (body === null) return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })

  const result = schema.safeParse(body)
  if (!result.success) return validationError(result.error.issues)
  const { repoUrl, repoLocalPath } = result.data

  if (repoLocalPath) {
    const localPath = validateLocalRepoPath(repoLocalPath)
    if (!localPath.ok) return NextResponse.json({ error: localPath.error }, { status: 400 })
  }

  const session = sessionStore.createSession({ repoUrl, repoLocalPath })

  return NextResponse.json({ session, capability: issueSessionCapability(session.id) }, { status: 201 })
}
