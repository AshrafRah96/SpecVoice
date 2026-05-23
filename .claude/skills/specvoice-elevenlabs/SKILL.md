---
name: specvoice-elevenlabs
description: Use when writing any ElevenLabs code in SpecVoice — agent config, tool definitions, useConversation hook, post-call webhook, or SDK client calls. Use when unsure of field names, enum values, or method signatures. Use before creating or updating agents and tools.
---

## Core Rule

**Never write ElevenLabs code from training data. Field names and method signatures change frequently and training data is wrong.**

Sources of truth (in order):
1. `node_modules/@elevenlabs/elevenlabs-js/dist/api/types/*.d.ts` — canonical enum values
2. This skill — project-verified patterns
3. context7 `/elevenlabs/elevenlabs-js` — when you need something not covered here

The REST API uses `snake_case`. The JS SDK uses `camelCase`. Always use the SDK — never construct raw REST payloads.

---

## Imports

```typescript
// Agent config + tools
import {
  TtsConversationalModel, TurnEagerness, ClientEvent, Llm,
  LiteralJsonSchemaPropertyType, WebhookToolApiSchemaConfigInputMethod,
  ToolRequestModel,
} from '@elevenlabs/elevenlabs-js/api'

// SDK client
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'

// React hook (install @elevenlabs/react first)
import { useConversation } from '@elevenlabs/react'
```

---

## Agent Configuration

`src/lib/agent/config.ts` — `buildAgentConfig(appUrl, toolIds)` returns this shape:

```typescript
client.conversationalAi.agents.create({
  name: string,
  conversationConfig: {
    agent: {
      firstMessage: string,
      language: 'en',
      prompt: {
        prompt: systemPrompt,
        llm: Llm.ClaudeSonnet45,        // "claude-sonnet-4-5" — verify in Llm.d.ts
        toolIds: string[],              // REPLACEMENT — always pass full list
      },
    },
    tts: {
      voiceId: 'onwK4e9ZLuTAKqWW03F9', // Daniel
      modelId: TtsConversationalModel.ElevenFlashV2,
      stability: 0.7,
      similarityBoost: 0.8,
      speed: 0.95,
    },
    conversation: {
      clientEvents: [ClientEvent.Audio, ClientEvent.AgentResponse, ClientEvent.UserTranscript],
    },
    turn: {
      turnTimeout: 4,                   // seconds, range 1–30
      turnEagerness: TurnEagerness.Patient,  // waits for high turn-end probability
    },
  },
  platformSettings: {
    evaluation: {
      criteria: [
        { id: 'spec_generated', name: 'Spec Generated', conversationGoalPrompt: '...' },
      ],
    },
    dataCollection: {
      feature_name: { type: LiteralJsonSchemaPropertyType.String, description: '...' },
      decisions_count: { type: LiteralJsonSchemaPropertyType.Integer, description: '...' },
    },
  },
})
```

**Agent management methods:**
- `client.conversationalAi.agents.create(config)` → `{ agentId }`
- `client.conversationalAi.agents.update(agentId, config)`
- `client.conversationalAi.tools.create(toolConfig)` → `{ id }`
- `client.conversationalAi.tools.update(toolId, config)`
- `client.conversationalAi.tools.list()` → `{ tools: [...] }`

---

## Enum Quick Reference

```typescript
// LLM options — verify current values in Llm.d.ts before use
Llm.ClaudeSonnet45   // "claude-sonnet-4-5"
Llm.ClaudeSonnet46   // "claude-sonnet-4-6"
Llm.ClaudeHaiku45    // "claude-haiku-4-5"

// TTS models — ElevenTurboV2/V2_5 are deprecated
TtsConversationalModel.ElevenFlashV2        // "eleven_flash_v2" — default
TtsConversationalModel.ElevenFlashV25       // "eleven_flash_v2_5"
TtsConversationalModel.ElevenV3Conversational  // "eleven_v3_conversational"

// Turn eagerness
TurnEagerness.Patient  // waits for higher turn-end confidence
TurnEagerness.Normal
TurnEagerness.Eager

// Data collection types
LiteralJsonSchemaPropertyType.String   // "string"
LiteralJsonSchemaPropertyType.Integer  // "integer"
LiteralJsonSchemaPropertyType.Number   // "number"
LiteralJsonSchemaPropertyType.Boolean  // "boolean"
```

---

## Standalone Tool Definitions

Tools are **standalone entities** (not embedded in agent config). See `src/lib/agent/tool-definitions.ts`.

