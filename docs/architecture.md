# Architecture

How SpecVoice is structured and why.

For the what (file tree, stack, commands) see the [README](../README.md). This document covers the non-obvious decisions.

---

## The core data flow

```
Browser tab
  │
  ├─ POST /api/sessions          → creates session, returns ID
  ├─ GET  /api/sessions/:id/events  → opens SSE stream (stays open)
  └─ useConversation (ElevenLabs SDK) → WebSocket to ElevenLabs

ElevenLabs Agent (Claude LLM + voice)
  └─ during the call, calls tool webhooks:
       POST /api/tools/{name}   → src/app/api/tools/[name]/route.ts
                                → toolRegistry.dispatch(name, req)
                                → src/lib/api/tool-registry.ts
       (tool names: list-files, read-file, search-code,
        save-decision, flag-question, generate-spec)

ElevenLabs platform (after the call)
  └─ POST /api/agent/post-call   → transitions session to buildStatus: 'ready'

Browser tab (user clicks "Build It")
  └─ POST /api/sessions/:id/build → 202, build runs in background, streams via SSE
```

Every tool webhook mutates the session via `SessionStore`, which broadcasts `session_updated` over SSE. The dashboard receives the update and re-renders — no polling, no page reload.

---

## Why SSE, not WebSockets

Next.js App Router (the version SpecVoice uses) does not support WebSocket upgrade on API routes. The underlying HTTP server that Next.js App Router runs on doesn't expose the raw socket in a way that's compatible with the `ws` upgrade handshake.

SSE over `ReadableStream` + `TransformStream` works natively within App Router constraints. The implementation is ~40 lines ([src/app/api/sessions/[id]/events/route.ts](../src/app/api/sessions/%5Bid%5D/events/route.ts)) with no external dependency. Since the dashboard only needs server-to-client push (the browser is the only one sending user intent — start call, trigger build — via normal POSTs), SSE is sufficient.

**Constraint to remember:** SSE is unidirectional. The browser cannot push back over the event stream. All browser-initiated actions go through separate `POST` requests.

---

## Why `globalThis` for singletons

Two singletons need to survive across the full process lifetime:

- `SessionStore` — holds all session state in memory
- `CodeSource` cache — caches `GitHub`/`Local` code source instances per session

Next.js hot-reloads module files during development. If these were module-level variables, every hot reload would reset the store and lose all session state. `globalThis` persists across module re-evaluations within the same Node.js process.

Both singletons follow this pattern:

```typescript
// Attach to globalThis once, reuse the existing instance on hot reload
const g = globalThis as typeof globalThis & { _sessionStore?: SessionStore }
if (!g._sessionStore) g._sessionStore = new SessionStore()
export const sessionStore = g._sessionStore
```

Any future process-level singleton (connection pools, file system caches, etc.) should follow the same pattern.

---

## Why no RAG, no embeddings, no vector database

The usual approach for "AI that understands a codebase" is: chunk the code, embed it, store it in a vector DB, retrieve relevant chunks at query time.

SpecVoice doesn't do this. The agent tools give Claude file access on demand — it calls `list_files` to orient, then `read_file` to read exactly what it needs, `search_code` to find usages. Claude 3.5/4 has enough context window and reasoning capability to navigate a codebase this way without pre-indexing.

Benefits:
- No indexing step, no vector DB to manage, no embedding costs
- Agent reads what's actually relevant to the current question, not what a similarity search thinks is relevant
- The audit trail (files read, decisions logged) is a first-class feature, not a side effect

Constraint: File reads are capped at 4000 characters. The agent must navigate deliberately — it can't dump an entire large file into context. This is intentional: it forces the spec to stay grounded in what the agent actually looked at, which is recorded in `session.filesRead`.

---

## Why ElevenLabs tools are standalone entities

The ElevenLabs API distinguishes between:
- **Tools** — standalone API resources, created via `client.conversationalAi.tools.create()`
- **Agent config** — references tools by their IDs in `prompt.toolIds`

This is unintuitive when you first read the docs (the REST API reference implies inline tool definitions). In practice it's cleaner:

