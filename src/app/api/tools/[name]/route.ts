import { NextRequest } from 'next/server'
import { toolRegistry } from '@/lib/api/tool-registry'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params
  return toolRegistry.dispatch(name, req)
}
