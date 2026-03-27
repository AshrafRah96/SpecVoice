# E2E Test — UI + Critical Path (Playwright)

This test drives the real browser against the real dev server. The voice call itself can't be automated — WebRTC and ElevenLabs aren't scriptable in a headless browser — so the agent tool calls are fired as HTTP requests from within the test while the browser is open and watching. This is intentional: you're verifying that every SSE event correctly updates the UI, not that ElevenLabs works.

---

## Setup

```bash
npm install -D @playwright/test
npx playwright install chromium
```

Add to `package.json`:

```json
"scripts": {
  "test:e2e": "playwright test",
  "test:e2e:ui": "playwright test --ui"
}
```

Create `playwright.config.ts` at the project root:

```typescript
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
  },
})
```

`reuseExistingServer: true` means if you already have `npm run dev` running, Playwright won't start a second one. Good for iterating.

Create `tests/e2e/critical-path.spec.ts`.

---

## The test

```typescript
import { test, expect, request } from '@playwright/test'

test('critical path — session creation to buildStatus ready', async ({ page, context }) => {
  // ── 1. Load the dashboard ───────────────────────────────────────────────
  await page.goto('/')
  await expect(page).toHaveTitle(/SpecVoice/)

  // Left panel should be in idle state — no session yet
  await expect(page.getByText('Start Session')).toBeVisible()

  // ── 2. Create a session via the UI ──────────────────────────────────────
  await page.getByPlaceholder('https://github.com/org/repo').fill('https://github.com/octocat/Hello-World')
  await page.getByRole('button', { name: 'Start Session' }).click()

  // Wait for the session ID to appear somewhere in the DOM.
  // SessionControls renders the session ID once the session is created.
  const sessionIdLocator = page.locator('[data-testid="session-id"]')
  await expect(sessionIdLocator).toBeVisible({ timeout: 5000 })
  const sessionId = await sessionIdLocator.textContent()
  expect(sessionId).toBeTruthy()

  // ── 3. Confirm SSE is live ───────────────────────────────────────────────
  // The SSE connection status indicator should show "connected".
  await expect(page.locator('[data-testid="sse-status"]')).toHaveText('connected', { timeout: 5000 })

  // ── 4. Simulate agent reading a file ────────────────────────────────────
  // Fire the tool webhook directly — this is what ElevenLabs would call.
  const api = await request.newContext()

  await api.post('/api/tools/read-file', {
    data: { session_id: sessionId, path: 'README.md' },
  })

  // The FileExplorer panel should update via SSE without a page reload.
  await expect(page.locator('[data-testid="file-explorer"]')).toContainText('README.md', { timeout: 5000 })

  // ── 5. Simulate agent saving a decision ─────────────────────────────────
  await api.post('/api/tools/save-decision', {
    data: {
      session_id: sessionId,
      summary: 'Use Postgres for session storage',
      rationale: 'Existing infra already runs Postgres',
      alternativesConsidered: ['Redis', 'SQLite'],
      relevantFiles: ['src/lib/session/store.ts', 'src/lib/session/types.ts'],
    },
  })

  // SpecPreview should show the new decision card/row live.
  await expect(page.locator('[data-testid="spec-preview"]')).toContainText('Use Postgres for session storage', { timeout: 5000 })

  // ── 6. Generate the spec ─────────────────────────────────────────────────
  await api.post('/api/tools/generate-spec', {
    data: { session_id: sessionId },
  })

  // SpecPreview should switch to show the spec tab as enabled/clickable.
  // The "Spec" tab becomes available once specOutput is non-null.
  await expect(page.getByRole('tab', { name: 'Spec' })).not.toBeDisabled({ timeout: 5000 })

  // ── 7. Fire the post-call webhook ────────────────────────────────────────
  await api.post('/api/agent/post-call', {
    data: {
      conversation_initiation_client_data: {
        dynamic_variables: { session_id: sessionId },
      },
      call_duration_secs: 142,
      transcript: JSON.stringify([{ role: 'agent', message: 'Alright.' }]),
    },
  })

  // The status indicator should transition to "spec ready".
  // The "Build it" button should now be visible.
  await expect(page.locator('[data-testid="build-button"]')).toBeVisible({ timeout: 5000 })

  // ── 8. Confirm buildStatus is 'ready' in the session ────────────────────
  const sessionRes = await api.get(`/api/sessions/${sessionId}`)
  const session = await sessionRes.json()
  expect(session.buildStatus).toBe('ready')
  expect(session.specOutput).toBeTruthy()
  expect(session.callDurationSecs).toBe(142)
})
```

---

## data-testid attributes you need to add

The test above references `data-testid` attributes that probably don't exist yet. Add them — they're one-liners in each component and don't affect styling.

| Attribute | Where |
|---|---|
| `data-testid="session-id"` | The element in `SessionControls` that renders the session ID after creation |
| `data-testid="sse-status"` | The SSE connection status indicator in `SessionControls` |
| `data-testid="file-explorer"` | The root element of `FileExplorer` |
| `data-testid="spec-preview"` | The root element of `SpecPreview` |
| `data-testid="build-button"` | The "Build it" button in `BuildPanel` |

Example for `FileExplorer`:

```tsx
<div data-testid="file-explorer" className="p-5 h-full flex flex-col">
```

---

## Running it

```bash
# Run headless (CI-style)
npm run test:e2e

# Run with the Playwright UI — lets you step through each action and see the browser
npm run test:e2e:ui
```

The `--ui` mode is worth using for the first run. It shows you exactly what the browser sees at each step, and if an assertion fails you can scrub back in time to see what the DOM looked like when it failed.

---

## What this does not test

The actual voice call. There's no way to automate WebRTC in a meaningful way without mocking the entire ElevenLabs SDK, at which point you're testing the mock, not the product. The manual E2E doc covers the parts Playwright can't reach. These two tests are meant to be run together — Playwright for the UI data flow, manual curl steps for the voice path.

The build pipeline (Claude Code spawn, GitHub PR creation) is also not in scope here. That path has its own failure modes that are better caught by the manual test or a dedicated integration test with a real repo.

---

## Done when

`npm run test:e2e` passes green. Each SSE-driven UI update is verified by a `toContainText` or `toBeVisible` assertion with no artificial `waitForTimeout` calls — if you need a sleep to make it pass, the SSE broadcast is too slow and that's the real bug.