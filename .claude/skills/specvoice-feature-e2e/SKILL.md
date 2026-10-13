---
name: specvoice-feature-e2e
description: Use when writing Playwright checks, debugging SSE-driven browser assertions, or changing the manual HTTP smoke test.
---

# Verify the user flow

1. Read `playwright.config.ts` and `tests/e2e/helpers.ts`. Playwright owns an isolated memory server on port 3117, fixed test secrets, and provider credential overrides. Reuse is disabled. Completion: tests cannot attach to a developer server or read `.env.local` secrets.
2. Use the committed local Git fixture for Session creation. Log in with the fixed operator fixture and capture the Session ID. Fixture helpers mint synthetic provider capabilities separately; production issues them only when a private call starts. Wait for profile readiness before repository tool calls; confirm required scope before Build. Completion: the browser displays the expected profile/Build state.
3. Send tool payloads with root `session_id` and `session_token`; use kebab-case route names. Sign post-call fixtures with the fixed test secret. Their Session ID remains nested under `data.conversation_initiation_client_data.dynamic_variables.session_id`. Completion: assert HTTP status and the resulting browser change.
4. Assert SSE-driven UI outcomes using locators and retrying expectations. `list-files` and `search-code` are read-only; mutation tools produce Session events. Completion: no fixed sleep is needed to observe the mutation.
5. Run `npm run test:e2e`; canonical CI retains failure artifacts. For durable changes also run `npm run test:integration` against disposable PostgreSQL ending in `_test`.

The manual operator path is `docs/testing/manual-smoke.md`; live provider calls consume quota and remain a separate check. Browser fixtures simulate signed provider callbacks, not microphone/voice quality or a live Claude/GitHub Build. Subprocess and publication behavior is covered separately in `tests/lib/build`, with recovery/receipt transactions in `tests/integration`.
