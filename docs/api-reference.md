# API Reference

Routes use Next.js App Router handlers (`src/app/api/`). JSON except for SSE and Spec downloads. Operator login cookies protect Session reads and mutations, including SSE and Builds. Voice tool webhooks instead require a fresh call-bound `session_token` alongside `session_id`; ElevenLabs injects those dynamic variables. Signed post-call callbacks authenticate independently with HMAC.

Shared request/response types: [src/lib/session/types.ts](../src/lib/session/types.ts).

---

## Operator authentication

`POST /api/operator` accepts `{ "passphrase": "<local operator passphrase>" }` and sets an opaque HttpOnly, SameSite=Strict cookie lasting eight hours. HTTPS origins use Secure cookies. Failed logins return `401`; the shared login quota returns `429`. Session mutations require a same-origin request. `DELETE /api/operator` immediately revokes the cookie; accepted background work continues.

### `GET /api/sessions`

Returns `{ "sessions": [...], "next": "<cursor-or-null>" }`, with up to 20 summary records. Pass `?before=<next>` for the next page. Session URLs use `/?session=<id>`; no provider capability is stored in the URL.

### `POST /api/sessions/:id/call`

Requires operator login and a ready/partial profile matching the pinned commit. Returns `{ "callId": "<uuid>", "signedUrl": "<private provider URL>", "capability": "<60-minute call capability>", "maxDurationSecs": 2700 }` with `Cache-Control: no-store`. Pass `session_id`, `session_token` and `call_id` as voice dynamic variables. The signed URL and capability are credentials: do not log them.

An active call returns `409`, five starts within 15 minutes exhaust the per-Session quota (`429`), missing configuration/storage returns `503`, and failed provider startup returns `502`. Calls last at most 45 minutes; continuing a saved Session issues new credentials.

`DELETE` on the same route accepts `{ "callId": "<uuid>" }` to mark a disconnected call awaiting its transcript. `{ "callId": "<uuid>", "failed": true }` explicitly abandons an active or pending call; delayed callbacks cannot revive it. Saved Specs and decisions remain. Builds reject active/awaiting calls with `409`.

## Sessions

### `POST /api/sessions`

Pins an immutable repository commit, creates a Session, and starts asynchronous profiling. Returns 201 with the Session.

**Request body** (exactly one of `repoUrl` or `repoLocalPath` is required):

```json
{
  "repoUrl": "https://github.com/org/repo"
}
```

**Response `201`:**

