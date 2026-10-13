# DX Audit

Historical findings from the first development cycle. Current operation lives in the [documentation map](./README.md); resolved items below retain their rationale.

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

**What we'd change:** Automate step 3 via the ElevenLabs API (webhook update is supported) so `setup-agent.ts` handles all three ElevenLabs-side updates in one command. Until then, step 3 is documented prominently in the [manual acceptance runbook](testing/manual-smoke.md).

---

### Two agent IDs — resolved

The browser now receives a private signed URL from the authenticated call route. Only server-side `ELEVENLABS_AGENT_ID` remains; no public agent ID is needed. See [private call authentication](api-reference.md#post-apisessionsidcall).

---

### Signature verification — resolved

Production now returns `503` for post-call requests when the HMAC secret is missing, and `401` for an invalid signature. Only isolated tests may omit the secret. `.env.local.example` includes the variable; isolated E2E always signs fixtures.

---

## Silent failures

These are the failure modes that produce no error, just wrong behavior:

### Wrong camelCase vs snake_case in ElevenLabs SDK calls

The REST API reference uses `snake_case` throughout. The JS SDK uses `camelCase`. They're not cross-referenced anywhere in the ElevenLabs docs. Writing `model_id` instead of `modelId` compiles fine. The field is ignored.

**Impact:** Agent config changes don't take effect. Voice settings reset to defaults. The LLM model ignores your setting.

**Fix:** Always write agent config from the TypeScript `.d.ts` files in `node_modules/@elevenlabs/elevenlabs-js/dist/api/types/`, never from the REST API reference. See [elevenlabs-sdk-holes.md §7](./elevenlabs-sdk-holes.md).

---

### Dashboard breaks silently when a mutation doesn't broadcast

Use the Session repository interface for mutations. PostgreSQL commits Session state and events together. Post-call receipt completion shares that transaction, so rollback does not leave a finalized receipt without its events.

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

Every agent unit test fails with `"Missing required dynamic variables: {'session_id', 'session_token'}"` regardless of whether the test uses tools. The validation runs for all test types. The docs don't mention this.

**Fix:** Add `dynamicVariables: { session_id: 'unit-test-session', session_token: 'test-capability' }` to every test spec. Full details in [elevenlabs-sdk-holes.md §2](./elevenlabs-sdk-holes.md).

### The complexity gate always blocks the smoke test

The E2E smoke test fires `flag_question` in step 3 to verify open questions work. When `POST /api/sessions/:id/build` is called in step 7, the gate blocks immediately with `build_blocked: open_questions`. First-time readers of the test assume this is a failure — it's intentional and documented in [manual smoke test](./testing/manual-smoke.md), but it's non-obvious.

---

## What went well

**SSE over WebSockets.** The decision to use Server-Sent Events is correct for this stack. Next.js App Router doesn't support WebSocket upgrade, and SSE + `ReadableStream` + `TransformStream` works within that constraint. Dashboard updates are live, replay and backpressure are covered by interface tests.

**Standalone tool entities.** ElevenLabs tools are separate API resources from agents — they're created independently, then referenced by ID in the agent config. This was initially confusing (the REST API reference implies inline tool definitions) but ends up cleaner: tools can be updated without touching the agent config, and `setup-agent.ts` handles idempotent upserts separately for tools and the agent.

**`globalThis` for singletons.** Using `globalThis` for the memory adapters, test source registry, and runtime PostgreSQL pool (rather than module-level variables) survives Next.js hot reloads. The pattern is documented in `CLAUDE.md` and should be followed for any future process-level singleton.

**`elevenlabs-sdk-holes.md`.** Maintaining a running log of undocumented SDK behaviors during development paid off: it became the reference that lets Claude Code work on this codebase without repeating mistakes. It's also publishable content: every item is a documentation gap that affects any developer building on ElevenLabs Conversational AI.
