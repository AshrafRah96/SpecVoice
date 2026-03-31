---
name: specvoice-feature-01-agent-enrichment
description: Use when working on SpecVoice Feature 01 (ElevenLabs Agent Enrichment), the post-call webhook, agent config, session types, or anything touching BuildStatus, broadcastEvent, or transcript/callDurationSecs fields. Also use when an agent needs to update or query the ElevenLabs agent configuration.
---

## Overview

Feature 01 configures the ElevenLabs voice agent (voice, speech settings, first message, eval criteria) and adds the post-call webhook that transitions sessions from a call to the build pipeline.

## Key Files

- `src/lib/agent/config.ts` — agent configuration constants
- `src/scripts/setup-agent.ts` — run with `npx tsx` to create/update the agent
- `src/app/api/agent/post-call/route.ts` — post-call webhook handler
- `src/lib/session/types.ts` — canonical type declarations
- `tests/api/post-call.test.ts` — webhook tests

## Voice Settings

- Voice ID: `onwK4e9ZLuTAKqWW03F9` (Daniel)
- Stability: 0.7, Speed: 0.95
- Silence timeout: ~4 s, high interruption sensitivity
- First message: "Alright, I've got access to the repo. Give me a moment to look around, then tell me what we're building."
- Eval criteria: `spec_generated`, `assumptions_challenged`, `code_grounded`

**Field names must come from context7 or `node_modules/@elevenlabs/elevenlabs-js/dist/api/types/` — never from training data.**

## Post-Call Webhook

Route: `src/app/api/agent/post-call/route.ts`

- Reads `session_id` from `data.conversation_initiation_client_data.dynamic_variables.session_id`
- Updates session: `transcript`, `callDurationSecs`, `buildStatus: 'ready'`
- Broadcasts `call_ended` SSE event
- If `session_id` is missing: return HTTP 200 silently — **never return 4xx**, ElevenLabs retries on non-200 and will flood the server
- Signature verification is not implemented in v1; do not add it

## Session Types

Fields added to `src/lib/session/types.ts` by this feature:

```ts
callDurationSecs: number | null
transcript: string | null
buildStatus: BuildStatus  // 'idle' | 'ready' | 'building' | 'complete' | 'failed'
```

`broadcastEvent(sessionId, event)` is made public by this feature.

## Common Mistakes

1. **Guessing ElevenLabs field names.** Never write ElevenLabs config from training data. Always check `node_modules/@elevenlabs/elevenlabs-js/dist/api/types/` or context7 first. Silent config failures result.

2. **Adding `'assessing'` to BuildStatus.** The full union is `'idle' | 'ready' | 'building' | 'complete' | 'failed'`. The `'assessing'` value was cut as over-engineering. Using it causes a TypeScript error and runtime breakage.

3. **Redefining `broadcastEvent` in Feature 02.** Feature 01 already makes `broadcastEvent` public in the session store. Feature 02 must import and use it directly — never redeclare or shadow it.

4. **Returning 4xx when session_id is missing.** ElevenLabs retries any non-200 response, flooding the server. Return 200 with a log message when `session_id` is absent.

5. **Declaring `transcript` or `callDurationSecs` locally.** Both fields are declared in `src/lib/session/types.ts`. Import from there; never redeclare in route handlers or components.
