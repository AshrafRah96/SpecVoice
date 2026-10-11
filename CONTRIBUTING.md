# Contributing

Read `AGENTS.md` before changing the repository. It is the canonical workflow for humans and coding agents.

## Local workflow

```bash
npm ci
npm run verify
npm run test:e2e
```

Run the browser suite when changing the dashboard, route handlers, or SSE behavior. Use the focused Vitest command for a smaller iteration, then rerun `npm run verify` before opening a pull request.

## Pull requests

Describe the behavior change, the affected boundary, and the checks you ran. Keep unrelated formatting or dependency changes out of the PR. Include screenshots for meaningful UI changes and call out any external service, secret, or migration requirement.

PRs are reviewed as draft or ready-for-review changes; generated build PRs remain drafts until a human has checked the implementation and evidence.
