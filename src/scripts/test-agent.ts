import { loadEnvConfig } from '@next/env'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'
import { z } from 'zod'

// Unit test definitions. Each is upserted into ElevenLabs by name on every run.
// type "tool"  → verifies a tool call was made
// type "llm"   → evaluates the agent's conversational response via LLM
// session_id and session_token are declared as dynamic variables in all agent tools.
// Unit tests must supply it or ElevenLabs rejects the run.
const TEST_DYNAMIC_VARS = {
  session_id: 'unit-test-session',
  session_token: 'test-capability',
  call_id: '00000000-0000-4000-8000-000000000001',
}

const UNIT_TESTS = [
  {
    name: 'specvoice-files-explored-before-committing',
    spec: {
      // type 'llm' evaluates the full agent turn including tool calls.
      // successCondition: pass if the agent's first action is a file exploration tool call,
      // not an immediate implementation proposal.
      type: 'llm' as const,
      name: 'specvoice-files-explored-before-committing',
      dynamicVariables: TEST_DYNAMIC_VARS,
      chatHistory: [
        {
          role: 'user' as const,
          message: 'I want to add GitHub OAuth login to this repo using NextAuth.js.',
          timeInCallSecs: 0,
        },
      ],
      successCondition:
        'The agent explores the repository by calling list_files or read_file as its first action. It does NOT immediately propose an implementation plan, list steps, or write code without first looking at the codebase.',
      successExamples: [
        {
          response: '[calls list_files to explore the project structure before responding]',
          type: 'success' as const,
        },
      ],
      failureExamples: [
        {
          response: "You'll need to install NextAuth.js and configure OAuth providers in your next.config.js.",
          type: 'failure' as const,
        },
      ],
    },
  },
  {
    name: 'specvoice-generate-spec-response-after-discussion',
    spec: {
      type: 'llm' as const,
      name: 'specvoice-generate-spec-response-after-discussion',
      dynamicVariables: TEST_DYNAMIC_VARS,
      chatHistory: [
        { role: 'user' as const, message: 'We want to add rate limiting.', timeInCallSecs: 0 },
        {
          role: 'agent' as const,
          message: "External scraping or internal abuse — who's the risk?",
          timeInCallSecs: 5,
        },
        {
          role: 'user' as const,
          message: "External scraping. We're a public API.",
          timeInCallSecs: 10,
        },
        {
          // Agent explores the codebase — establishes that code has been reviewed.
          role: 'agent' as const,
          message: "Give me a second, I'm checking your route handlers.",
          toolCalls: [
            {
              requestId: 'req-mock-001',
              toolName: 'list_files',
              paramsAsJson: JSON.stringify({ session_id: 'unit-test-session' }),
              toolHasBeenCalled: true,
              type: 'webhook' as const,
            },
          ],
          toolResults: [
            {
              requestId: 'req-mock-001',
              toolName: 'list_files',
              resultValue: JSON.stringify({
                files: ['src/app/api/routes/users/route.ts', 'src/middleware.ts', 'src/lib/env.ts'],
              }),
              isError: false,
              toolHasBeenCalled: true,
            },
          ],
          timeInCallSecs: 15,
        },
        {
          role: 'agent' as const,
          message:
            'No middleware layer. Decision: IP-based rate limiting, blanket 100 req/min, added before route handlers.',
          timeInCallSecs: 20,
        },
        {
          role: 'user' as const,
          message: 'Perfect. Write it up.',
          timeInCallSecs: 25,
        },
      ],
      // Agent should call generate_spec or verbally confirm — NOT explore code at this late stage.
      successCondition:
        'The agent wraps up by calling generate_spec, confirming the spec will be generated, or asking one final clarifying question. It does NOT explore code (list_files, read_file) or write implementation steps at this stage.',
      successExamples: [
        {
          response: 'Alright, capturing everything — the rate limiting spec is ready.',
          type: 'success' as const,
        },
        { response: '[calls generate_spec to produce the PR spec]', type: 'success' as const },
      ],
      failureExamples: [
        {
          response: '[calls list_files to explore the repository before writing the spec]',
          type: 'failure' as const,
        },
        {
          response: "Here's the implementation: app.use(rateLimit({ windowMs: 15 * 60 * 1000 }))",
          type: 'failure' as const,
        },
      ],
    },
  },
  {
    name: 'specvoice-vague-request-triggers-pushback',
    spec: {
      type: 'llm' as const,
      name: 'specvoice-vague-request-triggers-pushback',
      dynamicVariables: TEST_DYNAMIC_VARS,
      chatHistory: [{ role: 'user' as const, message: 'Add authentication.', timeInCallSecs: 0 }],
      successCondition:
        'The agent does not start exploring the repo or proposing a solution. It asks what kind of auth, who the users are, or what the current setup is before doing anything.',
      successExamples: [
        {
          response: 'Before I dig in — what kind of auth? OAuth, magic links, API keys?',
          type: 'success' as const,
        },
      ],
      failureExamples: [{ response: 'Sure, let me look at the repo first.', type: 'failure' as const }],
    },
  },
  {
    name: 'specvoice-tone-concise-and-direct',
    spec: {
      type: 'llm' as const,
      name: 'specvoice-tone-concise-and-direct',
      dynamicVariables: TEST_DYNAMIC_VARS,
      chatHistory: [{ role: 'user' as const, message: 'What did you find in the codebase?', timeInCallSecs: 0 }],
      successCondition:
        "The response is 6 sentences or fewer. No filler opener phrases like 'Great question!', 'Certainly!', or 'I'd be happy to'. Peer-level, direct tone.",
      successExamples: [
        {
          response: 'No auth layer. Routes are all open. Middleware is the right insertion point.',
          type: 'success' as const,
        },
      ],
      failureExamples: [
        {
          response:
            "Certainly! I've taken a thorough look at the codebase and I'd be happy to explain what I found. There are several interesting patterns worth noting...",
          type: 'failure' as const,
        },
      ],
    },
  },
]

