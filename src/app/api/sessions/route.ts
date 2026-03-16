import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { sessionStore } from '@/lib/session/store'
import { parseRequestBody, validationError } from '@/lib/api/helpers'

const schema = z
  .object({
    repo_url: z.string().url().optional(),
    repo_local_path: z.string().optional(),
  })
  .refine(data => data.repo_url || data.repo_local_path, {
    message: 'Either repo_url or repo_local_path is required',
  })

export async function POST(request: NextRequest) {
  const body = await parseRequestBody(request)
  if (body === null) return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })

  const result = schema.safeParse(body)
  if (!result.success) return validationError(result.error.issues)
  const { repo_url, repo_local_path } = result.data

  const session = sessionStore.createSession({
    repoUrl: repo_url,
    repoLocalPath: repo_local_path,
  })

  return NextResponse.json({ session }, { status: 201 })
}
