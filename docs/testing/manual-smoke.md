# Manual HTTP/SSE Smoke Test

This is a manual smoke test, not an automated suite. Run it against `npm run dev` with a real `.env.local`. The goal is to confirm that the entire data path from session creation to `buildStatus: 'ready'` works exactly as designed — no mocking, no stubs, real HTTP calls. The Playwright browser coverage lives in `tests/e2e/` and is run with `npm run test:e2e`.

You need: the dev server running, `curl`, `jq`, and a public GitHub repo URL. Set `GITHUB_TOKEN` for private repos or higher GitHub rate limits. The full build path additionally needs the Claude Code CLI and `ANTHROPIC_API_KEY`.

If `ELEVENLABS_WEBHOOK_SECRET` is set, the post-call curl request must include a valid `ElevenLabs-Signature`. Leave it unset for this unsigned local smoke test, or use the signing helper in `tests/e2e/helpers.ts`.

---

## Step 1 — Create a session

```bash
curl -s -X POST http://localhost:3000/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"repoUrl": "https://github.com/your-org/your-repo"}' | jq
```

Expected: `{"session": {...}, "capability": "..."}` with a UUID at `session.id`, `status: "active"`, `buildStatus: "idle"`, and empty `decisions`, `filesRead`, `openQuestions`. Copy both `session.id` and `capability` — you'll use them in every step below.

If this returns an error, stop. The session store or Zod validation is broken and nothing else will work.

---

## Step 2 — Open the SSE stream

In a second terminal, keep this running for the entire test. Every session mutation from here on should produce an event in this stream; read-only tools are expected to return without an SSE update.

```bash
curl -N "http://localhost:3000/api/sessions/<id>/events?capability=<capability>"
```

Expected on connect: one immediate `session_updated` event with the full session state. Leave this running.

---

## Step 3 — Exercise the tool webhooks

These simulate exactly what ElevenLabs calls during a conversation. Each mutating tool should produce a `session_updated` event in the SSE stream within a second.

**list_files**

```bash
curl -s -X POST http://localhost:3000/api/tools/list-files \
  -H "Content-Type: application/json" \
  -d '{"session_id": "<id>", "session_token": "<capability>", "path": ""}' | jq
```

Expected: a `files` array of `{ path, type }` entries. No session mutation — `list_files` doesn't write to the session, so no SSE event here.

**read_file**

```bash
curl -s -X POST http://localhost:3000/api/tools/read-file \
  -H "Content-Type: application/json" \
  -d '{"session_id": "<id>", "session_token": "<capability>", "path": "README.md"}' | jq
```

Expected: a `content` object with file contents and line metadata. SSE stream should fire a `session_updated` event with a new entry in `filesRead`.

**search_code**

```bash
curl -s -X POST http://localhost:3000/api/tools/search-code \
  -H "Content-Type: application/json" \
  -d '{"session_id": "<id>", "session_token": "<capability>", "query": "session", "max_results": 3}' | jq
```

Expected: array of matches. No session mutation, no SSE event.

**save_decision**

```bash
curl -s -X POST http://localhost:3000/api/tools/save-decision \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "<id>",
    "session_token": "<capability>",
    "summary": "Use Postgres for session storage",
    "rationale": "Existing infra already runs Postgres",
    "alternatives_considered": ["Redis", "SQLite"],
    "relevant_files": ["src/lib/session/store.ts", "src/lib/session/types.ts"]
  }' | jq
```

Expected: decision object with a UUID. SSE stream fires `session_updated` with the new decision in `decisions`. Check that `decisions[0].relevantFiles` has both files — this matters for the complexity gate later.

**flag_question**

```bash
curl -s -X POST http://localhost:3000/api/tools/flag-question \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "<id>",
    "session_token": "<capability>",
    "question": "Should we migrate existing data or start fresh?",
    "context": "Current store has in-memory sessions only"
  }' | jq
```

Expected: question object. SSE fires `session_updated` with the new entry in `openQuestions`.

**generate_spec**

