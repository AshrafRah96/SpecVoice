# DX Audit

Where SpecVoice's developer experience is rough, what caused it, and what to do differently. Based on the first development cycle.

The ElevenLabs-specific findings are in [elevenlabs-sdk-holes.md](./elevenlabs-sdk-holes.md), nine undocumented SDK behaviors found through trial and error. This document covers setup and integration friction.

---

## Setup friction

### The ngrok dance

Getting webhooks working locally requires a tunnel, and ElevenLabs bakes your tunnel URL into the agent config at setup time. Every time ngrok restarts (free tier issues a new URL on restart), you need to:

1. Update `NEXT_PUBLIC_APP_URL` in `.env.local`
2. Re-run `npx tsx src/scripts/setup-agent.ts`
3. Manually update the post-call webhook URL in the ElevenLabs dashboard (this one isn't automated)
4. Restart the dev server

That's four steps for a transient infra event. The post-call webhook is the most important path in the system and it's the one most likely to silently break after a restart.

**What we'd change:** Automate step 3 via the ElevenLabs API (webhook update is supported) so `setup-agent.ts` handles all three ElevenLabs-side updates in one command. Until then, step 3 is documented prominently in the [README Troubleshooting section](../README.md#troubleshooting).

---

### Two agent IDs in `.env.local`

`ELEVENLABS_AGENT_ID` and `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` hold the same value. One is read server-side (by `setup-agent.ts` and the post-call route), the other is exposed to the browser for the `useConversation` hook. Next.js's `NEXT_PUBLIC_` prefix is required for browser access — there's no way around this with the App Router.

It's a confusing duplicate. The README calls it out so developers don't wonder why there are two.

---

### Signature verification is conditional

`ELEVENLABS_WEBHOOK_SECRET` is optional — the server runs without it and silently skips signature verification. This makes local development easier (no HMAC setup) but means it's easy to ship to production without it.

**Recommendation:** Make verification non-optional in production. Add a check in the post-call route that returns 500 during startup if `NODE_ENV === 'production'` and the secret is missing.

---

## Silent failures

These are the failure modes that produce no error, just wrong behavior:

### Wrong camelCase vs snake_case in ElevenLabs SDK calls

The REST API reference uses `snake_case` throughout. The JS SDK uses `camelCase`. They're not cross-referenced anywhere in the ElevenLabs docs. Writing `model_id` instead of `modelId` compiles fine. The field is ignored.

**Impact:** Agent config changes don't take effect. Voice settings reset to defaults. The LLM model ignores your setting.

**Fix:** Always write agent config from the TypeScript `.d.ts` files in `node_modules/@elevenlabs/elevenlabs-js/dist/api/types/`, never from the REST API reference. See [elevenlabs-sdk-holes.md §7](./elevenlabs-sdk-holes.md).

---

### Dashboard breaks silently when a mutation doesn't broadcast

Every `sessionStore.updateSession()` call automatically broadcasts `session_updated`. But `setBuildStatus()`, `setComplexityAssessment()`, and other targeted mutators do not. If you call one without a subsequent `broadcastEvent()`, the session state changes server-side but the dashboard never updates.

There's no error. The UI shows stale data.

**Fix:** Every mutation that should update the dashboard must either use `updateSession()` (which auto-broadcasts) or explicitly call `broadcastEvent()` after. This is enforced by convention, not by the type system. A wrapper that makes the broadcast non-optional would close the gap.

---

### `connectionType: 'webrtc'` drops the connection

The `useConversation` hook accepts `connectionType: 'webrtc'` without error. It attempts the connection, the LiveKit v1 RTC path fails, and the call drops. The default is not documented as broken.

**Fix:** Always use `connectionType: 'websocket'`. This is enforced in the ElevenLabs skill and recorded in project memory. See [elevenlabs-sdk-holes.md](./elevenlabs-sdk-holes.md) for the investigation.

---

### Tool webhooks that don't mutate session state fire no SSE

`list_files` and `search_code` have no side effects, so they don't broadcast. A developer adding a new tool who doesn't realise this pattern exists will wonder why the dashboard isn't updating after their tool call. This is documented in [api-reference.md](./api-reference.md) but worth calling out here as a DX gotcha.

---

## Testing friction

### ElevenLabs unit tests require `dynamicVariables` even for non-tool tests

Every agent unit test fails with `"Missing required dynamic variables: {'session_id'}"` regardless of whether the test uses tools. The validation runs for all test types. The docs don't mention this.

**Fix:** Add `dynamicVariables: { session_id: 'unit-test-session' }` to every test spec. Full details in [elevenlabs-sdk-holes.md §2](./elevenlabs-sdk-holes.md).

### The complexity gate always blocks the smoke test

The E2E smoke test fires `flag_question` in step 3 to verify open questions work. When `POST /api/sessions/:id/build` is called in step 7, the gate blocks immediately with `build_blocked: open_questions`. First-time readers of the test assume this is a failure — it's intentional and documented in [docs/plans/06-e2e-critical-path.md](./plans/06-e2e-critical-path.md), but it's non-obvious.

---

## What went well

**SSE over WebSockets.** The decision to use Server-Sent Events is correct for this stack. Next.js App Router doesn't support WebSocket upgrade, and SSE + `ReadableStream` + `TransformStream` works within that constraint. Dashboard updates are live, the implementation is ~40 lines, and it has no external dependency.

**Standalone tool entities.** ElevenLabs tools are separate API resources from agents — they're created independently, then referenced by ID in the agent config. This was initially confusing (the REST API reference implies inline tool definitions) but ends up cleaner: tools can be updated without touching the agent config, and `setup-agent.ts` handles idempotent upserts separately for tools and the agent.

**`globalThis` for singletons.** Using `globalThis` for the `SessionStore` and `CodeSource` cache (rather than module-level variables) survives Next.js hot reloads. The pattern is documented in `CLAUDE.md` and should be followed for any future process-level singleton.

**`elevenlabs-sdk-holes.md`.** Maintaining a running log of undocumented SDK behaviors during development paid off: it became the reference that lets Claude Code work on this codebase without repeating mistakes. It's also publishable content: every item is a documentation gap that affects any developer building on ElevenLabs Conversational AI.
