import { loadEnvConfig } from '@next/env'

// Load .env.local before env.ts runs its Zod validation — static imports are
// hoisted so env.ts would throw before any code ran. Dynamic imports fix this.
loadEnvConfig(process.cwd())

// Unit test definitions. Each is upserted into ElevenLabs by name on every run.
// type "tool"  → verifies a tool call was made
// type "llm"   → evaluates the agent's conversational response via LLM
// session_id is declared as a dynamic variable in all agent tools.
// Unit tests must supply it or ElevenLabs rejects the run.
const TEST_DYNAMIC_VARS = { session_id: 'unit-test-session' }

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
          response:
            "You'll need to install NextAuth.js and configure OAuth providers in your next.config.js.",
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
          message: "No middleware layer. Decision: IP-based rate limiting, blanket 100 req/min, added before route handlers.",
          timeInCallSecs: 20,
        },
        {
          role: 'user' as const,
          message: "Perfect. Write it up.",
          timeInCallSecs: 25,
        },
      ],
      // Agent should call generate_spec or verbally confirm — NOT explore code at this late stage.
      successCondition:
        "The agent wraps up by calling generate_spec, confirming the spec will be generated, or asking one final clarifying question. It does NOT explore code (list_files, read_file) or write implementation steps at this stage.",
      successExamples: [
        { response: 'Alright, capturing everything — the rate limiting spec is ready.', type: 'success' as const },
        { response: '[calls generate_spec to produce the PR spec]', type: 'success' as const },
      ],
      failureExamples: [
        {
          response: "[calls list_files to explore the repository before writing the spec]",
          type: 'failure' as const,
        },
        {
          response:
            "Here's the implementation: app.use(rateLimit({ windowMs: 15 * 60 * 1000 }))",
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
      chatHistory: [
        { role: 'user' as const, message: 'Add authentication.', timeInCallSecs: 0 },
      ],
      successCondition:
        "The agent does not start exploring the repo or proposing a solution. It asks what kind of auth, who the users are, or what the current setup is before doing anything.",
      successExamples: [
        {
          response: "Before I dig in — what kind of auth? OAuth, magic links, API keys?",
          type: 'success' as const,
        },
      ],
      failureExamples: [
        { response: "Sure, let me look at the repo first.", type: 'failure' as const },
      ],
    },
  },
  {
    name: 'specvoice-tone-concise-and-direct',
    spec: {
      type: 'llm' as const,
      name: 'specvoice-tone-concise-and-direct',
      dynamicVariables: TEST_DYNAMIC_VARS,
      chatHistory: [
        { role: 'user' as const, message: 'What did you find in the codebase?', timeInCallSecs: 0 },
      ],
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

async function main() {
  const { env } = await import('@/lib/env')
  const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js')

  if (!env.ELEVENLABS_AGENT_ID) {
    console.error('ELEVENLABS_AGENT_ID is required. Run npm run setup-agent first.')
    process.exit(1)
  }

  const client = new ElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY })
  const agentId = env.ELEVENLABS_AGENT_ID

  // ── Step 1: Upsert unit tests ──────────────────────────────────────────────
  console.log('Upserting unit tests...')
  const testIds: Array<{ name: string; id: string }> = []

  for (const testDef of UNIT_TESTS) {
    const listResult = await client.conversationalAi.tests.list({ search: testDef.name })
    const existing = listResult.tests.find(t => t.name === testDef.name)

    if (existing) {
      await client.conversationalAi.tests.update(existing.id, testDef.spec)
      testIds.push({ name: testDef.name, id: existing.id })
      console.log(`  Updated: ${testDef.name}`)
    } else {
      const created = await client.conversationalAi.tests.create(testDef.spec)
      testIds.push({ name: testDef.name, id: created.id })
      console.log(`  Created: ${testDef.name}`)
    }
  }

  // ── Step 2: Run unit tests ─────────────────────────────────────────────────
  console.log('\nRunning unit tests...')
  const invocation = await client.conversationalAi.agents.runTests(agentId, {
    tests: testIds.map(t => ({ testId: t.id })),
  })

  // Poll until all test runs leave 'pending' status (max 2 minutes).
  let runResult = invocation
  const pollStart = Date.now()
  while (runResult.testRuns.some(r => r.status === 'pending')) {
    if (Date.now() - pollStart > 120_000) {
      console.error('Timed out waiting for unit tests to complete.')
      process.exit(1)
    }
    await new Promise(r => setTimeout(r, 4000))
    process.stdout.write('.')
    runResult = await client.conversationalAi.tests.invocations.get(invocation.id)
  }
  if (invocation.testRuns.some(r => r.status === 'pending')) process.stdout.write('\n')

  // ── Step 3: Run simulation ─────────────────────────────────────────────────
  console.log('Running simulation (this may take a minute)...')
  const simResult = await client.conversationalAi.agents.simulateConversation(agentId, {
    simulationSpecification: {
      simulatedUserConfig: {
        prompt: {
          prompt: SIMULATED_USER_PROMPT,
          llm: 'gpt-4o',
          temperature: 0.5,
        },
      },
      // Satisfy dynamic variable validation — tools use session_id in webhook URLs/headers.
      dynamicVariables: { session_id: 'sim-session-001' },
      // Mock all webhook tools so simulation doesn't call real endpoints (server not running).
      toolMockConfig: {
        list_files: { defaultReturnValue: JSON.stringify({ files: ['src/app/page.tsx', 'src/lib/env.ts', 'src/app/api/tools/list-files/route.ts'] }) },
        read_file: { defaultReturnValue: JSON.stringify({ content: '// placeholder file content for simulation' }) },
        search_code: { defaultReturnValue: JSON.stringify({ results: [] }) },
        save_decision: { defaultReturnValue: JSON.stringify({ ok: true }) },
        flag_question: { defaultReturnValue: JSON.stringify({ ok: true }) },
        generate_spec: { defaultReturnValue: JSON.stringify({ ok: true }) },
      },
    },
    extraEvaluationCriteria: [...SIMULATION_CRITERIA],
    newTurnsLimit: 16,
  })

  // ── Step 4: Print report ───────────────────────────────────────────────────
  console.log('\nSpecVoice Agent Test Run')
  console.log('========================\n')

  let passed = 0
  let total = 0

  console.log('Unit Tests')
  for (const run of runResult.testRuns) {
    const name = run.testName ?? run.testId
    const isPass = run.status === 'passed'
    const icon = isPass ? '✓' : run.status === 'pending' ? '?' : '✗'
    const detail =
      !isPass && run.conditionResult?.rationale
        ? ` — ${run.conditionResult.rationale.summary ?? run.conditionResult.rationale.messages?.join('; ') ?? ''}`
        : ''
    console.log(`  ${icon} ${name.padEnd(45)} ${run.status.toUpperCase()}${detail}`)
    if (isPass) passed++
    total++
  }

  console.log('\nSimulation (behavioral checks — spec generation tested separately in live tests)')
  const criteriaResults =
    simResult.analysis.evaluationCriteriaResultsList ??
    Object.values(simResult.analysis.evaluationCriteriaResults ?? {})

  for (const criterion of SIMULATION_CRITERIA) {
    const result = criteriaResults.find(r => r.criteriaId === criterion.id)
    const isPass = result?.result === 'success'
    const icon = isPass ? '✓' : result?.result === 'unknown' ? '?' : '✗'
    const detail = !isPass && result?.rationale ? ` — ${result.rationale}` : ''
    console.log(`  ${icon} ${criterion.name.padEnd(45)}${detail}`)
    if (isPass) passed++
    total++
  }

  console.log(`\nResults: ${passed}/${total} passed`)

  if (passed < total) {
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
