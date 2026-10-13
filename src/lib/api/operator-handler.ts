import type { NextRequest } from 'next/server'
import { requireOperator } from '@/lib/security/operator'
import { withSessionStorage } from '@/lib/session/deployment'

export function withOperator<A extends unknown[]>(handler: (request: NextRequest, ...args: A) => Promise<Response>) {
  return withSessionStorage(async (request: NextRequest, ...args: A) => {
    const denied = await requireOperator(request)
    return denied ?? handler(request, ...args)
  })
}
