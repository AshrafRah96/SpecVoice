# Enrich Agent with ElevenLabs Platform Features

> Depends on: working agent creation (done), working tool webhooks (done)
> Blocked by: nothing
> Blocks: dashboard (needs client events), build system (needs buildStatus type and post-call webhook)

## Files

Modified: `src/lib/agent/config.ts`, `src/lib/session/types.ts`, `src/lib/session/store.ts`
Created: `src/app/api/agent/post-call/route.ts`, `tests/api/post-call.test.ts`

## Why

The agent works but it's running on defaults. Voice, turn-taking, monitoring, all stock. A DevRel engineer should know how to tune an agent for a specific use case and wire up the platform features that make it production-aware. This is the difference between "I got the API working" and "I understand the platform."

## What to build

### Voice and delivery

Daniel voice (`onwK4e9ZLuTAKqWW03F9`), stability 0.7, speed 0.95. Daniel because the persona is a direct, authoritative senior engineer. Stability keeps delivery consistent across long technical explanations without sounding robotic. Speed slightly below default sounds deliberate, not rushed. Document these choices in code comments because the tutorial will reference them.

### Turn-taking

This is a phone call. Developers pause mid-thought to work through a technical problem. Default silence timeout is too aggressive, set it to ~4 seconds. Interruption sensitivity high so the developer can cut in freely when the agent says something wrong.

Exact field names MUST come from context7. These change frequently and guessing means silent failures where the config is accepted but the feature doesn't activate.

### Evaluation criteria

Three criteria:

**spec_generated:** Did the conversation produce a spec? If not, the flow broke down somewhere.

**assumptions_challenged:** Did the agent push back at least once? A yes-machine isn't doing the senior engineer job.

**code_grounded:** Did the agent cite actual files and patterns from the codebase? Generic advice means the code-aware premise failed.

These feed into ElevenLabs analytics. During Day 4 prompt iteration I can filter conversations by which criteria scored poorly and listen to what went wrong.

### Data collection

Five structured fields extracted post-call: feature_name (string), decisions_count (number), open_questions_count (number), files_explored (number), conversation_outcome (string: spec_completed/abandoned/needs_followup).

This is the metadata that would feed product analytics in production. For the portfolio it shows I think about measurement.

### Post-call webhook

New route at `/api/agent/post-call`. When the call ends, ElevenLabs POSTs here.

The endpoint reads `session_id` from dynamic variables (passed when the client starts the conversation, echoed back in the webhook payload per ElevenLabs docs). Stores call duration and transcript on the session. Sets `buildStatus: 'ready'`. Broadcasts `call_ended` via SSE.

Missing session_id or unknown session: return 200 silently so ElevenLabs doesn't retry.

v1 skips webhook signature verification. TODO comment in code, noted in DX audit.

### Client events

Enable `agent_response` and `user_transcript`. The dashboard's live transcript panel needs these.

### First message

"Alright, I've got access to the repo. Give me a moment to look around, then tell me what we're building."

### Session type changes

Three new fields on Session: `callDurationSecs: number | null`, `transcript: string | null`, `buildStatus: BuildStatus`.

The `BuildStatus` type and the SSE discriminated union are shared with the build system feature. Define them now since they touch the same types file. This avoids a merge conflict later.

The full `BuildStatus` union is: `'idle' | 'ready' | 'building' | 'complete' | 'failed'`. Do not add `'assessing'` — it was cut from Feature 02 (see `04-feature-corrections.md`). Feature 01 defines the complete union so Feature 02 does not need to touch `types.ts` for this.

The store's private `broadcast` becomes public `broadcastEvent(sessionId, event)` to support the new event types.

## Constraints

All ElevenLabs field names come from context7. No exceptions. Don't guess.
Don't modify existing tool webhooks or the agent creation flow that works.
Don't add webhook signature verification in v1 (document the gap).
Don't test agent config changes with automated tests (requires a live account). Manual verification only.

## Done when

- Agent created via setup script shows voice settings, evaluation criteria, data collection fields, and post-call webhook URL in the ElevenLabs dashboard
- POST to `/api/agent/post-call` with a valid payload updates session with transcript, callDurationSecs, and buildStatus: 'ready'
- POST to `/api/agent/post-call` with missing session_id returns 200 with ignored message
- SSE endpoint broadcasts `call_ended` event when post-call webhook fires
- `npm run build` clean, `npm test` passes including new post-call webhook tests