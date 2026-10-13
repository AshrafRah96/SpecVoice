import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main, reserveLiveEvalBudget } from '@/scripts/test-agent'

const fixture = vi.hoisted(() => ({
  loadEnv: vi.fn(),
  git: vi.fn(),
  constructor: vi.fn(),
  getAgent: vi.fn(),
  listTests: vi.fn(),
  updateTest: vi.fn(),
  createTest: vi.fn(),
  runTests: vi.fn(),
  getInvocation: vi.fn(),
  simulate: vi.fn(),
}))
vi.mock('@next/env', () => ({ loadEnvConfig: fixture.loadEnv }))
vi.mock('node:child_process', () => ({ execFileSync: fixture.git }))
vi.mock('@elevenlabs/elevenlabs-js', () => ({
  ElevenLabsClient: class {
    constructor(options: unknown) {
      fixture.constructor(options)
    }
    conversationalAi = {
      agents: { get: fixture.getAgent, runTests: fixture.runTests, simulateConversation: fixture.simulate },
      tests: {
        list: fixture.listTests,
        update: fixture.updateTest,
        create: fixture.createTest,
        invocations: { get: fixture.getInvocation },
      },
    }
  },
}))

let root: string
let directory: string
let originalExitCode: typeof process.exitCode
const localPrompt = 'Synthetic local prompt'
const remotePrompt = 'Synthetic private remote prompt'
const criteria = ['assumptions_challenged', 'tone_maintained', 'no_code_written', 'scope_pushback']
const remoteAgent = () => ({
  versionId: 'version-fixture',
  conversationConfig: { agent: { prompt: { prompt: remotePrompt, llm: 'claude-sonnet-4-5' } } },
})
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

beforeEach(async () => {
  vi.clearAllMocks()
  originalExitCode = process.exitCode
  root = await mkdtemp(join(tmpdir(), 'specvoice-live-report-'))
  directory = join(root, 'artifacts', 'evals')
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', 'system-prompt.md'), localPrompt)
  vi.stubEnv('ELEVENLABS_API_KEY', 'synthetic-api-secret')
  vi.stubEnv('ELEVENLABS_AGENT_ID', 'synthetic-agent')
  vi.stubEnv('SPECVOICE_LIVE_EVAL_ESTIMATE_USD', '2')
  vi.stubEnv('SPECVOICE_LIVE_BUDGET_USD', '10')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  fixture.git.mockImplementation((_binary, args: string[]) =>
    args.includes('rev-parse') ? 'a'.repeat(40) : ' M private-filename.ts'
  )
  fixture.getAgent.mockResolvedValue(remoteAgent())
  fixture.listTests.mockResolvedValue({ tests: [] })
  fixture.createTest.mockImplementation(async ({ name }: { name: string }) => ({ id: `test-${name}` }))
  fixture.updateTest.mockResolvedValue({})
  fixture.runTests.mockImplementation(async (_agent: string, request: { tests: Array<{ testId: string }> }) => ({
    id: 'invocation-fixture',
    testRuns: request.tests.map(test => ({
      testId: test.testId,
      status: 'passed',
      conditionResult: { result: 'success', rationale: { summary: 'synthetic-private-rationale' } },
      agentResponses: [{ message: 'synthetic-private-response' }],
    })),
  }))
  fixture.simulate.mockResolvedValue({
    simulatedConversation: [{ message: 'synthetic-private-transcript' }],
    analysis: {
      evaluationCriteriaResultsList: criteria.map(criteriaId => ({
        criteriaId,
        result: 'success',
        rationale: 'synthetic-private-rationale',
      })),
    },
  })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = originalExitCode
  await rm(root, { recursive: true, force: true })
})

const ledger = async () => JSON.parse(await readFile(join(directory, 'live-budget.json'), 'utf8'))
const reports = async () =>
  Promise.all(
    (await readdir(directory))
      .filter(name => /^live-.*\.json$/.test(name) && name !== 'live-budget.json')
      .map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')))
  )