```bash
curl -s -X POST http://localhost:3000/api/tools/generate-spec \
  -H "Content-Type: application/json" \
  -d '{"session_id": "<id>", "session_token": "<capability>"}' | jq
```

Expected: `specOutput` string — a markdown document. SSE fires `session_updated` with `specOutput` now set. This is the data signal that drives `SpecPreview` to switch to the spec view. Verify it's non-null and contains actual content.

---

## Step 4 — Verify session state

```bash
curl -s http://localhost:3000/api/sessions/<id> \
  -H "Authorization: Bearer <capability>" | jq
```

At this point the session should have: one entry in `filesRead`, one decision in `decisions`, one open question in `openQuestions`, `specOutput` set to a non-empty markdown string, and `buildStatus` set to `"ready"` because a generated spec is actionable.

If any of these are missing, the relevant tool webhook has a bug.

---

## Step 5 — Fire the post-call webhook

This simulates ElevenLabs calling your server after the conversation ends.

```bash
curl -s -X POST http://localhost:3000/api/agent/post-call \
  -H "Content-Type: application/json" \
  -d '{
    "type": "post_call_transcription",
    "data": {
      "metadata": {"call_duration_secs": 183},
      "transcript": [{"role": "agent", "message": "Alright, I have access to the repo.", "time_in_call_secs": 0}],
      "conversation_initiation_client_data": {
        "dynamic_variables": {"session_id": "<id>", "session_token": "<capability>"}
      }
    }
  }' | jq
```

Expected: `{"received": true}` with status 200. SSE stream fires `session_updated` with `buildStatus: "ready"`, `callDurationSecs: 183`, and `transcript` populated, then fires `call_ended`.

If `buildStatus` doesn't flip to `"ready"` here, the "Build it" button won't appear in the dashboard.

---

## Step 6 — Verify missing session_id handling

```bash
curl -s -X POST http://localhost:3000/api/agent/post-call \
  -H "Content-Type: application/json" \
  -d '{
    "type": "post_call_transcription",
    "data": {
      "metadata": {"call_duration_secs": 0},
      "transcript": [],
      "conversation_initiation_client_data": {"dynamic_variables": {}}
    }
  }' | jq
```

Expected: `200` with a silent ignored response. Must not return 4xx or 5xx: ElevenLabs retries on anything other than 200 and you'll get flooded.

---

## Step 7 — Trigger the build

First check the route guards work correctly.

```bash
# Returns 202 immediately; the complexity gate runs async and fires SSE events.
# (We flagged a question in Step 3, so the gate will block.)
curl -s -X POST http://localhost:3000/api/sessions/<id>/build \
  -H "Authorization: Bearer <capability>" \
  -H "Idempotency-Key: smoke-build-1" | jq
```

Expected: `202` accepted, then SSE fires `build_started` followed quickly by `build_blocked` with a `ComplexityAssessment` that has `blocked: true` and `blockReason: "open_questions"`. The `buildStatus` goes back to `"ready"` — not `"idle"`, not `"failed"`.

To test the happy path through Claude Code and PR creation, start a fresh session, repeat the steps without `flag_question`, and provide the required Claude Code, Anthropic, and GitHub credentials. This smoke test ends at `build_blocked` by design.

---

## Step 8 — Concurrency guard

Use a fresh session with no open questions. Start a build, then send a second POST before the first build finishes:

```bash
curl -s -X POST http://localhost:3000/api/sessions/<id>/build \
  -H "Authorization: Bearer <capability>" \
  -H "Idempotency-Key: smoke-build-2" | jq
```

Expected: `409` with `"Build already in progress"`. The blocked flow from Step 7 returns to `"ready"`, so it cannot test this guard.

---

## What passing looks like

Every step returns the right status code. The SSE stream fires an event within a second of each mutation. `buildStatus` transitions cleanly: `idle → ready → building → blocked/complete/failed`. The session object at the end has all the fields populated that the dashboard depends on. Nothing 500s.

If any step fails, fix it before moving on — the steps build on each other and a broken session store or SSE broadcast will produce confusing failures downstream.
