import { test, expect } from '@playwright/test'
import path from 'path'
import { TEST_OPERATOR_PASSPHRASE, TEST_WEBHOOK_SECRET, buildSignedPostCallRequest, testCapability } from './helpers'

test.describe('authenticated dashboard', () => {
  test.beforeEach(async ({ page, request }) => {
    for (const client of [page.request, request]) {
      const response = await client.post('/api/operator', { data: { passphrase: TEST_OPERATOR_PASSPHRASE } })
      expect(response.status()).toBe(200)
    }
  })

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
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      await route.continue({ postData: JSON.stringify({ repoLocalPath: fixturePath }) })
    })

    await page.getByPlaceholder('https://github.com/org/repo').fill('https://github.com/AshrafRah96/SpecVoice')
    const sessionResponsePromise = page.waitForResponse(
      response => response.url().endsWith('/api/sessions') && response.request().method() === 'POST'
    )
    await page.getByRole('button', { name: 'Start Session' }).click()
    const sessionResponse = await sessionResponsePromise
    expect(sessionResponse.status()).toBe(201)

    // SessionControls renders the session ID once the session is created.
    const sessionIdLocator = page.locator('[data-testid="session-id"]')
    await expect(sessionIdLocator).toBeVisible({ timeout: 5000 })
    const sessionId = await sessionIdLocator.textContent()
    expect(sessionId).toBeTruthy()
    const capability = testCapability(sessionId!)

    // ── 3. Confirm SSE is live ───────────────────────────────────────────────
    await expect(page.locator('[data-testid="sse-status"]')).toHaveText('connected', {
      timeout: 5000,
    })

    await expect(page.getByTestId('profile-status')).toHaveText('ready')

    // ── 4. Simulate agent reading a file ────────────────────────────────────
    const readFileRes = await request.post('/api/tools/read-file', {
      data: { session_id: sessionId, session_token: capability, path: 'README.md' },
    })
    expect(readFileRes.status(), `read-file failed: ${await readFileRes.text()}`).toBe(200)

    // FileExplorer panel should update via SSE without a page reload.
    await expect(page.locator('[data-testid="file-explorer"]')).toContainText('README.md', {
      timeout: 5000,
    })

    // ── 5. Simulate agent saving a decision ─────────────────────────────────
    // NOTE: snake_case field names — this is what the Zod schema requires.
    await request.post('/api/tools/save-decision', {
      data: {
        session_id: sessionId,
        session_token: capability,
        summary: 'Use Postgres for session storage',
        rationale: 'Existing infra already runs Postgres',
        alternatives_considered: ['Redis', 'SQLite'],
        relevant_files: ['src/lib/session/store.ts', 'src/lib/session/types.ts'],
      },
    })

    // SpecPreview shows decisions in the Decisions tab (default tab).
    await expect(page.locator('[data-testid="spec-preview"]')).toContainText('Use Postgres for session storage', {
      timeout: 5000,
    })

    // ── 6. Generate the spec ─────────────────────────────────────────────────
    await request.post('/api/tools/generate-spec', {
      data: { session_id: sessionId, session_token: capability },
    })

    // Spec tab becomes enabled once specOutput is non-null.
    // Tabs have role="tab" — added in Task 3.
    await expect(page.getByRole('tab', { name: 'Spec' })).not.toBeDisabled({ timeout: 5000 })

    // ── 7. Fire the post-call webhook ────────────────────────────────────────
    // Sign the request when ELEVENLABS_WEBHOOK_SECRET is configured on the server;
    // otherwise the route returns 401 and buildStatus never becomes 'ready'.
    const webhookSecret = TEST_WEBHOOK_SECRET
    const { headers: postCallHeaders, data: postCallBody } = buildSignedPostCallRequest(sessionId!, webhookSecret, {
      callDurationSecs: 142,
    })
    await request.post('/api/agent/post-call', { headers: postCallHeaders, data: postCallBody })

    // The "Build It" button should now be visible.
    await expect(page.locator('[data-testid="build-button"]')).toBeVisible({ timeout: 5000 })

    // ── 8. Confirm session state via API ─────────────────────────────────────
    const sessionRes = await request.get(`/api/sessions/${sessionId}`)
    expect(sessionRes.status()).toBe(200)
    const { session } = await sessionRes.json()
    expect(session.buildStatus).toBe('ready')
    expect(session.specOutput).toBeTruthy()
    expect(session.callDurationSecs).toBe(142)
  })
})