describe('durable live evaluation reservations', () => {
  it.each(['', '0', '-1', 'NaN', '11', '0.0000001'])('refuses an absent or invalid estimate %s', async estimate => {
    vi.stubEnv('SPECVOICE_LIVE_EVAL_ESTIMATE_USD', estimate)
    await expect(reserveLiveEvalBudget(root)).rejects.toThrow('budget')
    expect(fixture.runTests).not.toHaveBeenCalled()
  })

  it('accumulates reservations across runs and does not reset an exhausted ledger', async () => {
    vi.stubEnv('SPECVOICE_LIVE_EVAL_ESTIMATE_USD', '6')
    expect(await reserveLiveEvalBudget(root)).toMatchObject({ estimatedUsd: 6, totalReservedUsd: 6, budgetUsd: 10 })
    await expect(reserveLiveEvalBudget(root)).rejects.toThrow('exhausted')
    expect((await ledger()).reservations).toHaveLength(1)
    expect((await ledger()).reservations[0].estimatedMicrousd).toBe(6_000_000)
  })

  it('cannot overspend with two concurrent reservations', async () => {
    vi.stubEnv('SPECVOICE_LIVE_EVAL_ESTIMATE_USD', '6')
    const results = await Promise.allSettled([reserveLiveEvalBudget(root), reserveLiveEvalBudget(root)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((await ledger()).reservations).toHaveLength(1)
  })

  it('fails closed on an uncertain lock or malformed ledger', async () => {
    await mkdir(join(directory, '.live-budget-lock'), { recursive: true })
    await expect(reserveLiveEvalBudget(root)).rejects.toThrow('locked')
    expect(await readdir(directory)).toContain('.live-budget-lock')
    await rm(join(directory, '.live-budget-lock'), { recursive: true })
    await writeFile(join(directory, 'live-budget.json'), '{invalid private data')
    await expect(reserveLiveEvalBudget(root)).rejects.toThrow('Invalid live evaluation budget ledger')
    expect(await readFile(join(directory, 'live-budget.json'), 'utf8')).toBe('{invalid private data')
  })
})

describe('bounded, redacted live evaluation reports', () => {
  it('makes no SDK calls without an estimate and still persists a failure report', async () => {
    vi.stubEnv('SPECVOICE_LIVE_EVAL_ESTIMATE_USD', '')
    const report = await main(root)
    expect(report.status).toBe('failed')
    expect(report.errors).toContain('Live evaluation failed at budget reservation')
    expect(fixture.constructor).not.toHaveBeenCalled()
    expect(fixture.getAgent).not.toHaveBeenCalled()
    expect(fixture.runTests).not.toHaveBeenCalled()
    expect(fixture.simulate).not.toHaveBeenCalled()
    expect(await reports()).toEqual([report])
    expect(process.exitCode).toBe(1)
  })

  it('records actual agent versions, safe scores, bounded calls, and unknown billing', async () => {
    const report = await main(root)
    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'passed',
      source: { commit: 'a'.repeat(40), dirty: true },
      prompt: {
        localSha256: digest(localPrompt),
        remoteSha256: digest(remotePrompt),
        agentVersionId: 'version-fixture',
        llm: 'claude-sonnet-4-5',
        unchangedAfterRun: true,
      },
      usage: null,
      costUsd: null,
      reservation: { estimatedUsd: 2, totalReservedUsd: 2, budgetUsd: 10 },
      errors: [],
    })
    expect(report.dataset.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(report.unitTests.cases).toHaveLength(4)
    expect(report.unitTests.cases.every(test => test.status === 'passed' && test.score === 1)).toBe(true)
    expect(report.simulation.criteria.every(criterion => criterion.score === 1)).toBe(true)
    expect(report.unitTests.latencyMs).toBeGreaterThanOrEqual(0)
    expect(report.simulation.latencyMs).toBeGreaterThanOrEqual(0)
    expect(fixture.constructor).toHaveBeenCalledWith({
      apiKey: 'synthetic-api-secret',
      timeoutInSeconds: 30,
      maxRetries: 0,
    })
    expect(fixture.runTests).toHaveBeenCalledOnce()
    expect(fixture.runTests.mock.calls[0][1].tests).toHaveLength(4)
    expect(fixture.simulate).toHaveBeenCalledOnce()
    expect(fixture.simulate.mock.calls[0][1]).toMatchObject({
      newTurnsLimit: 16,
      simulationSpecification: { dynamicVariables: { call_id: expect.any(String) } },
    })
    expect(Object.keys(fixture.simulate.mock.calls[0][1].simulationSpecification.toolMockConfig)).toHaveLength(6)
    expect(fixture.simulate.mock.calls[0][2]).toMatchObject({
      timeoutInSeconds: 120,
      abortSignal: expect.any(AbortSignal),
    })
    for (const method of [fixture.getAgent, fixture.listTests, fixture.createTest, fixture.runTests])
      for (const call of method.mock.calls) expect(call.at(-1).abortSignal).toBeInstanceOf(AbortSignal)
    const serialized = JSON.stringify(await reports())
    for (const value of [
      remotePrompt,
      localPrompt,
      'private-filename',
      'synthetic-api-secret',
      'synthetic-private-rationale',
      'synthetic-private-transcript',
      'synthetic-private-response',
    ])
      expect(serialized).not.toContain(value)
  })

  it('keeps a failed or uncertain paid request reserved and blocks repeated spending', async () => {
    vi.stubEnv('SPECVOICE_LIVE_EVAL_ESTIMATE_USD', '6')
    fixture.runTests.mockRejectedValueOnce(new Error('synthetic-api-secret in provider error'))
    const failed = await main(root)
    expect(failed.errors).toEqual(['Live evaluation failed at unit tests'])
    expect(failed.unitTests.cases.every(test => test.status === 'unknown')).toBe(true)
    expect(failed.reservation?.estimatedUsd).toBe(6)
    expect((await ledger()).reservations).toHaveLength(1)
    const repeated = await main(root)
    expect(repeated.errors).toEqual(['Live evaluation failed at budget reservation'])
    expect(fixture.runTests).toHaveBeenCalledOnce()
    expect(fixture.simulate).not.toHaveBeenCalled()
    expect(await reports()).toHaveLength(2)
    expect(JSON.stringify(await reports())).not.toContain('synthetic-api-secret')
  })

  it('preserves provider categorical failures and unknown results without invented scores', async () => {
    fixture.simulate.mockResolvedValueOnce({
      analysis: {
        evaluationCriteriaResultsList: [
          { criteriaId: criteria[0], result: 'failure', rationale: 'synthetic-private-rationale' },
          { criteriaId: criteria[1], result: 'unknown', rationale: 'synthetic-private-rationale' },
        ],
      },
    })
    const report = await main(root)
    expect(report.status).toBe('failed')
    expect(report.simulation.criteria[0]).toEqual({ id: criteria[0], result: 'failure', score: 0 })
    expect(report.simulation.criteria[1]).toEqual({ id: criteria[1], result: 'unknown', score: null })
    expect(report.simulation.criteria[2]).toEqual({ id: criteria[2], result: 'unknown', score: null })
  })

  it('flags an agent version change during the suite', async () => {
    fixture.getAgent
      .mockResolvedValueOnce(remoteAgent())
      .mockResolvedValueOnce({ ...remoteAgent(), versionId: 'changed-version' })
    const report = await main(root)
    expect(report.prompt.unchangedAfterRun).toBe(false)
    expect(report.status).toBe('failed')
    expect(report.errors).toEqual(['Live evaluation failed at agent version verification'])
  })

  it('aborts the whole run at five minutes and retains the reservation', async () => {
    vi.useFakeTimers()
    let started!: () => void
    const simulationStarted = new Promise<void>(resolve => {
      started = resolve
    })
    fixture.simulate.mockImplementation(
      (_agent, _request, options: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => reject(new Error('synthetic-private-abort')), {
            once: true,
          })
          started()
        })
    )
    const running = main(root)
    await simulationStarted
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    const report = await running
    expect(report.status).toBe('failed')
    expect(report.errors).toEqual(['Live evaluation exceeded its deadline or was cancelled'])
    expect(report.simulation.status).toBe('unknown')
    expect((await ledger()).reservations).toHaveLength(1)
    expect(await reports()).toEqual([report])
  })
})
