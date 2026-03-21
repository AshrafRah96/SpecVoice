import { loadEnvConfig } from '@next/env'

// Load .env.local before env.ts runs its Zod validation — static imports are
// hoisted so env.ts would throw before any code ran. Dynamic imports fix this.
loadEnvConfig(process.cwd())

async function main() {
  const { env } = await import('@/lib/env')
  const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js')
  const { buildAgentConfig, getPostCallWebhookUrl } = await import('@/lib/agent/config')
  const { buildToolConfigs } = await import('@/lib/agent/tool-definitions')

  const client = new ElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY })

  // Step 1: List existing standalone tools so we can upsert by name rather than
  // creating duplicates on every setup run.
  const existingToolsResponse = await client.conversationalAi.tools.list()
  const toolsByName = new Map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (existingToolsResponse.tools ?? []).map((t: any) => [t.toolConfig?.name ?? t.tool_config?.name, t.id])
  )

  // Step 2: Create or update each tool, collect IDs.
  // toolIds must be the complete list — passing a partial list to agents.update() would
  // silently remove any tool whose ID is absent. Build the full list here every run.
  const toolIds: string[] = []
  for (const config of buildToolConfigs(env.NEXT_PUBLIC_APP_URL)) {
    if (config.toolConfig.type !== 'webhook') continue
    const name = config.toolConfig.name
    const existingId = toolsByName.get(name)

    if (existingId) {
      await client.conversationalAi.tools.update(existingId, config)
      console.log(`Updated tool: ${name} (${existingId})`)
      toolIds.push(existingId)
    } else {
      const result = await client.conversationalAi.tools.create(config)
      console.log(`Created tool: ${name} (${result.id})`)
      toolIds.push(result.id)
    }
  }

  // Step 3: Create or update the agent with the full tool ID list.
  const agentConfig = buildAgentConfig(env.NEXT_PUBLIC_APP_URL, toolIds)

  if (env.ELEVENLABS_AGENT_ID) {
    await client.conversationalAi.agents.update(env.ELEVENLABS_AGENT_ID, agentConfig)
    console.log(`Updated agent: ${env.ELEVENLABS_AGENT_ID}`)
  } else {
    const result = await client.conversationalAi.agents.create(agentConfig)
    console.log(`Created agent. Add to .env.local:\nELEVENLABS_AGENT_ID=${result.agentId}`)
  }

  const webhookUrl = getPostCallWebhookUrl(env.NEXT_PUBLIC_APP_URL)
  console.log(`
ACTION REQUIRED: Configure post-call webhook in ElevenLabs dashboard.
  URL: ${webhookUrl}
  Dashboard: https://elevenlabs.io/app/agents/settings
`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
