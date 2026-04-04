import { test, expect } from '@playwright/test'
import path from 'path'
import { loadEnvVar, buildSignedPostCallRequest } from './helpers'

test('critical path — session creation to buildStatus ready', async ({ page, request }) => {
  // ── 1. Load the dashboard ───────────────────────────────────────────────
  await page.goto('/')
  await expect(page).toHaveTitle(/Spec Voice/)

  // Left panel should be in idle state — no session yet
  await expect(page.getByText('Start Session')).toBeVisible()

  // ── 2. Create a session via the UI ──────────────────────────────────────
  // Intercept the POST to /api/sessions so the session uses the local test
  // fixture instead of GitHub — avoids requiring a GitHub token with repo access.
  const fixturePath = path.resolve('./tests/fixtures/sample-repo')
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    await route.continue({ postData: JSON.stringify({ repoLocalPath: fixturePath }) })
  })

  await page.getByPlaceholder('https://github.com/org/repo').fill('https://github.com/AshrafRah96/SpecVoice')
  await page.getByRole('button', { name: 'Start Session' }).click()

  // SessionControls renders the session ID once the session is created.
  const sessionIdLocator = page.locator('[data-testid="session-id"]')
  await expect(sessionIdLocator).toBeVisible({ timeout: 5000 })
  const sessionId = await sessionIdLocator.textContent()
  expect(sessionId).toBeTruthy()

  // ── 3. Confirm SSE is live ───────────────────────────────────────────────
  await expect(page.locator('[data-testid="sse-status"]')).toHaveText('connected', { timeout: 5000 })

  // ── 4. Simulate agent reading a file ────────────────────────────────────
  const readFileRes = await request.post('/api/tools/read-file', {
    data: { session_id: sessionId, path: 'README.md' },
  })
  expect(readFileRes.status(), `read-file failed: ${await readFileRes.text()}`).toBe(200)

  // FileExplorer panel should update via SSE without a page reload.
  await expect(page.locator('[data-testid="file-explorer"]')).toContainText('README.md', { timeout: 5000 })

  // ── 5. Simulate agent saving a decision ─────────────────────────────────
  // NOTE: snake_case field names — this is what the Zod schema requires.
  await request.post('/api/tools/save-decision', {
    data: {
      session_id: sessionId,
      summary: 'Use Postgres for session storage',
      rationale: 'Existing infra already runs Postgres',
      alternatives_considered: ['Redis', 'SQLite'],
      relevant_files: ['src/lib/session/store.ts', 'src/lib/session/types.ts'],
    },
  })

  // SpecPreview shows decisions in the Decisions tab (default tab).
  await expect(page.locator('[data-testid="spec-preview"]')).toContainText(
    'Use Postgres for session storage',
    { timeout: 5000 }
  )

  // ── 6. Generate the spec ─────────────────────────────────────────────────
  await request.post('/api/tools/generate-spec', {
    data: { session_id: sessionId },
  })

  // Spec tab becomes enabled once specOutput is non-null.
  // Tabs have role="tab" — added in Task 3.
  await expect(page.getByRole('tab', { name: 'Spec' })).not.toBeDisabled({ timeout: 5000 })

  // ── 7. Fire the post-call webhook ────────────────────────────────────────
  // Sign the request when ELEVENLABS_WEBHOOK_SECRET is configured on the server;
  // otherwise the route returns 401 and buildStatus never becomes 'ready'.
  const webhookSecret = loadEnvVar('ELEVENLABS_WEBHOOK_SECRET')
  const { headers: postCallHeaders, data: postCallBody } = buildSignedPostCallRequest(
    sessionId!,
    webhookSecret,
    { callDurationSecs: 142 }
  )
  await request.post('/api/agent/post-call', { headers: postCallHeaders, data: postCallBody })

  // The "Build It" button should now be visible.
  await expect(page.locator('[data-testid="build-button"]')).toBeVisible({ timeout: 5000 })

  // ── 8. Confirm session state via API ─────────────────────────────────────
  const sessionRes = await request.get(`/api/sessions/${sessionId}`)
  const { session } = await sessionRes.json()
  expect(session.buildStatus).toBe('ready')
  expect(session.specOutput).toBeTruthy()
  expect(session.callDurationSecs).toBe(142)
})
