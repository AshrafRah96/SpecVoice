---
name: specvoice-feature-02-build-system
description: Use when changing Build Attempt acceptance, recovery, scope validation, complexity gates, Claude execution, publication, or Build events.
---

# Build work

1. Read `docs/build-pipeline.md` for the lifecycle and recovery contract. Read `docs/agents/claude-code.md` when changing the CLI, credentials, or subprocesses. Completion: identify the affected checkpoint and who owns its transition.
2. Keep recovery decisions behind `executeBuildAttempt`. PostgreSQL freezes generation inputs and scope at acceptance. A `generating` checkpoint must never automatically re-enter generation; publication recovery reuses the captured branch and commit. Completion: retries cannot spend model quota without a new explicit Build request.
3. Use the lease-bound Session repository for progress and terminal changes. Await persistence, propagate cancellation, and stop child processes before cleanup. The Worker applies only a bounded patch from disposable execution in trusted Git storage, validates paths, and owns push/PR creation. Real model keys stay in the gateway; the Docker socket stays in the launcher. Completion: stale workers cannot mutate state or publish after ownership checks fail.
4. Add regression coverage through the existing pipeline, runner, and PostgreSQL interfaces. Run focused tests, `npm run verify`, and `npm run test:integration` for durable changes. Run Playwright for event/UI changes and `npm run test:isolation`/`npm run test:compose` for execution/deployment changes.

Keep memory, PostgreSQL, fake-runner, and workflow adapters: they are real test/deployment seams. Preserve the complexity gate's `filesRead` heuristic separately from Repository Profile size; blocked complexity returns Build status to `ready`. Memory mode supports UI/discovery; the default Build executor requires PostgreSQL and isolated execution. Local-only repositories support discovery but cannot publish Builds without a GitHub URL. Changing that product boundary requires an explicit design change.
