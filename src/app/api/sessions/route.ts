import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { sessionStore } from '@/lib/session/store'
import { parseRequestBody, validationError } from '@/lib/api/helpers'

const schema = z
  .object({
    repoUrl: z.string().url().optional(),
    repoLocalPath: z.string().optional(),
  })
  .refine(data => data.repoUrl || data.repoLocalPath, {
    message: 'Either repoUrl or repoLocalPath is required',
  })

export async function POST(request: NextRequest) {
  const body = await parseRequestBody(request)
  if (body === null) return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })

  const result = schema.safeParse(body)
  if (!result.success) return validationError(result.error.issues)
  const { repoUrl, repoLocalPath } = result.data

  const session = sessionStore.createSession({ repoUrl, repoLocalPath })

  return NextResponse.json({ session }, { status: 201 })
}