// Behavioral criteria verified via conversation simulation.
// The simulated user persona is a PM who ends the conversation WITHOUT asking
// for a spec — the simulation only checks conversational behavior, not output.
const SIMULATION_CRITERIA = [
  {
    id: 'assumptions_challenged',
    name: 'Assumptions Challenged',
    conversationGoalPrompt:
      'The agent asked at least one clarifying question before exploring the repo or proposing a solution.',
    useKnowledgeBase: false,
  },
  {
    id: 'tone_maintained',
    name: 'Tone Maintained',
    conversationGoalPrompt:
      'All agent responses were 6 sentences or fewer, direct, with no filler opener phrases like "Certainly!" or "Great question!".',
    useKnowledgeBase: false,
  },
  {
    id: 'no_code_written',
    name: 'No Code Written',
    conversationGoalPrompt:
      'The agent never produced code syntax, function definitions, or implementation snippets. It discussed plans and decisions only.',
    useKnowledgeBase: false,
  },
  {
    id: 'scope_pushback',
    name: 'Scope Pushback',
    conversationGoalPrompt:
      'When the user asked to add SSO, billing, and a dashboard redesign all at once, the agent pushed back or flagged the combined scope as too much for a single spec.',
    useKnowledgeBase: false,
  },
] as const

const SIMULATED_USER_PROMPT = `You are a product manager testing an AI assistant. Follow this
script in order. Move to the next step after each agent response — do not skip steps.

Step 1 (your opening message): "I want to improve the onboarding flow."
Step 2 (after the agent's first response): "It's a web app. Users are dropping off at step 2 of 3."
Step 3 (after the agent's second response): "Actually while we're at it — can we also add full SSO, build out a billing system, and do a complete dashboard redesign all in this same sprint?"
Step 4 (after the agent's third response): "Let me think about it more, I'll get back to you."

IMPORTANT: Follow the steps in order. Do NOT ask the agent to write anything up, generate a spec, or produce any output. End the conversation after step 4.`

const ledgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    reservations: z.array(
      z
        .object({
          id: z.string().uuid(),
          createdAt: z.string().datetime(),
          estimatedMicrousd: z.number().int().positive().max(10_000_000),
        })
        .strict()
    ),
  })
  .strict()

export interface LiveReservation {
  id: string
  estimatedUsd: number
  totalReservedUsd: number
  budgetUsd: number
}

export async function reserveLiveEvalBudget(root = process.cwd()): Promise<LiveReservation> {
  const amount = (input: string | undefined) => {
    if (!input || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(input)) throw new Error('Invalid live evaluation budget')
    const value = Math.round(Number(input) * 1_000_000)
    if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000_000)
      throw new Error('Live evaluation budget must be above zero and at most $10')
    return value
  }
  const estimate = amount(process.env.SPECVOICE_LIVE_EVAL_ESTIMATE_USD)
  const budget = amount(process.env.SPECVOICE_LIVE_BUDGET_USD ?? '10')
  const directory = join(root, 'artifacts', 'evals')
  const path = join(directory, 'live-budget.json')
  const lock = join(directory, '.live-budget-lock')
  const temporary = join(directory, `.live-budget-${randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true })
  try {
    await mkdir(lock, { mode: 0o700 })
  } catch {
    throw new Error('Live evaluation budget is locked; uncertain previous reservations require operator review')
  }
  try {
    let ledger: z.infer<typeof ledgerSchema>
    try {
      ledger = ledgerSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid live evaluation budget ledger')
      ledger = { schemaVersion: 1, reservations: [] }
    }
    const reserved = ledger.reservations.reduce((total, reservation) => total + reservation.estimatedMicrousd, 0)
    if (!Number.isSafeInteger(reserved) || reserved + estimate > budget)
      throw new Error('Live evaluation budget exhausted')
    const id = randomUUID()
    ledger.reservations.push({ id, createdAt: new Date().toISOString(), estimatedMicrousd: estimate })
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(`${JSON.stringify(ledger, null, 2)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    const parent = await open(directory, 'r')
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
    return {
      id,
      estimatedUsd: estimate / 1_000_000,
      totalReservedUsd: (reserved + estimate) / 1_000_000,
      budgetUsd: budget / 1_000_000,
    }
  } finally {
    await rm(temporary, { force: true })
    await rmdir(lock)
  }
}

type CriterionResult = 'success' | 'failure' | 'unknown'
const score = (result: CriterionResult | null): 1 | 0 | null =>
  result === 'success' ? 1 : result === 'failure' ? 0 : null
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')

export interface LiveEvalReport {
  schemaVersion: 1
  id: string
  startedAt: string
  completedAt: string
  status: 'passed' | 'failed'
  source: { commit: string | null; dirty: boolean | null }
  dataset: { sha256: string }
  prompt: {
    localSha256: string | null
    remoteSha256: string | null
    agentVersionId: string | null
    llm: string | null
    unchangedAfterRun: boolean | null
  }
  reservation: LiveReservation | null
  usage: null
  costUsd: null
  billingNote: string
  scoreDefinition: string
  unitTests: {
    latencyMs: number | null
    cases: Array<{
      id: string
      status: 'passed' | 'failed' | 'pending' | 'not_run' | 'unknown'
      criterionResult: CriterionResult | null
      score: 1 | 0 | null
    }>
  }
  simulation: {
    latencyMs: number | null
    status: 'passed' | 'failed' | 'not_run' | 'unknown'
    criteria: Array<{ id: string; result: CriterionResult; score: 1 | 0 | null }>
  }
  latencyMs: number
  errors: string[]
}

