# API Reference

All routes are Next.js App Router handlers (`src/app/api/`). All request and response bodies are JSON. All tool webhook routes expect the request body to include `session_id` — this is injected automatically by the ElevenLabs agent at runtime via a `dynamicVariable` binding.

Shared types for all request/response shapes live in [src/lib/session/types.ts](../src/lib/session/types.ts).

---

## Sessions

### `POST /api/sessions`

Creates a new session. Returns 201 with the full session object.

**Request body** (one of `repoUrl` or `repoLocalPath` is required):

```json
{
  "repoUrl": "https://github.com/org/repo",
  "repoLocalPath": "/absolute/path/to/local/repo"
}
```

**Response `201`:**

```json
{
  "session": {
    "id": "sess_abc123",
    "repoUrl": "https://github.com/org/repo",
    "decisions": [],
    "openQuestions": [],
    "filesRead": [],
    "specOutput": null,
    "status": "active",
    "callDurationSecs": null,
    "transcript": null,
    "buildStatus": "idle",
    "prUrl": null,
    "complexityAssessment": null,
    "createdAt": "2026-03-31T10:00:00.000Z",
    "updatedAt": "2026-03-31T10:00:00.000Z"
  }
}
```

**Errors:** `400` if neither `repoUrl` nor `repoLocalPath` is provided, or if `repoUrl` is not a valid URL.

---

### `GET /api/sessions/:id`

Returns the current state of a session.

**Response `200`:**

```json
{ "session": { ...Session } }
```

**Errors:** `404` if the session does not exist.

---

### `GET /api/sessions/:id/events`

Opens a Server-Sent Events stream. The connection stays open until the client disconnects.

On connection, the server sends the current session state as a `session_updated` event so clients don't need to poll `GET /api/sessions/:id` first.

**Response headers:**

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

**Event format:** Each message is a newline-delimited JSON object prefixed with `data: `.

```
data: {"type":"session_updated","session":{...}}\n\n
```

