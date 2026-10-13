import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/sessions/[id]/scope/route'
import { sessionStore } from '@/lib/session/store'
import { operatorHeaders } from '../helpers/operator'
import { InMemoryCodeSource, registerCodeSource } from '@/lib/code'
import { getRepositorySnapshotStore } from '@/lib/repo/snapshot-store'
import { profileRepository } from '@/lib/repo/profile'
import { buildReadiness } from '@/lib/repo/readiness'

const snapshots = getRepositorySnapshotStore()
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  vi.unstubAllEnvs()
})
async function setup(partial = false) {
  const session = sessionStore.createSession({ repositorySha: 'pinned', specOutput: '# Spec', buildStatus: 'ready' })
  const source = new InMemoryCodeSource(
    { 'apps/web/package.json': '{}', 'apps/web/page.ts': 'hello', 'private/x.ts': 'hidden' },
    'pinned'
  )
  dispose = registerCodeSource(session.id, source)
  const snapshot = await snapshots.ensureForSession(session, 'pinned')
  const profile = await profileRepository(source, 'pinned')
  await snapshots.saveProfile(snapshot.id, {
    ...profile,
    treeComplete: !partial,
    indexStatus: partial ? 'partial' : 'ready',
  })
  const post = (body: unknown) =>
    POST(
      new NextRequest(`http://localhost/api/sessions/${session.id}/scope`, {
        method: 'POST',
        headers: { ...operatorHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: session.id }) }
    )
  return { session, snapshot, post }
}
describe('Scope Plan confirmation', () => {
  it('computes counts on the server, preserves nested packages and gates every scope edit', async () => {
    const { session, post } = await setup()
    expect(buildReadiness(await snapshots.getForSession(session.id), 'pinned')).toBeNull()
    const response = await post({ includedRoots: ['apps/web'], estimatedFiles: 0, estimatedBytes: 0 })
    expect(response.status).toBe(201)
    const { scopePlan } = await response.json()
    expect(buildReadiness(await snapshots.getForSession(session.id), 'pinned')).toMatch(/Confirm/)
    const confirmed = await post({ confirm: true, planId: scopePlan.id, estimatedFiles: 999 })
    expect(confirmed.status).toBe(200)
    expect((await confirmed.json()).scopePlan).toMatchObject({
      estimatedFiles: 2,
      estimatedBytes: 7,
      status: 'confirmed',
    })
    expect(buildReadiness(await snapshots.getForSession(session.id), 'pinned')).toBeNull()
    await post({ includedRoots: ['private'] })
    expect((await post({ confirm: true, planId: scopePlan.id })).status).toBe(409)
    expect(buildReadiness(await snapshots.getForSession(session.id), 'pinned')).toMatch(/Confirm/)
  })
  it('requires explicit bounded scope even when a partial count looks small', async () => {
    const { session, post } = await setup(true)
    expect(buildReadiness(await snapshots.getForSession(session.id), 'pinned')).toMatch(/confirmed Scope Plan/)
    expect((await post({ includedRoots: [] })).status).toBe(400)
    const { scopePlan } = await (await post({ includedRoots: ['apps'] })).json()
    vi.stubEnv('SPECVOICE_PROFILE_MAX_FILES', '1')
    expect((await post({ confirm: true, planId: scopePlan.id })).status).toBe(409)
    expect((await snapshots.getForSession(session.id))?.scopePlan?.status).toBe('proposed')
  })
  it.each(['../escape', '/absolute', 'apps/**', './apps', 'apps/[web]', 'apps/../private'])(
    'rejects nonliteral path %s',
    async path => {
      const { post } = await setup()
      expect((await post({ includedRoots: [path] })).status).toBe(400)
    }
  )
  it('refuses empty inventories and mismatched commits', async () => {
    const { session, post } = await setup()
    const { scopePlan } = await (await post({ includedRoots: ['missing'] })).json()
    expect((await post({ confirm: true, planId: scopePlan.id })).status).toBe(409)
    expect(buildReadiness(await snapshots.getForSession(session.id), 'different')).toMatch(/pinned commit/)
  })
})