```typescript
// session_id is injected at runtime from dynamic variables
const SESSION_ID_PROP = {
  type: LiteralJsonSchemaPropertyType.String,
  dynamicVariable: 'session_id',   // ElevenLabs-specific extension to JSON Schema
} as const

const toolConfig: ToolRequestModel = {
  toolConfig: {
    type: 'webhook',
    name: 'read_file',
    description: '...',
    apiSchema: {
      url: `${appUrl}/api/tools/read-file`,
      method: WebhookToolApiSchemaConfigInputMethod.Post,
      requestBodySchema: {
        type: 'object',
        required: ['session_id', 'path'],
        properties: {
          session_id: SESSION_ID_PROP,
          path: { type: LiteralJsonSchemaPropertyType.String, description: '...' },
        },
      },
    },
  },
}
```

Tool webhook routes are dispatched via a single dynamic route: `src/app/api/tools/[name]/route.ts` → `toolRegistry.dispatch(name, req)` in `src/lib/api/tool-registry.ts`. The ElevenLabs-facing URLs remain `/api/tools/{name}` (e.g. `/api/tools/read-file`). All handlers receive `session_id` in the body and use it to look up the session.

---

## useConversation Hook (React)

```typescript
const conversation = useConversation({
  onConnect: () => {},
  onDisconnect: () => {},
  onStatusChange: ({ status }) => {},  // 'connected' | 'connecting' | 'disconnected'
  onModeChange: ({ mode }) => {},      // 'speaking' | 'listening'
})

// Start session
await conversation.startSession({
  agentId: process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID,
  connectionType: 'websocket',   // ← MUST be 'websocket'. 'webrtc' uses LiveKit v1 and drops.
  dynamicVariables: { session_id: session.id },
  overrides: { conversation: { textOnly: false } },
})

// State
conversation.status      // 'connected' | 'connecting' | 'disconnected'
conversation.isSpeaking  // boolean — agent is currently speaking

// End
await conversation.endSession()
```

---

## Post-Call Webhook

Configured in the **ElevenLabs dashboard** at `/app/agents/settings` (not via the create API). URL: `${appUrl}/api/agent/post-call`.

**Payload shape** (project-verified from `post-call/route.ts`):
```json
{
  "type": "post_call_transcription",
  "data": {
    "metadata": { "call_duration_secs": 123 },
    "transcript": [{ "role": "user", "message": "...", "time_in_call_secs": 0 }],
    "conversation_initiation_client_data": {
      "dynamic_variables": { "session_id": "sess_abc123" }
    }
  }
}
```

**Signature verification** (conditional — only when `ELEVENLABS_WEBHOOK_SECRET` is set):
```typescript
const sigHeader = req.headers.get('ElevenLabs-Signature')
await elevenlabs.webhooks.constructEvent(rawBody, sigHeader ?? '', secret)
// Throws on invalid — return 401. On success, payload is parsed.
```

**Response rules:**
- Missing `session_id`: return `200 { ignored: '...' }` — never 4xx
- Unknown session: return `200 { ignored: '...' }` — never 4xx
- Schema mismatch: return `200 { ignored: '...' }` — never 4xx
- **ElevenLabs retries any non-200 response and will flood the server**

---

## Common Mistakes

| # | Wrong | Correct |
|---|-------|---------|
| 1 | Write field names from training data | Check `.d.ts` files or this skill first |
| 2 | `connectionType: 'webrtc'` | `connectionType: 'websocket'` — WebRTC uses LiveKit v1, drops connections |
| 3 | `prompt.tools: [...]` in agent config | Tools are standalone; reference by `prompt.toolIds: string[]` |
| 4 | Pass partial `toolIds` list | Always pass the **complete** list — it's a replacement, not a merge |
| 5 | Return 4xx from post-call webhook | Return `200` for all business-logic failures — ElevenLabs retries on non-200 |
| 6 | `Llm.ClaudeSonnet45` → `"claude-sonnet-45"` | Actual value: `"claude-sonnet-4-5"` — always verify in `Llm.d.ts` |
| 7 | `setBuildStatus('error')` | `'error'` is not in `BuildStatus`. Use `'failed'` |
| 8 | Configure post-call webhook in `buildAgentConfig()` | It's dashboard-only — setup script prints the URL and manual instructions |
| 9 | `dynamicVariable: 'session_id'` vs `dynamic_variable` | SDK uses camelCase: `dynamicVariable` |
