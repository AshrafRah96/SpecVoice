import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import path from 'path'
import { loadEnvVar, buildSignedPostCallRequest } from './helpers'

const fixturePath = path.resolve('./tests/fixtures/sample-repo')

// ── Shared setup ─────────────────────────────────────────────────────────────

/**
 * Navigate to the dashboard, create a session backed by the local fixture
 * (so no GitHub token is needed), and return the session ID.
 *
 * Must be called before generate-spec because the [data-testid="session-id"]
 * element is only rendered while specOutput is null.
 */
async function createLocalSession(page: Page): Promise<string> {
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    await route.continue({ postData: JSON.stringify({ repoLocalPath: fixturePath }) })
  })

  await page.goto('/')
  await page.getByPlaceholder('https://github.com/org/repo').fill('https://github.com/AshrafRah96/SpecVoice')
  await page.getByRole('button', { name: 'Start Session' }).click()

  const sessionIdLocator = page.locator('[data-testid="session-id"]')
  await expect(sessionIdLocator).toBeVisible({ timeout: 5000 })
  const sessionId = await sessionIdLocator.textContent()
  expect(sessionId).toBeTruthy()

  await expect(page.locator('[data-testid="sse-status"]')).toHaveText('connected', { timeout: 5000 })

  return sessionId!
}

/**
 * Drive the session through: save-decision → generate-spec → post-call webhook.
 * After this the "Build It" button should be visible.
 */
async function driveSessionToReady(
  request: APIRequestContext,
  sessionId: string,
  webhookSecret: string | undefined
) {
  await request.post('/api/tools/save-decision', {
    data: {
      session_id: sessionId,
      summary: 'Use Postgres for session storage',
      rationale: 'Existing infra already runs Postgres',
      alternatives_considered: ['Redis'],
      relevant_files: ['src/lib/session/store.ts'],
    },
  })

  await request.post('/api/tools/generate-spec', {
    data: { session_id: sessionId },
  })

  const { headers, data } = buildSignedPostCallRequest(sessionId, webhookSecret)
  await request.post('/api/agent/post-call', { headers, data })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('build_blocked — open question blocks build and keeps Build It visible', async ({ page, request }) => {
  const webhookSecret = loadEnvVar('ELEVENLABS_WEBHOOK_SECRET')
  const sessionId = await createLocalSession(page)

  // Flag an open question before triggering the build — this will block it.
  await request.post('/api/tools/flag-question', {
    data: {
      session_id: sessionId,
      question: 'Should we use Redis for caching?',
      context: 'Performance requirement TBD',
    },
  })

  await driveSessionToReady(request, sessionId, webhookSecret)

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
  const webhookSecret = loadEnvVar('ELEVENLABS_WEBHOOK_SECRET')
  const sessionId = await createLocalSession(page)

  await driveSessionToReady(request, sessionId, webhookSecret)

  // Build It button should be visible.
  await expect(page.locator('[data-testid="build-button"]')).toBeVisible({ timeout: 5000 })

  // Click Build It — executeBuild starts in the background.
  await page.locator('[data-testid="build-button"]').click()

  // The Retry button appears once buildStatus transitions to 'failed'.
  // Give a generous timeout: executeBuild is async but the failure is synchronous
  // (no network I/O involved on the fast-fail paths).
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 10000 })
})
