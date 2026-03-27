# End-to-End Critical Path Test

This is a manual smoke test, not an automated suite. Run it against `npm run dev` with a real `.env.local`. The goal is to confirm that the entire data path from session creation to `buildStatus: 'ready'` works exactly as designed — no mocking, no stubs, real HTTP calls.

You need: the dev server running, `ELEVENLABS_API_KEY` and `GITHUB_TOKEN` set, and a public GitHub repo URL handy for the session.

---

## Step 1 — Create a session

```bash
curl -s -X POST http://localhost:3000/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"repoUrl": "https://github.com/your-org/your-repo"}' | jq
```

Expected: a session object with a UUID `id`, `status: "active"`, `buildStatus: "idle"`, and empty `decisions`, `filesRead`, `openQuestions`. Copy the `id` — you'll use it in every step below.

If this returns an error, stop. The session store or Zod validation is broken and nothing else will work.

---

## Step 2 — Open the SSE stream

In a second terminal, keep this running for the entire test. Every mutation from here on should produce an event in this stream.

```bash
curl -N http://localhost:3000/api/sessions/<id>/events
```

Expected on connect: one immediate `session_updated` event with the full session state. Leave this running.

---

## Step 3 — Exercise the tool webhooks

These simulate exactly what ElevenLabs calls during a conversation. Each one should produce a `session_updated` event in the SSE stream within a second.

**list_files**
```bash
curl -s -X POST http://localhost:3000/api/tools/list-files \
  -H "Content-Type: application/json" \
  -d '{"session_id": "<id>", "path": ""}' | jq
```
Expected: a file tree array. No session mutation — `list_files` doesn't write to the session, so no SSE event here.

**read_file**
```bash
curl -s -X POST http://localhost:3000/api/tools/read-file \
  -H "Content-Type: application/json" \
  -d '{"session_id": "<id>", "path": "README.md"}' | jq
```
Expected: file contents string. SSE stream should fire a `session_updated` event with a new entry in `filesRead`.

**search_code**
```bash
curl -s -X POST http://localhost:3000/api/tools/search-code \
  -H "Content-Type: application/json" \
  -d '{"session_id": "<id>", "query": "session", "maxResults": 3}' | jq
```
Expected: array of matches. No session mutation, no SSE event.

**save_decision**
```bash
curl -s -X POST http://localhost:3000/api/tools/save-decision \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "<id>",
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
    "question": "Should we migrate existing data or start fresh?",
    "context": "Current store has in-memory sessions only"
  }' | jq
```
Expected: question object. SSE fires `session_updated` with the new entry in `openQuestions`.

**generate_spec**
```bash
curl -s -X POST http://localhost:3000/api/tools/generate-spec \
  -H "Content-Type: application/json" \
  -d '{"session_id": "<id>"}' | jq
```
Expected: `specOutput` string — a markdown document. SSE fires `session_updated` with `specOutput` now set. This is the data signal that drives `SpecPreview` to switch to the spec view. Verify it's non-null and contains actual content.

---

## Step 4 — Verify session state

```bash
curl -s http://localhost:3000/api/sessions/<id> | jq
```

At this point the session should have: one entry in `filesRead`, one decision in `decisions`, one open question in `openQuestions`, `specOutput` set to a non-empty markdown string, and `buildStatus` still `"idle"`.

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
        "dynamic_variables": {"session_id": "<id>"}
      }
    }
  }' | jq
```

Expected: `{"received": true}` with status 200. SSE stream fires two events: `call_ended` and a `session_updated` with `buildStatus: "ready"`, `callDurationSecs: 183`, and `transcript` populated (stored as a JSON string).

This is the critical transition. If `buildStatus` doesn't flip to `"ready"` here, the "Build it" button never appears in the dashboard.

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

Expected: `200` with a silent ignored response. Must not return 4xx or 5xx — ElevenLabs retries on anything other than 200 and you'll get flooded.

---

## Step 7 — Trigger the build

First check the route guards work correctly.

```bash
# Returns 202 immediately; the complexity gate runs async and fires SSE events.
# (We flagged a question in Step 3, so the gate will block.)
curl -s -X POST http://localhost:3000/api/sessions/<id>/build | jq
```

Expected: `202` accepted, then SSE fires `build_started` followed quickly by `build_blocked` with a `ComplexityAssessment` that has `blocked: true` and `blockReason: "open_questions"`. The `buildStatus` goes back to `"ready"` — not `"idle"`, not `"failed"`.

If you want to test the happy path through to Claude Code and PR creation, clear the open questions manually by patching the session directly (or add a second decision with enough `relevantFiles` to trigger `too_large` instead) and re-fire. But for a smoke test, seeing `build_blocked` with the correct reason is enough to confirm the gate works.

---

## Step 8 — Concurrency guard

While the build is in `"building"` state (if you got that far), fire a second POST:

```bash
curl -s -X POST http://localhost:3000/api/sessions/<id>/build | jq
```

Expected: `409` with `"Build already in progress"`. If you get `202`, the concurrency lock is broken.

---

## What passing looks like

Every step returns the right status code. The SSE stream fires an event within a second of each mutation. `buildStatus` transitions cleanly: `idle → ready → building → blocked/complete/failed`. The session object at the end has all the fields populated that the dashboard depends on. Nothing 500s.

If any step fails, fix it before moving on — the steps build on each other and a broken session store or SSE broadcast will produce confusing failures downstream.