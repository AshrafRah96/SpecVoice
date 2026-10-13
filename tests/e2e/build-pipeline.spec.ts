import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import path from 'path'
import { TEST_OPERATOR_PASSPHRASE, TEST_WEBHOOK_SECRET, buildSignedPostCallRequest, testCapability } from './helpers'

const fixturePath = path.resolve('./tests/fixtures/sample-repo')

test.beforeEach(async ({ page, request }) => {
  for (const client of [page.request, request]) {
    const response = await client.post('/api/operator', { data: { passphrase: TEST_OPERATOR_PASSPHRASE } })
    expect(response.status()).toBe(200)
  }
})

// ── Shared setup ─────────────────────────────────────────────────────────────

/**
 * Navigate to the dashboard, create a session backed by the local fixture
 * (so no GitHub token is needed), and return the session ID.
 *
 * Must be called before generate-spec because the [data-testid="session-id"]
 * element is only rendered while specOutput is null.
 */
async function createLocalSession(page: Page): Promise<{ id: string; capability: string }> {
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    await route.continue({ postData: JSON.stringify({ repoLocalPath: fixturePath }) })
  })

  await page.goto('/')
  await page.getByPlaceholder('https://github.com/org/repo').fill('https://github.com/AshrafRah96/SpecVoice')
  const responsePromise = page.waitForResponse(
    response => response.url().endsWith('/api/sessions') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Start Session' }).click()
  const response = await responsePromise
  expect(response.status()).toBe(201)

  const sessionIdLocator = page.locator('[data-testid="session-id"]')
  await expect(sessionIdLocator).toBeVisible({ timeout: 5000 })
  const sessionId = await sessionIdLocator.textContent()
  expect(sessionId).toBeTruthy()

  await expect(page.locator('[data-testid="sse-status"]')).toHaveText('connected', {
    timeout: 5000,
  })

  await expect(page.getByTestId('profile-status')).toHaveText('ready')
  return { id: sessionId!, capability: testCapability(sessionId!) }
}

/**
 * Drive the session through: save-decision → generate-spec → post-call webhook.
 * After this the "Build It" button should be visible.
 */
async function driveSessionToReady(
  request: APIRequestContext,
  session: { id: string; capability: string },
  webhookSecret: string | undefined
) {
  const { id: sessionId, capability } = session
  await request.post('/api/tools/save-decision', {
    data: {
      session_id: session.id,
      session_token: capability,
      summary: 'Use Postgres for session storage',
      rationale: 'Existing infra already runs Postgres',
      alternatives_considered: ['Redis'],
      relevant_files: ['src/lib/session/store.ts'],
    },
  })

  await request.post('/api/tools/generate-spec', {
    data: { session_id: sessionId, session_token: capability },
  })

  const { headers, data } = buildSignedPostCallRequest(sessionId, webhookSecret)
  await request.post('/api/agent/post-call', { headers, data })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('build_blocked — open question blocks build and keeps Build It visible', async ({ page, request }) => {
  const webhookSecret = TEST_WEBHOOK_SECRET
  const session = await createLocalSession(page)

  // Flag an open question before triggering the build — this will block it.
  await request.post('/api/tools/flag-question', {
    data: {
      session_id: session.id,
      session_token: session.capability,
      question: 'Should we use Redis for caching?',
      context: 'Performance requirement TBD',
    },
  })

  await driveSessionToReady(request, session, webhookSecret)

  // Build It button should now be visible (buildStatus: 'ready').
  await expect(page.locator('[data-testid="build-button"]')).toBeVisible({ timeout: 5000 })

  // Click Build It — the build should be immediately blocked due to the open question.
  await page.locator('[data-testid="build-button"]').click()

  // Blocked warning must appear with the open question count.
  await expect(page.getByText('1 open question must be resolved')).toBeVisible({ timeout: 5000 })

  // Build It button must still be visible — buildStatus resets to 'ready' on block,
  // keeping the button available for when the question is answered.
  await expect(page.locator('[data-testid="build-button"]')).toBeVisible({ timeout: 3000 })
})

test('build_failed — fast failure surfaces error and shows Retry button', async ({ page, request }) => {
  // This test relies on executeBuild failing quickly. Sessions created with
  // repoLocalPath (no repoUrl) hit the "Session has no repository URL" guard
  // in executeBuild after prerequisites pass — a reliable fast path.
  // If prerequisites themselves fail (missing claude CLI or credentials), the
  // test still passes because any build_failed path produces the same UI state.
  const webhookSecret = TEST_WEBHOOK_SECRET
  const session = await createLocalSession(page)

  await driveSessionToReady(request, session, webhookSecret)

  // Build It button should be visible.
  await expect(page.locator('[data-testid="build-button"]')).toBeVisible({ timeout: 5000 })

  // Click Build It — executeBuild starts in the background.
  await page.locator('[data-testid="build-button"]').click()

  // The Retry button appears once buildStatus transitions to 'failed'.
  // Give a generous timeout: executeBuild is async but the failure is synchronous
  // (no network I/O involved on the fast-fail paths).
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 10000 })
})

test('profile and explicit scope confirmation gate Builds', async ({ page, request }) => {
  const session = await createLocalSession(page)
  await expect(page.getByText(/Commit: [a-f0-9]{40}/)).toBeVisible()
  await expect(page.getByTestId('profile-status')).toHaveText('ready')
  await driveSessionToReady(request, session, TEST_WEBHOOK_SECRET)
  await expect(page.getByTestId('build-button')).toBeEnabled()
  await page.getByLabel('Included paths').fill('README.md')
  await page.getByRole('button', { name: 'Save Scope Plan' }).click()
  await expect(page.getByTestId('scope-status')).toContainText('proposed')
  await expect(page.getByTestId('build-button')).toBeDisabled()
  await page.getByLabel('Included paths').fill('src')
  await expect(page.getByRole('button', { name: 'Confirm Scope Plan' })).toBeDisabled()
  await page.getByLabel('Included paths').fill('README.md')
  await page.getByRole('button', { name: 'Confirm Scope Plan' }).click()
  await expect(page.getByTestId('scope-status')).toContainText('confirmed · 1 files')
  await expect(page.getByTestId('build-button')).toBeEnabled()
  let expired = true
  const profileUrl = `**/api/sessions/${session.id}/profile`
  await page.route(profileUrl, async route => {
    const response = await route.fetch()
    if (route.request().method() === 'POST') expired = false
    const body = await response.json()
    if (expired && body.snapshot) {
      body.snapshot.indexStatus = 'expired'
      body.snapshot.profile = null
    }
    await route.fulfill({ response, json: body })
  })
  await page.reload()
  await expect(page.getByTestId('profile-status')).toHaveText('expired')
  await expect(page.getByTestId('build-button')).toBeDisabled()
  await page.getByRole('button', { name: 'Rebuild profile' }).click()
  await expect(page.getByTestId('profile-status')).toHaveText('ready')
  await expect(page.getByTestId('scope-status')).toContainText('confirmed · 1 files')
  await expect(page.getByTestId('build-button')).toBeEnabled()
  await page.unroute(profileUrl)
  await page.getByLabel('Included paths').fill('src')
  await page.getByRole('button', { name: 'Save Scope Plan' }).click()
  await expect(page.getByTestId('scope-status')).toContainText('proposed')
  await expect(page.getByTestId('build-button')).toBeDisabled()
})