test('operator login, Session reload and history recovery, and sign-out', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Sign in to SpecVoice' })).toBeVisible()
  expect((await page.request.get('/api/sessions')).status()).toBe(401)

  await page.getByLabel('Operator passphrase').fill('wrong-passphrase')
  const deniedLogin = page.waitForResponse(
    response => response.url().endsWith('/api/operator') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  expect((await deniedLogin).status()).toBe(401)
  await expect(page.locator('p[role="alert"]')).toHaveText('Invalid operator credentials.')

  await page.getByLabel('Operator passphrase').fill(TEST_OPERATOR_PASSPHRASE)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start Session' })).toBeVisible()

  const response = await page.request.post('/api/sessions', {
    data: { repoLocalPath: path.resolve('./tests/fixtures/sample-repo') },
  })
  expect(response.status()).toBe(201)
  const { session } = (await response.json()) as { session: { id: string } }
  await page.goto(`/?session=${session.id}`)
  await expect(page.getByTestId('session-id')).toHaveText(session.id)
  await expect(page.getByTestId('sse-status')).toHaveText('connected')
  await expect(page.getByLabel('Saved Sessions')).toHaveValue(session.id)

  await page.reload()
  await expect(page.getByTestId('session-id')).toHaveText(session.id)
  await expect(page.getByTestId('sse-status')).toHaveText('connected')
  await page.getByLabel('Saved Sessions').selectOption('')
  await expect(page.getByRole('button', { name: 'Start Session' })).toBeVisible()
  await expect(page).toHaveURL('/')
  await page.getByLabel('Saved Sessions').selectOption(session.id)
  await expect(page.getByTestId('session-id')).toHaveText(session.id)
  await expect(page).toHaveURL(`/?session=${session.id}`)

  await expect(page.getByTestId('profile-status')).toHaveText('ready')
  let callRequests = 0
  await page.route(`**/api/sessions/${session.id}/call`, async route => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    callRequests++
    await route.fulfill({
      status: 503,
      json: { error: 'Configure ElevenLabs credentials before starting a call.' },
    })
  })
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        throw new DOMException('Microphone permission denied.', 'NotAllowedError')
      },
    })
  })
  await page.getByRole('button', { name: 'Start Web Call' }).click()
  await expect(page.locator('p[role="alert"]')).toContainText('Microphone permission denied.')
  await expect(page.getByRole('button', { name: 'Start Web Call' })).toBeEnabled()
  expect(callRequests).toBe(0)

  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => ({
        getTracks: () => [
          {
            stop: () => {
              document.body.dataset.testMicrophoneStopped = 'true'
            },
          },
        ],
      }),
    })
  })
  await page.getByRole('button', { name: 'Start Web Call' }).click()
  await expect(page.locator('p[role="alert"]')).toContainText(
    'Configure ElevenLabs credentials before starting a call.'
  )
  await expect(page.locator('body')).toHaveAttribute('data-test-microphone-stopped', 'true')
  await expect(page.getByRole('button', { name: 'Start Web Call' })).toBeEnabled()
  expect(callRequests).toBe(1)

  const saved = await (await page.request.get(`/api/sessions/${session.id}`)).json()
  const abandonedId = '4d5b8024-fd2a-4cd4-b6cd-570ba5626686'
  const sessionPattern = `**/api/sessions/${session.id}`
  await page.route(sessionPattern, route =>
    route.fulfill({
      json: {
        ...saved,
        session: { ...saved.session, currentCallId: abandonedId, callState: 'awaiting_transcript' },
      },
    })
  )
  await page.route(`**/api/sessions/${session.id}/events*`, route => route.abort())
  await page.reload()
  await expect(page.getByRole('button', { name: 'Mark call failed' })).toBeVisible()
  let discarded = false
  await page.route(`**/api/sessions/${session.id}/call`, async route => {
    expect(route.request().method()).toBe('DELETE')
    expect(route.request().postDataJSON()).toEqual({ callId: abandonedId, failed: true })
    discarded = true
    await route.fulfill({ json: { ended: true } })
  })
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Mark call failed' }).click()
  await expect.poll(() => discarded).toBe(true)
  await page.unroute(sessionPattern)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in to SpecVoice' })).toBeVisible()
  expect((await page.request.get(`/api/sessions/${session.id}`)).status()).toBe(401)
})
