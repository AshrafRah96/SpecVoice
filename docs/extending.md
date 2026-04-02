# Extending SpecVoice

How to add new capabilities to the agent. The most common extension is a new tool: a webhook the agent can call during a conversation to do something with the repo or session.

Before reading this, skim [architecture.md](./architecture.md) — particularly the sections on tool entities and `session_id` routing.

---

## Adding a new agent tool

A tool has three parts that must all be in sync:

1. **The route** — handles the webhook call from ElevenLabs
2. **The tool definition** — tells ElevenLabs the tool's name, description, and parameter schema
3. **The agent config** — references the tool by ID so the agent can use it

`setup-agent.ts` wires parts 2 and 3 together. You own part 1.

---

### Step 1: Create the route

Create `src/app/api/tools/<your-tool-name>/route.ts`. Follow the existing routes exactly. They're consistent for a reason.

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { sessionStore } from '@/lib/session/store'
import { parseRequestBody, sessionNotFound, validationError } from '@/lib/api/helpers'

// Define your input schema. session_id is always required.
const schema = z.object({
  session_id: z.string(),
  // your additional parameters here
  target: z.string(),
})

export async function POST(request: NextRequest) {
  const body = await parseRequestBody(request)
  if (body === null) return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })

  const result = schema.safeParse(body)
  if (!result.success) return validationError(result.error.issues)
  const { session_id, target } = result.data

  const session = sessionStore.getSession(session_id)
  if (!session) return sessionNotFound(session_id)

  // Do your work here.
  const output = await doSomething(target)

  // If your tool mutates session state, use updateSession — it auto-broadcasts session_updated.
  // sessionStore.updateSession(session_id, { someField: newValue })

  return NextResponse.json({ output })
}
```

**Rules:**
- Use `@/` path alias for all imports — never relative paths from `src/lib/` to `src/app/`
- Validate with Zod. Trust nothing from the incoming webhook body
- If the tool mutates session state, use `sessionStore.updateSession()` — it broadcasts `session_updated` automatically
- If the tool only reads (like `list_files` or `search_code`), no broadcast is needed
- Return specific, actionable error messages — not `"Something went wrong"`

---

### Step 2: Define the tool

Open [src/lib/agent/tool-definitions.ts](../src/lib/agent/tool-definitions.ts) and add your tool definition.

**Before writing anything**, check the field names in `node_modules/@elevenlabs/elevenlabs-js/dist/api/types/`. The REST API reference uses `snake_case`; the SDK uses `camelCase`. Getting this wrong produces no error; the field is ignored. See [elevenlabs-sdk-holes.md §7](./elevenlabs-sdk-holes.md).

```typescript
import {
  LiteralJsonSchemaPropertyType,
  WebhookToolApiSchemaConfigInputMethod,
  ToolRequestModel,
} from '@elevenlabs/elevenlabs-js/api'

// session_id is always injected at runtime — never ask the agent to supply it
const SESSION_ID_PROP = {
  type: LiteralJsonSchemaPropertyType.String,
  dynamicVariable: 'session_id',
} as const

export function buildYourToolDefinition(appUrl: string): ToolRequestModel {
  return {
    toolConfig: {
      type: 'webhook',
      name: 'your_tool_name',          // snake_case, matches what the agent calls
      description: 'One sentence. What does this tool do and when should the agent use it?',
      apiSchema: {
        url: `${appUrl}/api/tools/your-tool-name`,
        method: WebhookToolApiSchemaConfigInputMethod.Post,
        requestBodySchema: {
          type: 'object',
          required: ['session_id', 'target'],
          properties: {
            session_id: SESSION_ID_PROP,
            target: {
              type: LiteralJsonSchemaPropertyType.String,
              description: 'What this parameter is and what format it expects.',
            },
          },
        },
      },
    },
  }
}
```

**Important:** Every property in `requestBodySchema` — including array `items` — must have one of `description`, `dynamicVariable`, `isSystemProvided`, or `constantValue` set. A bare `{ type: 'string' }` returns HTTP 400. See [elevenlabs-sdk-holes.md §4](./elevenlabs-sdk-holes.md).

---

### Step 3: Register the tool in setup-agent.ts

Open [src/scripts/setup-agent.ts](../src/scripts/setup-agent.ts). The script maintains a list of tool builder functions. Add yours:

```typescript
import { buildYourToolDefinition } from '@/lib/agent/tool-definitions'

// In the tools array passed to upsertTools():
buildYourToolDefinition(appUrl),
```

The script does an idempotent upsert: it creates the tool if it doesn't exist, updates it if it does, then updates the agent config with the complete `toolIds` list.

> `toolIds` is a **replacement**, not a merge. The setup script always passes the full list. If you manually add a tool to the agent in the ElevenLabs dashboard, `setup-agent.ts` will overwrite it. Keep the script as the single source of truth.

---

### Step 4: Re-run setup

```bash
npx tsx src/scripts/setup-agent.ts
```

This creates/updates the tool in ElevenLabs and updates the agent's `toolIds`. You don't need to update `ELEVENLABS_AGENT_ID` — the agent already exists, it just gets new tools.

---

### Step 5: Update the system prompt (if needed)

If the agent should understand when and how to use the new tool, update [docs/system-prompt.md](./system-prompt.md). The prompt is loaded at runtime by [src/lib/agent/system-prompt.ts](../src/lib/agent/system-prompt.ts).

Write the description the way you'd explain it to a senior engineer: what the tool does, what information it needs, and in what situations they should reach for it.

---

### Step 6: Add it to the API reference

Document the new route in [docs/api-reference.md](./api-reference.md) under **Tool Webhooks**. Include: method, URL, request body, response, and whether it emits an SSE event.

---

## Adding a new SSE event type

If your tool needs to push a new event type to the dashboard (beyond `session_updated`):

1. Add the new event to the `SessionEvent` union in [src/lib/session/types.ts](../src/lib/session/types.ts)
2. Broadcast it with `sessionStore.broadcastEvent(sessionId, { type: 'your_event', ... })`
3. Handle it in [src/components/hooks/useSession.ts](../src/components/hooks/useSession.ts)
4. Document it in [docs/api-reference.md](./api-reference.md)

Prefer `session_updated` for state changes; it already carries the full session. Only add a new event type when you need a signal that doesn't map to a session mutation (like `call_ended` or `build_started`).

---

## Adding a new session field

If your tool needs to store new data on the session:

1. Add the field to the `Session` interface in [src/lib/session/types.ts](../src/lib/session/types.ts)
2. Initialise it in `sessionStore.createSession()` in [src/lib/session/store.ts](../src/lib/session/store.ts)
3. Update it via `sessionStore.updateSession(sessionId, { yourField: value })` — this broadcasts automatically

Never redeclare session fields locally in route handlers or components. Always import from `src/lib/session/types.ts`.

---

## What doesn't need to change

When adding a tool, you do **not** need to:

- Touch the webhook signature verification logic (`post-call/route.ts`)
- Modify the SSE stream handler (`events/route.ts`)
- Change anything in the dashboard unless you're adding a new UI for the new data
- Add a new `ELEVENLABS_*` env variable — the agent ID and API key are shared across all tools
