import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main, runOfflineEvalReport } from '@/scripts/run-offline-evals'
import type { OfflineEvalCase } from '@/lib/evals/offline'

const fixture = vi.hoisted(() => ({ load: vi.fn(), evaluate: vi.fn(), git: vi.fn() }))
vi.mock('@/lib/evals/offline', () => ({ loadOfflineEvalCases: fixture.load, evaluateOfflineCase: fixture.evaluate }))
vi.mock('node:child_process', () => ({ execFileSync: fixture.git }))

const testCase = (id: string): OfflineEvalCase => ({
  id,
  repositoryFiles: { 'private.ts': 'synthetic-repository-content' },
  profileComplete: true,
  tier: 'small',
  readPath: 'private.ts',
  searchQuery: 'synthetic',
  expected: { readStatus: 200, listedPaths: ['private.ts'], searchPaths: ['private.ts'], buildAllowed: true },
})
let root: string
let directory: string
const commit = 'a'.repeat(40)
const prompt = 'Synthetic prompt version one\n'

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('NODE_ENV', 'test')
  root = await mkdtemp(join(tmpdir(), 'specvoice-eval-report-'))
  directory = join(root, 'evals', 'cases')
  await mkdir(directory, { recursive: true })
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', 'system-prompt.md'), prompt)
  await writeFile(join(directory, 'z.json'), JSON.stringify(testCase('z-case')))
  await writeFile(join(directory, 'a.json'), JSON.stringify(testCase('a-case')))
  fixture.git.mockImplementation((_command, args: string[]) => (args.includes('rev-parse') ? `${commit}\n` : ''))
  fixture.load.mockResolvedValue([testCase('a-case'), testCase('z-case')])
  fixture.evaluate.mockResolvedValue([])
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('versioned offline evaluation evidence', () => {
  it('records sorted file/content and prompt versions with source provenance and per-case timings', async () => {
    const report = await runOfflineEvalReport(root)
    const hash = createHash('sha256')
    for (const name of ['a.json', 'z.json']) {
      const content = await readFile(join(directory, name))
      hash
        .update(`${Buffer.byteLength(name)}\0`)
        .update(name)
        .update(`${content.length}\0`)
        .update(content)
    }
    expect(report).toMatchObject({
      schemaVersion: 1,
      source: { commit, dirty: false },
      dataset: { sha256: hash.digest('hex'), fileCount: 2 },
      prompt: { sha256: createHash('sha256').update(prompt).digest('hex') },
      totals: { cases: 2, passed: 2, failed: 0 },
      errors: [],
    })
    expect(report.cases.map(result => result.id)).toEqual(['a-case', 'z-case'])
    for (const result of report.cases) {
      expect(result.status).toBe('passed')
      expect(result.assertionFailures).toEqual([])
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    }
    expect(Date.parse(report.completedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt))
    expect(fixture.load).toHaveBeenCalledWith(directory)
    expect(fixture.evaluate).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(join(root, 'artifacts', 'evals', 'offline.json'), 'utf8'))).toEqual(report)
  })

  it('changes only the relevant version when prompt or dataset bytes change', async () => {
    const original = await runOfflineEvalReport(root)
    await writeFile(join(root, 'docs', 'system-prompt.md'), 'Synthetic prompt version two\n')
    const changedPrompt = await runOfflineEvalReport(root)
    expect(changedPrompt.dataset).toEqual(original.dataset)
    expect(changedPrompt.prompt.sha256).not.toBe(original.prompt.sha256)
    await writeFile(join(directory, 'a.json'), `${JSON.stringify(testCase('a-case'))}\n`)
    const changedDataset = await runOfflineEvalReport(root)
    expect(changedDataset.dataset.sha256).not.toBe(changedPrompt.dataset.sha256)
    expect(changedDataset.prompt).toEqual(changedPrompt.prompt)
  })

  it('saves failing assertions and execution failures without leaking actual values or exception text', async () => {
    fixture.evaluate
      .mockResolvedValueOnce(['a-case: permitted listing: expected ["private.ts"], received ["synthetic-secret"]'])
      .mockRejectedValueOnce(new Error('synthetic-exception-secret'))
    const report = await runOfflineEvalReport(root)
    expect(report.cases).toMatchObject([
      { id: 'a-case', status: 'failed', assertionFailures: ['permitted listing'] },
      { id: 'z-case', status: 'failed', assertionFailures: ['Evaluation execution failed'] },
    ])
    expect(report.totals).toMatchObject({ cases: 2, passed: 0, failed: 2 })
    const saved = await readFile(join(root, 'artifacts', 'evals', 'offline.json'), 'utf8')
    expect(JSON.parse(saved)).toEqual(report)
    for (const value of [
      'private.ts',
      'synthetic-repository-content',
      'synthetic-secret',
      'synthetic-exception-secret',
    ])
      expect(saved).not.toContain(value)
  })

  it('records a dirty tree without saving its filenames', async () => {
    fixture.git.mockImplementation((_command, args: string[]) =>
      args.includes('rev-parse') ? commit : ' M secret-user-file.ts\n'
    )
    const report = await runOfflineEvalReport(root)
    expect(report.source).toEqual({ commit, dirty: true })
    expect(JSON.stringify(report)).not.toContain('secret-user-file')
  })

  it('persists setup failures without executing cases or exposing schema input', async () => {
    fixture.load.mockRejectedValue(new Error('synthetic-schema-secret'))
    const report = await runOfflineEvalReport(root)
    expect(report.errors).toEqual(['Dataset schema validation failed'])
    expect(fixture.evaluate).not.toHaveBeenCalled()
    expect(report.totals).toMatchObject({ cases: 0, passed: 0, failed: 0 })
    expect(await readFile(join(root, 'artifacts', 'evals', 'offline.json'), 'utf8')).not.toContain(
      'synthetic-schema-secret'
    )
  })

  it('makes the guarded CLI fail after persisting a failed case report', async () => {
    const previousExitCode = process.exitCode
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    fixture.evaluate.mockResolvedValueOnce(['a-case: Build gate: expected true, received false'])
    try {
      await main()
      expect(process.exitCode).toBe(1)
      const saved = JSON.parse(await readFile(join(root, 'artifacts', 'evals', 'offline.json'), 'utf8'))
      expect(saved.totals.failed).toBe(1)
    } finally {
      process.exitCode = previousExitCode
      cwd.mockRestore()
      log.mockRestore()
    }
  })

  it.each([{ DATABASE_URL: 'postgresql://synthetic-secret@database/test' }, { NODE_ENV: 'production' }])(
    'refuses non-isolated environments before application evaluation',
    async environment => {
      for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
      const report = await runOfflineEvalReport(root)
      expect(report.errors).toContain('Offline evaluations require isolated memory storage')
      expect(fixture.load).not.toHaveBeenCalled()
      expect(fixture.evaluate).not.toHaveBeenCalled()
      expect(JSON.stringify(report)).not.toContain('synthetic-secret')
    }
  )
})
