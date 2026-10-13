---
name: specvoice-feature-01-agent-enrichment
description: Use when changing the private ElevenLabs agent configuration, call identity, signed post-call receipt processing, or transcript finalization.
---

# Voice and completion work

1. Read `src/lib/agent/config.ts` and the installed SDK declarations before changing provider fields. Use `npm run setup:agent` only for an explicitly authorized provider update; the complete tool-ID list replaces the old list. Completion: payload names match the installed SDK and private authentication stays enabled.
2. Start calls through the operator-authenticated call route. Keep fresh signed URLs, Session capabilities and call IDs out of logs. Completion: old or expired calls cannot mutate a newer call's Session.
3. Post-call requests require HMAC outside isolated tests. Authenticate first, validate the relevant payload fields, and durably accept a receipt before returning success. Known irrelevant deliveries return `200`; signature failures return `401`, invalid JSON `400`, and unavailable configuration/storage `503`. See `docs/api-reference.md`.
4. Let the post-call queue finalize Call, Session, ordered events and receipt/job completion in one transaction. Preserve lease and current-call fencing. Keep the server-owned transcript origin so retries cannot restart retention. Completion: duplicates and stale workers cannot finalize twice or resurrect expired transcript copies.
5. Exercise the real route and repository interfaces with focused tests, then `npm run verify`. Persistence changes also require real PostgreSQL tests; call UI changes require Playwright. Provider simulations remain separate paid checks.

Canonical types live in `src/lib/session/types.ts`. Runtime settings live in `src/lib/agent/config.ts`; avoid copying voice IDs, enum values and timeouts here. Read `docs/agents/elevenlabs-tools.md` for tool naming and `docs/agents/claude-code.md` for the separate post-call Build executor.
