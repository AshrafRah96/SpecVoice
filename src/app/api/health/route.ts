import { NextResponse } from 'next/server'
import { runtimePool } from '@/lib/db/postgres'
import { workerReady } from '@/lib/jobs/health'

export async function GET() {
  try {
    const ready = process.env.DATABASE_URL ? await workerReady(runtimePool()) : process.env.NODE_ENV !== 'production'
    return NextResponse.json({ ready }, { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ ready: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
