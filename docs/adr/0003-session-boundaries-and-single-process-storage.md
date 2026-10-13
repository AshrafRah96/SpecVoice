> Storage decision superseded by [ADR 0004](./0004-local-first-durable-runtime.md). Dashboard capability authorization is superseded by [ADR 0005](./0005-private-operator-and-hostile-execution.md); call-bound capabilities remain for provider tools. The credential rationale below remains applicable. `SPECVOICE_ALLOW_IN_MEMORY_SESSIONS` is no longer supported; production requires PostgreSQL. The following records the historical decision.

# Bound session capabilities and require an explicit in-memory deployment mode

SpecVoice issues each session a short-lived HMAC capability and requires it for session reads, SSE, tool webhooks, and builds. Local repository paths must stay under `SPECVOICE_LOCAL_REPO_ROOT`, build starts are idempotent, and Git credentials use temporary askpass files rather than command arguments. The current `sessionStore` remains in memory for the local MVP, but production requests fail unless `SPECVOICE_ALLOW_IN_MEMORY_SESSIONS=true` is set deliberately; durable storage and shared events are the follow-up when multi-instance deployment is needed.

## Considered options

- Use session IDs alone: rejected because IDs appear in URLs and webhook payloads and would grant bearer access to repository content and build side effects.
- Put tokens in Git URLs: rejected because process listings and diagnostics can expose command arguments.
- Pretend the in-memory store is production-safe: rejected because restarts and multiple instances lose sessions and event listeners.
