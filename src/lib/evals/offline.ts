import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { NextRequest } from 'next/server'
import { sessionStore } from '@/lib/session/store'
import { issueSessionCapability } from '@/lib/session/capability'
import { InMemoryCodeSource, registerCodeSource } from '@/lib/code'
import { toolRegistry } from '@/lib/api/tool-registry'
import { getRepositorySnapshotStore } from '@/lib/repo/snapshot-store'
import { profileRepository } from '@/lib/repo/profile'
import { buildReadiness } from '@/lib/repo/readiness'
import { validateBuild } from '@/lib/build/validate'

export const EvalCaseSchema = z
  .object({
    id: z.string().min(1),
    repositoryFiles: z.record(z.string()),
    profileComplete: z.boolean(),
    tier: z.enum(['small', 'mid', 'large', 'very-large']),
    scope: z
      .object({ includedRoots: z.array(z.string()), excludedRoots: z.array(z.string()), confirmed: z.boolean() })
      .optional(),
    openQuestion: z.string().optional(),
    readPath: z.string(),
    searchQuery: z.string(),
    expected: z
      .object({
        readStatus: z.number().int(),
        listedPaths: z.array(z.string()),
        searchPaths: z.array(z.string()),
        buildAllowed: z.boolean(),
      })
      .strict(),
  })
  .strict()
export type OfflineEvalCase = z.infer<typeof EvalCaseSchema>

// Fixture validation is separate from executing application behavior.
export async function loadOfflineEvalCases(directory = join(process.cwd(), 'evals', 'cases')) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort()
  const cases: OfflineEvalCase[] = []
  const ids = new Set<string>()
  for (const name of names) {
    const parsed = EvalCaseSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))
    if (ids.has(parsed.id)) throw new Error(`Duplicate offline eval case: ${parsed.id}`)
    ids.add(parsed.id)
    cases.push(parsed)
  }
  if (!cases.length) throw new Error('Offline evaluation dataset is empty')
  return cases
}

export async function evaluateOfflineCase(fixture: OfflineEvalCase): Promise<string[]> {
  if (process.env.DATABASE_URL || process.env.NODE_ENV === 'production')
    throw new Error('Offline evaluations require isolated memory storage')
  const source = new InMemoryCodeSource(fixture.repositoryFiles, 'fixture-commit')
  const session = sessionStore.createSession({
    repoUrl: 'https://github.com/fixture/repo',
    repositorySha: await source.getCommitSha(),
    specOutput: '# Synthetic evaluation',
    buildStatus: 'ready',
    openQuestions: fixture.openQuestion
      ? [{ id: 'q', question: fixture.openQuestion, context: '', timestamp: new Date().toISOString() }]
      : [],
  })
  const unregister = registerCodeSource(session.id, source)
  try {
    const snapshots = getRepositorySnapshotStore()
    const snapshot = await snapshots.ensureForSession(session, session.repositorySha!)
    const profile = await profileRepository(source, session.repositorySha!)
    await snapshots.saveProfile(snapshot.id, {
      ...profile,
      tier: fixture.tier,
      treeComplete: fixture.profileComplete,
      indexStatus: fixture.profileComplete ? 'ready' : 'partial',
    })
    if (fixture.scope) {
      const plan = await snapshots.proposeScope(session.id, {
        repositorySha: session.repositorySha!,
        includedRoots: fixture.scope.includedRoots,
        excludedRoots: fixture.scope.excludedRoots,
        estimatedFiles: profile.fileCount,
        estimatedBytes: profile.byteCount,
        dependencyBoundaries: [],
        reason: 'Synthetic evaluation',
      })
      if (fixture.scope.confirmed) await snapshots.confirmScope(session.id, plan.id)
    }
    const capability = issueSessionCapability(session.id)
    const request = (body: object, token = capability) =>
      new NextRequest('http://localhost/api/tools/evaluation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, session_id: session.id, session_token: token }),
      })
    const failures: string[] = []
    const check = (name: string, actual: unknown, expected: unknown) => {
      if (!isDeepStrictEqual(actual, expected))
        failures.push(`${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
    }
    for (const token of ['', issueSessionCapability('another-session')]) {
      const denied = await toolRegistry.dispatch('read-file', request({ path: fixture.readPath }, token))
      check('capability denial', denied.status, 401)
    }
    check('unauthorized reads leave no event', sessionStore.getSession(session.id)!.filesRead.length, 0)
    const listing = await toolRegistry.dispatch('list-files', request({}))
    check('list contract', listing.status, 200)
    const listed = await listing.json()
    check(
      'permitted listing',
      listed.files?.map((file: { path: string }) => file.path).sort(),
      [...fixture.expected.listedPaths].sort()
    )
    check('listing completeness', listed.complete, true)
    const read = await toolRegistry.dispatch('read-file', request({ path: fixture.readPath }))
    check('read permission', read.status, fixture.expected.readStatus)
    check(
      'read evidence',
      sessionStore.getSession(session.id)!.filesRead.map(file => file.path),
      read.status === 200 ? [fixture.readPath] : []
    )
    const search = await toolRegistry.dispatch('search-code', request({ query: fixture.searchQuery }))
    check('search contract', search.status, 200)
    const found = await search.json()
    check(
      'permitted search',
      found.results?.map((result: { path: string }) => result.path).sort(),
      [...fixture.expected.searchPaths].sort()
    )
    check('search completeness', found.complete, true)
    const current = sessionStore.getSession(session.id)!
    const gate = buildReadiness(await snapshots.getForSession(session.id), session.repositorySha)
    const validation = validateBuild(current, () => ({ ok: true }))
    check('Build gate', gate === null && validation.type === 'ok', fixture.expected.buildAllowed)
    return failures.map(failure => `${fixture.id}: ${failure}`)
  } finally {
    unregister()
  }
}

export async function runOfflineEvaluations() {
  const cases = await loadOfflineEvalCases()
  const failures: string[] = []
  for (const fixture of cases) failures.push(...(await evaluateOfflineCase(fixture)))
  if (failures.length) throw new Error(`Offline evaluation failures:\n${failures.join('\n')}`)
  return { count: cases.length }
}