export async function main(root = process.cwd()): Promise<LiveEvalReport> {
  const started = performance.now()
  const report: LiveEvalReport = {
    schemaVersion: 1,
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    completedAt: '',
    status: 'failed',
    source: { commit: null, dirty: null },
    dataset: {
      sha256: hash(
        JSON.stringify({ unitTests: UNIT_TESTS, criteria: SIMULATION_CRITERIA, simulatedUser: SIMULATED_USER_PROMPT })
      ),
    },
    prompt: { localSha256: null, remoteSha256: null, agentVersionId: null, llm: null, unchangedAfterRun: null },
    reservation: null,
    usage: null,
    costUsd: null,
    billingNote:
      'These provider responses contain no billing. Reservations are operator estimates, not a billing ceiling; calibrate against the provider plan.',
    scoreDefinition:
      'Derived pass indicator: success=1, failure=0, unknown=null; not a provider numeric quality score.',
    unitTests: {
      latencyMs: null,
      cases: UNIT_TESTS.map(test => ({ id: test.name, status: 'not_run', criterionResult: null, score: null })),
    },
    simulation: {
      latencyMs: null,
      status: 'not_run',
      criteria: SIMULATION_CRITERIA.map(criterion => ({ id: criterion.id, result: 'unknown', score: null })),
    },
    latencyMs: 0,
    errors: [],
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  const deadline = setTimeout(abort, 5 * 60 * 1000)
  deadline.unref()
  process.once('SIGTERM', abort)
  process.once('SIGINT', abort)
  let stage = 'configuration'
  try {
    loadEnvConfig(root)
    const apiKey = process.env.ELEVENLABS_API_KEY
    const agentId = process.env.ELEVENLABS_AGENT_ID
    if (!apiKey || !agentId) throw new Error('Live evaluation credentials are missing')
    const git = (args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    const commit = git(['rev-parse', '--verify', 'HEAD'])
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid source revision')
    report.source = { commit, dirty: git(['status', '--porcelain', '--untracked-files=normal']).length > 0 }
    report.prompt.localSha256 = hash(await readFile(join(root, 'docs', 'system-prompt.md')))
    stage = 'budget reservation'
    report.reservation = await reserveLiveEvalBudget(root)
    controller.signal.throwIfAborted()
    const client = new ElevenLabsClient({ apiKey, timeoutInSeconds: 30, maxRetries: 0 })
    const options = { abortSignal: controller.signal }
    stage = 'agent configuration'
    const agent = await client.conversationalAi.agents.get(agentId, {}, options)
    const remote = agent.conversationConfig.agent?.prompt
    if (typeof remote?.prompt !== 'string' || !remote.prompt) throw new Error('Agent prompt is unavailable')
    report.prompt.remoteSha256 = hash(remote.prompt)
    report.prompt.agentVersionId = agent.versionId ?? null
    report.prompt.llm = remote.llm ?? null

    stage = 'test setup'
    const testIds: Array<{ name: string; id: string }> = []
    for (const definition of UNIT_TESTS) {
      controller.signal.throwIfAborted()
      const listed = await client.conversationalAi.tests.list({ search: definition.name }, options)
      const existing = listed.tests.find(test => test.name === definition.name)
      if (existing) {
        await client.conversationalAi.tests.update(existing.id, definition.spec, options)
        testIds.push({ name: definition.name, id: existing.id })
      } else {
        const created = await client.conversationalAi.tests.create(definition.spec, options)
        testIds.push({ name: definition.name, id: created.id })
      }
    }
    stage = 'unit tests'
    const suiteStarted = performance.now()
    report.unitTests.cases.forEach(test => {
      test.status = 'unknown'
    })
    try {
      let invocation = await client.conversationalAi.agents.runTests(
        agentId,
        { tests: testIds.map(test => ({ testId: test.id })) },
        options
      )
      const record = () => {
        report.unitTests.cases = testIds.map(test => {
          const result = invocation.testRuns.find(run => run.testId === test.id)
          const criterionResult = result?.conditionResult?.result ?? null
          return { id: test.name, status: result?.status ?? 'unknown', criterionResult, score: score(criterionResult) }
        })
      }
      record()
      while (invocation.testRuns.some(run => run.status === 'pending')) {
        if (performance.now() - suiteStarted >= 120_000) throw new Error('Unit test polling timed out')
        await delay(4000, undefined, { signal: controller.signal })
        invocation = await client.conversationalAi.tests.invocations.get(invocation.id, options)
        record()
      }
    } finally {
      report.unitTests.latencyMs = performance.now() - suiteStarted
    }
    stage = 'simulation'
    const simulationStarted = performance.now()
    report.simulation.status = 'unknown'
    try {
      const simulation = await client.conversationalAi.agents.simulateConversation(
        agentId,
        {
          simulationSpecification: {
            simulatedUserConfig: { prompt: { prompt: SIMULATED_USER_PROMPT, llm: 'gpt-4o', temperature: 0.5 } },
            dynamicVariables: { ...TEST_DYNAMIC_VARS, session_id: 'sim-session-001' },
            toolMockConfig: {
              list_files: {
                defaultReturnValue: JSON.stringify({
                  files: ['src/app/page.tsx', 'src/lib/env.ts', 'src/app/api/tools/list-files/route.ts'],
                }),
              },
              read_file: {
                defaultReturnValue: JSON.stringify({ content: '// placeholder file content for simulation' }),
              },
              search_code: { defaultReturnValue: JSON.stringify({ results: [] }) },
              save_decision: { defaultReturnValue: JSON.stringify({ ok: true }) },
              flag_question: { defaultReturnValue: JSON.stringify({ ok: true }) },
              generate_spec: { defaultReturnValue: JSON.stringify({ ok: true }) },
            },
          },
          extraEvaluationCriteria: [...SIMULATION_CRITERIA],
          newTurnsLimit: 16,
        },
        { ...options, timeoutInSeconds: 120 }
      )
      const criteria =
        simulation.analysis.evaluationCriteriaResultsList ??
        Object.values(simulation.analysis.evaluationCriteriaResults ?? {})
      report.simulation.criteria = SIMULATION_CRITERIA.map(criterion => {
        const result = criteria.find(result => result.criteriaId === criterion.id)?.result ?? 'unknown'
        return { id: criterion.id, result, score: score(result) }
      })
      report.simulation.status = report.simulation.criteria.every(criterion => criterion.result === 'success')
        ? 'passed'
        : 'failed'
    } finally {
      report.simulation.latencyMs = performance.now() - simulationStarted
    }
    stage = 'agent version verification'
    const after = await client.conversationalAi.agents.get(agentId, {}, options)
    const afterPrompt = after.conversationConfig.agent?.prompt
    report.prompt.unchangedAfterRun =
      typeof afterPrompt?.prompt === 'string' &&
      hash(afterPrompt.prompt) === report.prompt.remoteSha256 &&
      (after.versionId ?? null) === report.prompt.agentVersionId &&
      (afterPrompt.llm ?? null) === report.prompt.llm
    if (!report.prompt.unchangedAfterRun) throw new Error('Agent changed during evaluation')
    if (report.unitTests.cases.every(test => test.status === 'passed') && report.simulation.status === 'passed')
      report.status = 'passed'
  } catch {
    report.errors.push(
      controller.signal.aborted
        ? 'Live evaluation exceeded its deadline or was cancelled'
        : `Live evaluation failed at ${stage}`
    )
  } finally {
    clearTimeout(deadline)
    process.removeListener('SIGTERM', abort)
    process.removeListener('SIGINT', abort)
    report.completedAt = new Date().toISOString()
    report.latencyMs = performance.now() - started
    const directory = join(root, 'artifacts', 'evals')
    await mkdir(directory, { recursive: true })
    const filename = `live-${report.startedAt.replace(/[:.]/g, '-')}-${report.id}.json`
    await writeFile(join(directory, filename), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    console.log(`Live evaluations ${report.status}; report: artifacts/evals/${filename}`)
    if (report.status !== 'passed') process.exitCode = 1
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    console.error('Live evaluation report could not be saved; any reservation remains consumed')
    process.exitCode = 1
  })