```json
{
  "session": {
    "id": "sess_abc123",
    "repoUrl": "https://github.com/org/repo",
    "repositorySha": "<resolved-commit-sha>",
    "decisions": [],
    "openQuestions": [],
    "filesRead": [],
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

For a local source, use an absolute path below `SPECVOICE_LOCAL_REPO_ROOT`.

**Errors:** `400` if both or neither source is provided, if `repoUrl` is not a valid URL, if a local path is outside the configured root, or if its Git commit cannot be resolved. Local sources require committed Git content.

---

### `GET /api/sessions/:id`

Returns current Session state.

**Authentication:** operator login cookie.

**Response `200`:**

```json
{ "session": { ...Session } }
```

**Errors:** `404` if the session does not exist.

---

### `GET /api/sessions/:id/events`

Opens a Server-Sent Events stream until the client disconnects.

**Authentication:** operator login cookie, sent by same-origin `EventSource`. No capability query parameter is required. The stream closes when the login expires or is revoked.

Without a replay cursor, sends current Session state as `session_updated`; no initial `GET /api/sessions/:id` needed. Each message has an SSE `id`; send the last received value in the `Last-Event-ID` header after reconnecting to replay missed durable events. Native EventSource handles this automatically. Replay drains all pages; periodic polling recovers missed notifications.

**Response headers:**

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

**Event format:** Each message has an ordered `id` and a newline-delimited JSON object prefixed with `data: `.

```
id: 42
data: {"type":"session_updated","session":{...}}\n\n
```

Full catalog: [SSE Events](#sse-events).

---

### `POST /api/sessions/:id/build`

Starts the post-call build pipeline. Returns 202 immediately; background progress streams via SSE.

**Request body:** none required.

**Headers:** operator login cookie and `Idempotency-Key: <unique-build-attempt-key>`

**Response `202`:**

```json
{ "accepted": true, "replayed": false }
```

**Errors:**

| Status | Condition                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------- |
| `400`  | `session.specOutput` is absent — no spec to build from                                             |
| `401`  | Missing, expired or revoked operator login                                                         |
| `404`  | Session not found                                                                                  |
| `409`  | Profile is not ready, Scope Plan is not confirmed, or another build attempt is already in progress |

Profiles still `pending` or `indexing` return `409` until profiling finishes. `mid`, `large`, `very-large`, and every partial profile require a confirmed Scope Plan. Any existing proposed plan also blocks Build until confirmed.

`buildStatus` becomes `'building'` synchronously before the 202 response. Later SSE events arrive asynchronously.

A recovery-only retry uses the same route with `Content-Type: application/json` and `{ "retryAttemptId": "123" }`. It returns `202 { "accepted": true, "recoveryOnly": true }` only for an eligible failed publication attempt. It preserves the original commit, branch, and inputs; it never runs Claude. An ineligible or concurrent retry returns `409`. A new no-body Build request may generate code again and consumes model quota.

Gate logic and phases: [Build Pipeline](./build-pipeline.md).

### `POST /api/sessions/:id/profile`

Retries failed profiling at the Session's pinned commit; creation schedules the initial profile. Legacy unpinned Sessions resolve a commit on their first profile request. Returns `202` with the snapshot ID; the worker records `ready`, `partial`, or `failed` status.

```json
{ "accepted": true, "snapshotId": "snapshot-id", "status": "pending" }
```

### `GET /api/sessions/:id/profile`

Returns current Repository snapshot, profile, and Scope Plan.

### `POST /api/sessions/:id/scope`

Proposes a bounded Scope Plan after the profile is ready. Mid, large, very-large, and partially profiled repositories require at least one literal `includedRoots` path. File roots and directory roots are supported; traversal, absolute paths, and patterns are rejected.

```json
{
  "includedRoots": ["services/api"],
  "excludedRoots": ["services/api/generated"],
  "dependencyBoundaries": ["packages/shared"],
  "reason": "Implement the API change in one service"
}
```

Confirm a proposed plan with `{ "planId": "...", "confirm": true }`. The server inventories the selected scope and computes counts; client estimates are ignored. Empty or incomplete inventories return `409`. Saving changed paths creates a new proposal and invalidates the old confirmation. Profile/scope routes require the operator login cookie.

---

## Tool Webhooks

ElevenLabs calls these routes during conversations. They are not intended to be called directly from the dashboard or browser. All receive `session_id` and `session_token` in the request body (injected by the agent at runtime). Code discovery requires a ready or partial pinned Profile (`409` otherwise). Confirmed scope applies before work; per-operation budgets bound discovery before confirmation too.

### `POST /api/tools/list-files`

Lists repo files. No Session mutation or SSE event.

**Request body:**

```json
{
  "session_id": "sess_abc123",
  "session_token": "<short-lived-signed-capability>",
  "path": "src/components"
}
```

`path` is optional. Omit to list from the repo root.

**Response `200`:**

```json
{
  "files": [
    { "path": "src/components", "type": "dir" },
    { "path": "src/components/Dashboard.tsx", "type": "file" },
    { "path": "src/components/SessionControls.tsx", "type": "file" }
  ],
  "complete": true
}
```

---

### `POST /api/tools/read-file`

Reads a repo file. Capped at 4000 characters. Appends `FileRead` to `session.filesRead` and broadcasts `session_updated`.

**Request body:**

```json
{
  "session_id": "sess_abc123",
  "session_token": "<short-lived-signed-capability>",
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
    "lineCount": 50,
    "truncated": false
  }
}
```

**SSE emitted:** `session_updated` (with updated `filesRead` array).

---

### `POST /api/tools/search-code`

Searches the repo for a query string. No Session mutation or SSE event.

**Request body:**

```json
{
  "session_id": "sess_abc123",
  "session_token": "<short-lived-signed-capability>",
  "query": "broadcastEvent",
  "max_results": 20
}
```

`max_results` defaults to 20 and counts only permitted results. Listing and search add `complete`; when false, `stopReason` is `files`, `bytes`, `time`, `provider`, or `results`. Partial results are lower bounds, not proof of absence.

**Response `200`:**

```json
{
  "results": [
    {
      "path": "src/lib/session/store.ts",
      "lineNumber": 42,
      "lineContent": "broadcastEvent(sessionId, event)",
      "context": []
    }
  ],
  "complete": true
}
```

---

### `POST /api/tools/save-decision`

Records an architectural decision. Appends to `session.decisions` and broadcasts `session_updated`.

**Request body:**

```json
{
  "session_id": "sess_abc123",
  "session_token": "<short-lived-signed-capability>",
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

Records a question requiring resolution before Build. Appends to `session.openQuestions` and broadcasts `session_updated`.

**Request body:**

```json
{
  "session_id": "sess_abc123",
  "session_token": "<short-lived-signed-capability>",
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

Generates the PR spec from all decisions and file reads. Sets `session.specOutput` and `session.status = 'complete'`. Broadcasts `session_updated`.

**Request body:**

```json
{
  "session_id": "sess_abc123",
  "session_token": "<short-lived-signed-capability>"
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

ElevenLabs calls this after every conversation. Not called from the browser.

**Response policy:** Validly signed but irrelevant deliveries (unknown Session/call or unsupported payload shape) return `200` with an ignored reason. Invalid signatures return `401`, unparseable JSON returns `400`, and missing HMAC configuration or unavailable durable storage returns `503` so retryable failures are not acknowledged as stored.

**Request body** (subset — full payload has additional fields):

```json
{
  "type": "post_call_transcription",
  "data": {
    "conversation_id": "<provider conversation ID>",
    "metadata": {
      "call_duration_secs": 183
    },
    "transcript": [{ "role": "user", "message": "Let's add a caching layer", "time_in_call_secs": 12 }],
    "conversation_initiation_client_data": {
      "dynamic_variables": {
        "session_id": "sess_abc123",
        "call_id": "<call UUID>"
      }
    }
  }
}
```

Session routes use operator cookies. Only agent tool requests use the call-bound `session_token`. Signed callbacks use their own HMAC authentication; capability expiry does not reject a legitimate post-call delivery.

**Signature verification:** When `ELEVENLABS_WEBHOOK_SECRET` is set, the route verifies the `ElevenLabs-Signature` header using `elevenlabs.webhooks.constructEvent()`. Returns `401` on failure. Every non-test runtime refuses this path without the secret.

**On success** — records a durable Webhook receipt and queues finalization. In memory mode the same mutation runs inline for tests and local UI work; the Compose Worker applies it from PostgreSQL:

```json
{
  "status": "complete",
  "callDurationSecs": 183,
  "transcript": "[{\"role\":\"user\",...}]",
  "buildStatus": "ready"
}
```

The Worker atomically commits Call/Session changes, receipt/job completion and a dedicated `call_ended` event. Lease checks fence stale workers. A callback for an older call is retained without replacing a newer call’s Session state; failed/complete calls cannot finalize again. Replayed deliveries return `200` with `duplicate: true` and do not add a second job. The primary receipt identity is the provider delivery ID; when absent, the route uses provider, event type, conversation ID, event timestamp, and a SHA-256 body hash.

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

Event union: `SessionEvent` in [src/lib/session/types.ts](../src/lib/session/types.ts).

### `session_updated`

Fires after any Session mutation. Carries the full Session; no client diffing needed.

```json
{
  "type": "session_updated",
  "session": { ...Session }
}
```

Also fires on SSE connection open (current state snapshot).

**Fired by:** `read-file`, `save-decision`, `flag-question`, `generate-spec`, `post-call`, and build lifecycle mutations

---

### `call_ended`

Fires after post-call Session processing. Signals call completion without requiring dashboard consumers to diff `session.status`.

```json
{
  "type": "call_ended",
  "sessionId": "sess_abc123",
  "callDurationSecs": 183
}
```

`session_updated` fires immediately before it with updated Session state.

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
    "blockReason": "open_questions"
  }
}
```

`blockReason` is either `'too_large'` (≥ 100 files read) or `'open_questions'` (unresolved questions in the session). `splitSuggestion` (files grouped by top-level directory) is only populated when `blockReason === 'too_large'`.

---

## Types

Canonical types: [src/lib/session/types.ts](../src/lib/session/types.ts). Never redeclare these locally.

```typescript
type SessionStatus = 'active' | 'complete' | 'error'
type BuildStatus = 'idle' | 'ready' | 'building' | 'complete' | 'failed'
type BuildPhase = 'analyzing' | 'writing' | 'reviewing' | 'cloning' | 'pr'
```

> `'error'` is not a valid `BuildStatus`. Use `'failed'`. See [DX Audit](./DX-AUDIT.md).
