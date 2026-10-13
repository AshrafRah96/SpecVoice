import { defineConfig } from '@playwright/test'
import { TEST_OPERATOR_HASH } from './tests/helpers/operator-fixture'
import path from 'node:path'
import { TEST_WEBHOOK_SECRET } from './tests/e2e/helpers'

// Playwright forces color in its workers and web server; avoid conflicting inherited settings.
delete process.env.NO_COLOR

export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://127.0.0.1:3117', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run dev -- --hostname 127.0.0.1 --port 3117',
    url: 'http://127.0.0.1:3117',
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'test',
      SPECVOICE_OPERATOR_PASSWORD_HASH: TEST_OPERATOR_HASH,
      SPECVOICE_OPERATOR_ORIGIN: 'http://127.0.0.1:3117',
      DATABASE_URL: '',
      GITHUB_TOKEN: '',
      GH_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ELEVENLABS_API_KEY: '',
      ELEVENLABS_AGENT_ID: '',
      NEXT_PUBLIC_ELEVENLABS_AGENT_ID: '',
      NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3117',
      SESSION_CAPABILITY_SECRET: 'specvoice-e2e-capability-secret-fixed',
      ELEVENLABS_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
      SPECVOICE_LOCAL_REPO_ROOT: path.resolve('tests/fixtures'),
    },
  },
})