See [SSE Events](#sse-events) for the full event catalog.

---

### `POST /api/sessions/:id/build`

Triggers the post-call build pipeline. Returns 202 immediately; the build runs in the background and streams progress via SSE.

**Request body:** none required.

**Response `202`:**

```json
{ "accepted": true }
```

**Errors:**

| Status | Condition |
|---|---|
| `400` | `session.specOutput` is null — no spec to build from |
| `404` | Session not found |
| `409` | `session.buildStatus === 'building'` — build already in progress |

`buildStatus` is set to `'building'` synchronously before the 202 is returned. Subsequent SSE events arrive asynchronously.

See [Build Pipeline](./build-pipeline.md) for gate logic and the full phase sequence.

---

## Tool Webhooks

These routes are called by the ElevenLabs agent during a conversation. They are not intended to be called directly from the dashboard or browser. All receive `session_id` in the request body (injected by the agent at runtime).

### `POST /api/tools/list-files`

Lists files in the repo. Does not mutate session state — no SSE event fires.

**Request body:**

```json
{
  "session_id": "sess_abc123",
  "path": "src/components"
}
```

`path` is optional. Omit to list from the repo root.

**Response `200`:**

```json
{
  "files": ["src/components/Dashboard.tsx", "src/components/SessionControls.tsx"]
}
```

---

### `POST /api/tools/read-file`

Reads a file from the repo. Capped at 4000 characters. Appends a `FileRead` entry to `session.filesRead` and broadcasts `session_updated`.

**Request body:**

```json
{
  "session_id": "sess_abc123",
  "path": "src/lib/session/types.ts",
  "start_line": 1,
  "end_line": 50
}
```

`start_line` and `end_line` are optional.

**Response `200`:**

```json
{
  "content": {
    "path": "src/lib/session/types.ts",
    "content": "export interface Session { ... }",
    "startLine": 1,
    "endLine": 50
  }
}
```

**SSE emitted:** `session_updated` (with updated `filesRead` array).

---

### `POST /api/tools/search-code`

Searches the repo for a query string. Does not mutate session state — no SSE event fires.

**Request body:**

```json
{
  "session_id": "sess_abc123",
  "query": "broadcastEvent",
  "max_results": 20
}
```

`max_results` defaults to 20.

**Response `200`:**

```json
{
  "results": [
    {
      "path": "src/lib/session/store.ts",
      "line": 42,
      "content": "broadcastEvent(sessionId, event)"
    }
  ]
}
```

---

### `POST /api/tools/save-decision`

Records an architectural decision. Appends to `session.decisions` and broadcasts `session_updated`.

**Request body:**

```json
{
  "session_id": "sess_abc123",
  "summary": "Use SSE instead of WebSockets",
  "rationale": "Next.js App Router does not support WebSocket upgrade",
  "alternatives_considered": ["WebSockets", "polling"],
  "relevant_files": ["src/app/api/sessions/[id]/events/route.ts"]
}
```

`alternatives_considered` and `relevant_files` default to `[]`.

**Response `200`:**

```json
{
  "decision": {
    "id": "uuid",
    "summary": "...",
    "rationale": "...",
    "alternativesConsidered": [...],
    "relevantFiles": [...],
    "timestamp": "2026-03-31T10:00:00.000Z"
  }
}
```

**SSE emitted:** `session_updated` (with updated `decisions` array).

---

### `POST /api/tools/flag-question`

Records an open question that needs resolving before the build can proceed. Appends to `session.openQuestions` and broadcasts `session_updated`.

**Request body:**

```json
{
  "session_id": "sess_abc123",
  "question": "Should the cache use Redis or in-memory?",
  "context": "The session store currently uses globalThis"
}
```

`context` defaults to `""`.

**Response `200`:**

```json
{
  "question": {
    "id": "uuid",
    "question": "...",
    "context": "...",
    "timestamp": "2026-03-31T10:00:00.000Z"
  }
}
```

**SSE emitted:** `session_updated` (with updated `openQuestions` array).

> Open questions block the build pipeline. `POST /api/sessions/:id/build` returns 202, but the complexity gate emits `build_blocked` with `blockReason: 'open_questions'` and resets `buildStatus` to `'ready'`.

---

### `POST /api/tools/generate-spec`

Generates the PR spec from all accumulated decisions and file reads. Sets `session.specOutput` and `session.status = 'complete'`. Broadcasts `session_updated`.

**Request body:**

```json
{
  "session_id": "sess_abc123"
}
```

**Response `200`:**

```json
{
  "spec": "# PR Spec\n\n## Summary\n..."
}
```

**SSE emitted:** `session_updated` (with `specOutput` populated and `status: 'complete'`).

---

## Post-Call Webhook

### `POST /api/agent/post-call`

Called by ElevenLabs at the end of every conversation. Not called from the browser.

**Important:** This route returns `200` for all business-logic failures (missing `session_id`, unknown session, schema mismatch). ElevenLabs retries any non-200 response and will flood the server. Only `401` (invalid signature) and `400` (unparseable JSON) return non-200.

**Request body** (subset — full payload has additional fields):

```json
{
  "type": "post_call_transcription",
  "data": {
    "metadata": {
      "call_duration_secs": 183
    },
    "transcript": [
      { "role": "user", "message": "Let's add a caching layer", "time_in_call_secs": 12 }
    ],
    "conversation_initiation_client_data": {
      "dynamic_variables": {
        "session_id": "sess_abc123"
      }
    }
  }
}
```

**Signature verification:** When `ELEVENLABS_WEBHOOK_SECRET` is set, the route verifies the `ElevenLabs-Signature` header using `elevenlabs.webhooks.constructEvent()`. Returns `401` on failure.

**On success** — updates the session in a single `updateSession` call (one broadcast):

```json
{
  "status": "complete",
  "callDurationSecs": 183,
  "transcript": "[{\"role\":\"user\",...}]",
  "buildStatus": "ready"
}
```

Then emits a dedicated `call_ended` SSE event.

**Response `200`:**

```json
{ "received": true }
```

**Graceful no-ops (all return `200`):**

```json
{ "ignored": "missing session_id" }
{ "ignored": "unknown session" }
{ "ignored": "unexpected payload shape" }
```

---

## SSE Events

All events arrive on `GET /api/sessions/:id/events` as `data: <JSON>\n\n` messages.

The TypeScript union for all events is `SessionEvent` in [src/lib/session/types.ts](../src/lib/session/types.ts).

### `session_updated`

Fires after any session mutation. Carries the full session object — no diffing required on the client.

```json
{
  "type": "session_updated",
  "session": { ...Session }
}
```

Also fires on SSE connection open (current state snapshot).

**Fired by:** `read-file`, `save-decision`, `flag-question`, `generate-spec`, `post-call`, `build` (on completion/failure)

---

### `call_ended`

Fires after the post-call webhook processes a session. A dedicated signal so dashboard consumers know the call finished without having to diff `session.status`.

```json
{
  "type": "call_ended",
  "sessionId": "sess_abc123",
  "callDurationSecs": 183
}
```

`session_updated` fires immediately after with the fully updated session state.

---

### `build_started`

Fires synchronously when `POST /api/sessions/:id/build` is called (before the 202 response).

```json
{
  "type": "build_started",
  "sessionId": "sess_abc123"
}
```

---

### `build_progress`

Fires once per build phase. `BuildPhase` values: `'analyzing' | 'writing' | 'reviewing' | 'cloning' | 'pr'`.

```json
{
  "type": "build_progress",
  "phase": "analyzing",
  "detail": "Parsing spec decisions and identifying affected modules"
}
```

---

### `build_complete`

Fires when the build succeeds. `session_updated` carries the updated `buildStatus: 'complete'` and `prUrl`.

```json
{
  "type": "build_complete",
  "sessionId": "sess_abc123",
  "prUrl": "https://github.com/org/repo/pull/42"
}
```

---

### `build_failed`

Fires when the build errors. `session_updated` carries `buildStatus: 'failed'`.

```json
{
  "type": "build_failed",
  "sessionId": "sess_abc123",
  "error": "Clone failed: repository not found"
}
```

---

### `build_blocked`

Fires when the complexity gate rejects the build. `buildStatus` resets to `'ready'`; the spec still exists.

```json
{
  "type": "build_blocked",
  "sessionId": "sess_abc123",
  "assessment": {
    "fileCount": 12,
    "openQuestionCount": 1,
    "lineEstimate": 600,
    "size": "medium",
    "blocked": true,
    "blockReason": "open_questions",
    "splitSuggestion": null
  }
}
```

`blockReason` is either `'too_large'` (≥ 100 files read) or `'open_questions'` (unresolved questions in the session). `splitSuggestion` (files grouped by top-level directory) is only populated when `blockReason === 'too_large'`.

---

## Types

The canonical type definitions are in [src/lib/session/types.ts](../src/lib/session/types.ts). Never redeclare these locally.

```typescript
type SessionStatus = 'active' | 'complete' | 'error'
type BuildStatus   = 'idle' | 'ready' | 'building' | 'complete' | 'failed'
type BuildPhase    = 'analyzing' | 'writing' | 'reviewing' | 'cloning' | 'pr'
```

> `'error'` is not a valid `BuildStatus`. Use `'failed'`. This is a common mistake — see [DX Audit](./DX-AUDIT.md).
