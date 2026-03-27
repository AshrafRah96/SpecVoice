import { test, expect, request } from '@playwright/test'

test('critical path — session creation to buildStatus ready', async ({ page }) => {
  // ── 1. Load the dashboard ───────────────────────────────────────────────
  await page.goto('/')
  await expect(page).toHaveTitle(/SpecVoice/)

  // Left panel should be in idle state — no session yet
  await expect(page.getByText('Start Session')).toBeVisible()

  // ── 2. Create a session via the UI ──────────────────────────────────────
  await page.getByPlaceholder('https://github.com/org/repo').fill('https://github.com/octocat/Hello-World')
  await page.getByRole('button', { name: 'Start Session' }).click()

  // SessionControls renders the session ID once the session is created.
  const sessionIdLocator = page.locator('[data-testid="session-id"]')
  await expect(sessionIdLocator).toBeVisible({ timeout: 5000 })
  const sessionId = await sessionIdLocator.textContent()
  expect(sessionId).toBeTruthy()

  // ── 3. Confirm SSE is live ───────────────────────────────────────────────
  await expect(page.locator('[data-testid="sse-status"]')).toHaveText('connected', { timeout: 5000 })

  // ── 4. Simulate agent reading a file ────────────────────────────────────
  const api = await request.newContext()

  await api.post('/api/tools/read-file', {
    data: { session_id: sessionId, path: 'README.md' },
  })

  // FileExplorer panel should update via SSE without a page reload.
  await expect(page.locator('[data-testid="file-explorer"]')).toContainText('README.md', { timeout: 5000 })

  // ── 5. Simulate agent saving a decision ─────────────────────────────────
  // NOTE: snake_case field names — this is what the Zod schema requires.
  await api.post('/api/tools/save-decision', {
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
  await api.post('/api/tools/generate-spec', {
    data: { session_id: sessionId },
  })

  // Spec tab becomes enabled once specOutput is non-null.
  // Tabs have role="tab" — added in Task 3.
  await expect(page.getByRole('tab', { name: 'Spec' })).not.toBeDisabled({ timeout: 5000 })

  // ── 7. Fire the post-call webhook ────────────────────────────────────────
  // NOTE: nested {type, data:{metadata,...}} format — matches what ElevenLabs actually sends.
  await api.post('/api/agent/post-call', {
    data: {
      type: 'post_call_transcription',
      data: {
        metadata: { call_duration_secs: 142 },
        transcript: [{ role: 'agent', message: 'Alright.', time_in_call_secs: 0 }],
        conversation_initiation_client_data: {
          dynamic_variables: { session_id: sessionId },
        },
      },
    },
  })

  // The "Build It" button should now be visible.
  await expect(page.locator('[data-testid="build-button"]')).toBeVisible({ timeout: 5000 })

  // ── 8. Confirm session state via API ─────────────────────────────────────
  const sessionRes = await api.get(`/api/sessions/${sessionId}`)
  const session = await sessionRes.json()
  expect(session.buildStatus).toBe('ready')
  expect(session.specOutput).toBeTruthy()
  expect(session.callDurationSecs).toBe(142)
})