- Tools can be updated independently of the agent config
- `setup-agent.ts` does an idempotent upsert: creates tools if they don't exist, updates them if they do, then updates the agent with the full `toolIds` list
- `toolIds` is always a complete replacement, not a merge — passing a partial list silently removes the omitted tools

Tool routing uses a single dynamic route — `src/app/api/tools/[name]/route.ts` — that reads the `name` path segment and calls `toolRegistry.dispatch(name, req)`. The registry is defined in `src/lib/api/tool-registry.ts`, which registers one handler per tool name and delegates shared session-lookup and Zod validation to `src/lib/api/tool-handler.ts`.

Three distinct responsibilities:

- **ElevenLabs tool config** (webhook URL, description, parameter schema as sent to ElevenLabs): `src/lib/agent/tool-definitions.ts`
- **Server handler logic** (session lookup, validation, side effects): `src/lib/api/tool-registry.ts`
- **Route dispatch** (thin adapter — reads `name`, calls registry): `src/app/api/tools/[name]/route.ts`

Never put handler logic in the route file, and never put ElevenLabs schema config in the registry.

---

## How `session_id` travels from browser to tool webhook

When a call starts, the browser calls `conversation.startSession()` with `dynamicVariables: { session_id: session.id }`. ElevenLabs stores this as a conversation variable.

Each tool definition has `session_id` wired with `dynamicVariable: 'session_id'` in its parameter schema:

```typescript
const SESSION_ID_PROP = {
  type: LiteralJsonSchemaPropertyType.String,
  dynamicVariable: 'session_id',
}
```

At call time, ElevenLabs injects the session ID into every outbound webhook request body automatically. The tool routes read it, look up the session, and do their work. The session ID never needs to be re-transmitted or managed by the agent's LLM reasoning — it's infrastructure-level routing.

This `dynamicVariable` field is an ElevenLabs extension to JSON Schema and is not documented in the server tools guide. See [elevenlabs-sdk-holes.md §9](./elevenlabs-sdk-holes.md) for the discovery.

---

## How the dashboard stays in sync

The `useSession` hook in [src/components/hooks/useSession.ts](../src/components/hooks/useSession.ts) is the single source of truth for dashboard state. It:

1. Opens an `EventSource` to `/api/sessions/:id/events`
2. Receives `session_updated` events and replaces the full session object in React state (no diffing)
3. Maintains a separate `buildLog` array (populated by `build_progress` events — these don't appear on the `Session` object)
4. Reconnects with exponential backoff on disconnect
5. Cleans up the `EventSource` on unmount

The critical rule: **`session_updated` carries all state**. Events like `call_ended`, `build_complete`, and `build_failed` are signals, not the authoritative state. The corresponding `session_updated` that fires immediately after is what actually updates the UI. This means dashboard consumers never need to diff events — they just use the latest session object.

---

## Code source abstraction

Two implementations of `CodeSource`:

- `GitHubCodeSource` — reads via Octokit; requires `GITHUB_TOKEN` for private repos
- `LocalCodeSource` — reads from `repoLocalPath` via the Node.js `fs` module

Both are resolved from session state via `resolveCodeSource(session)` in [src/lib/code/index.ts](../src/lib/code/index.ts). Route handlers never instantiate a code source directly.

All file listing applies `.gitignore` rules via the `ignore` npm package ([src/lib/code/ignore-rules.ts](../src/lib/code/ignore-rules.ts)). Never skip this filter or write custom glob matching.

---

## Build pipeline placement

The build pipeline runs strictly post-call. It is never triggered during a voice conversation. The timing constraint exists because:

1. The spec (`session.specOutput`) is only generated by `generate_spec`, which the agent calls at the end of the conversation
2. Running a multi-turn Claude Code CLI process during an active voice call would add unpredictable latency to webhook responses
3. The complexity gate (which reads `session.filesRead` and `session.openQuestions`) needs the complete call state

See [build-pipeline.md](./build-pipeline.md) for the current state of the implementation and the intended Claude Code CLI design.
