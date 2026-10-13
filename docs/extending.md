# Extending SpecVoice

Read [architecture](./architecture.md), the [glossary](../GLOSSARY.md), and the nearest implementation. Keep domain rules behind existing interfaces. Use memory for isolated tests; PostgreSQL for durable behavior.

## Adding an agent tool

Tools need three definitions: server registry, provider tool schema, and the agent's complete tool-ID list.

1. Register a kebab-case name in [tool-registry.ts](../src/lib/api/tool-registry.ts). The dynamic route dispatches registered names; no new route needed.
2. Use `createToolHandler` for Session operations or `createCodeToolHandler` for repository discovery. These handlers validate input and verify the active call's capability. The code handler also requires a ready or partial profile and supplies a pinned, scoped `CodeSource`.
3. Add the matching snake_case provider definition to `buildToolConfigs` in [tool-definitions.ts](../src/lib/agent/tool-definitions.ts). Reuse `SESSION_ID_PROP` and `SESSION_TOKEN_PROP`; the private call route issues these dynamic variables when each call starts. Check field names against the installed ElevenLabs SDK types.
4. Update [tool-name mapping](./agents/elevenlabs-tools.md), [system prompt](./system-prompt.md), and [API reference](./api-reference.md). Preserve completeness metadata on discovery results.
5. After testing, run `npm run setup:agent` with the intended provider configuration. This writes provider configuration: it upserts all definitions and replaces the agent's complete tool-ID list. Manually added provider tools are not preserved unless included in `buildToolConfigs`.

Registry example: bounded read through the shared code handler.

```typescript
toolRegistry.register(
  'read-config',
  createCodeToolHandler(z.object({ path: z.string() }), async (_session, source, input, request) => {
    const content = await source.readFile(input.path, undefined, undefined, { signal: request.signal })
    return NextResponse.json({ content })
  })
)
```

The registry already imports `z`, `NextResponse`, and shared handlers. Do not bypass `CodeSource` with direct filesystem access or unpinned GitHub requests. Scope and budgets must apply before repository work.

Session mutations must await methods from `getSessionRepository()`. Pass `session.currentCallId ?? undefined` to call-aware operations, as existing decision, file-read, question, and Spec tools do. The adapter rechecks call identity while persisting the mutation, preventing a stale request from changing a later call's Session. Do not import the memory singleton into production routes.

## Adding Session fields or events

- Define data in [session/types.ts](../src/lib/session/types.ts). Update initial values and behavior in both [store.ts](../src/lib/session/store.ts) and [postgres-repository.ts](../src/lib/session/postgres-repository.ts).
- Extend [SessionRepository](../src/lib/session/repository.ts) only when callers need a new operation. Persist state changes and associated events together; callers should not perform a separate broadcast after a database write.
- Use additive SQL migrations for durable schema changes. Preserve existing Session/event IDs and readable older records. Raw conversation copies must participate in [retention](./backups.md).
- Prefer the existing `session_updated` event for state changes. A new event also needs shared types, adapter persistence/replay, browser handling in [useSession.ts](../src/components/hooks/useSession.ts), and reference documentation. Keep SSE transport and replay sequencing in the existing event route.

## Verification

Test through the shared handler or repository interface: valid input, rejected capability, stale call, invalid input, scope denial, and applicable cancellation/completeness behavior. Use real PostgreSQL integration tests for transaction, event, lease, or receipt changes. Extend offline fixtures for new enforceable permissions or Build constraints.

Run `npm run verify`; run `npm run test:e2e` for browser or SSE changes and `npm run test:integration` against disposable PostgreSQL for durable changes. Provider setup and paid live evaluations remain separate from deterministic verification; see [evaluation](./evaluation.md).
