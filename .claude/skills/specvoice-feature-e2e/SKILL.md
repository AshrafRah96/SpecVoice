---
name: specvoice-feature-e2e
description: Use when writing, fixing, or extending the SpecVoice E2E test suite — manual HTTP smoke test (Feature 06) or Playwright critical-path test (Feature 07). Also use when adding data-testid attributes, debugging SSE-driven UI assertions, or diagnosing why a Playwright assertion times out without a sleep fix.
---

## Overview

Two complementary test layers verify the full SpecVoice data path:

- **Manual smoke test** — curl commands against `npm run dev`; verifies every HTTP endpoint and SSE event in sequence.
- **Playwright test** (`tests/e2e/critical-path.spec.ts`) — drives a real browser; fires API calls as HTTP within the test while the browser watches for SSE-driven UI updates. Config lives at `playwright.config.ts` (project root), `testDir: './tests/e2e'`, `reuseExistingServer: true`. Commands: `npm run test:e2e`, `npm run test:e2e:ui`.

## Manual smoke test steps

1. `POST /api/sessions` → capture `id`. Expect `buildStatus: 'idle'`.
2. Open SSE stream: `curl -N .../api/sessions/{id}/events` — keep running for the entire test.
3. Fire tool webhooks in order. Each must include `conversation_initiation_client_data.dynamic_variables.session_id`:
   - `list_files` — no SSE event (no session mutation).
   - `read_file` — SSE fires `session_updated` with `filesRead` populated.
   - `search_code` — no SSE event.
   - `save_decision` — SSE fires `session_updated` with `decisions` populated.
   - `flag_question` — SSE fires `session_updated` with `openQuestions` populated.
   - `generate_spec` — SSE fires `session_updated` with `specOutput` set.
4. `GET /api/sessions/{id}` — verify all fields populated.
5. `POST /api/agent/post-call` with correct payload → `{"received": true}`. SSE fires `call_ended` then `session_updated` with `buildStatus: 'ready'`, `callDurationSecs`, `transcript`.
6. `POST /api/agent/post-call` with no `session_id` → must return `200 { ignored: '...' }` (graceful no-op, never 4xx).
7. `POST /api/sessions/{id}/build` → 202. SSE fires `build_started` then `build_blocked` with `blockReason: 'open_questions'` (open question was flagged in step 3). `buildStatus` returns to `'ready'` — the build never started.
8. `POST /api/sessions/{id}/build` again while building → 409.

### Correct post-call webhook payload shape

```json
{
  "type": "post_call_transcription",
  "data": {
    "metadata": { "call_duration_secs": 183 },
    "transcript": [],
    "conversation_initiation_client_data": {
      "dynamic_variables": { "session_id": "<id>" }
    }
  }
}
```

## Playwright test

Test flow: load dashboard → create session via UI → assert `sse-status` text is "connected" → fire API calls → assert UI updates without page reload.

All assertions use `{ timeout: 5000 }`. Selectors use `page.locator('[data-testid="..."]')`.

## data-testid requirements

These attributes must exist in components or the Playwright test cannot locate elements:

| Attribute | Component |
|---|---|
| `session-id` | SessionControls — renders session ID (only visible when `!session.specOutput`) |
| `sse-status` | SessionControls — SSE connection status text "connected" or "disconnected" |
| `file-explorer` | FileExplorer root element |
| `spec-preview` | SpecPreview root element |
| `build-button` | BuildPanel "Build it" button |

## What is NOT tested

- Actual voice calls (WebRTC cannot be automated meaningfully).
- Build pipeline internals, Claude Code CLI spawn, or PR creation.

## Common Mistakes

1. **Adding `waitForTimeout` or `sleep` to make assertions pass.** Never do this. A timeout means the SSE broadcast is too slow or missing — fix the broadcast, not the test.

2. **Wrong post-call payload shape.** The session ID lives at `data.conversation_initiation_client_data.dynamic_variables.session_id`. Duration is `data.metadata.call_duration_secs` (snake_case). Do not flatten or rename these fields.

3. **Forgetting `data-testid` attributes.** Playwright selectors are `[data-testid="..."]`. If an attribute is missing from the component, the test fails with a timeout, not a useful error. Add the attribute to the component first.

4. **Expecting SSE events from `list_files` or `search_code`.** These tools do not mutate session state, so they do not fire `session_updated`. Only `read_file`, `save_decision`, `flag_question`, and `generate_spec` broadcast SSE.

5. **Expecting `buildStatus: 'building'` or a successful build after step 7.** The smoke test flags an open question in step 3. When `/build` is triggered, the complexity gate blocks it immediately: SSE fires `build_blocked` with `blockReason: 'open_questions'` and `buildStatus` reverts to `'ready'`. The correct post-build assertion is `build_blocked`, not a running or completed build.
