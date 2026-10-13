# Contributing

Read `AGENTS.md` before editing: shared workflow for humans and agents.

## Local workflow

```bash
npm ci
npm run verify
npm run test:e2e:install
npm run test:e2e
```

Run browser tests for dashboard, route or SSE changes. Iterate with focused Vitest checks; run `npm run verify` before opening a PR.

Run `npm run eval:offline` for tool/scope/Build gates. Durable changes: `npm run test:integration`, disposable `TEST_DATABASE_URL` ending in `_test`. Execution/deployment changes: Docker checks in [Evaluation](docs/evaluation.md). Live checks consume quota; keep separate and warning-only.

## Pull requests

Describe behavior, affected boundary and checks. Exclude unrelated formatting/dependencies. Include screenshots for meaningful UI changes. Name external-service, secret and migration requirements.

PRs may be draft or ready for review. Generated Build PRs stay draft until human review of implementation and evidence.
