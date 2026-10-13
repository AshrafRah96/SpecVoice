# Evaluation

`npm run eval:offline` runs synthetic [`evals/cases`](../evals/cases) through real tool registry, session capability checks, scoped adapter, profile readiness and complexity gates. Checks HTTP contracts, permitted files/search results, read evidence, and Build acceptance. Uses memory storage; rejects configured databases and production mode.

Fixture schema validation stays separate from behavioral execution. Unit tests replace tool transport and contradict Build expectations to prove failure reporting. Tests enforce permissions and execution constraints; they do **not** prove LLM resistance to prompt injection. Separate regressions in `tests/lib/build` cover Claude cancellation and publication constraints.

CI blocks on `npm run verify`, offline fixtures, Playwright, and PostgreSQL integration. Locally, set `TEST_DATABASE_URL` to disposable PostgreSQL storage with database name ending in `_test`; run `npm run test:integration`. This suite migrates and truncates data. Never target an application database.

Playwright starts an isolated memory server on port 3117; never reuses developer servers. Overrides provider credentials; uses fixed test secrets. `NODE_ENV=test` excludes `.env.local`; test credentials override environment files. Committed local fixture needs no GitHub access. Install Chromium with `npm run test:e2e:install`; run `npm run test:e2e`. Canonical CI retains failure traces, screenshots, HTML report.

## Reports and operating evidence

`artifacts/evals/offline.json`: source commit/dirty status, dataset/prompt hashes, per-case pass/fail assertions and latency. CI retains reports for 90 days. Application assertion violations fail tests; changed fixtures receive independent schema checks. Dirty revisions are labelled, never presented as reproducible releases.

`npm run test:agent`: four synthetic next-reply tests, one simulation capped at 16 turns, five-minute suite deadline, no automatic SDK retries. Records fetched agent prompt hash, agent version and LLM; checks configuration drift. Provider results are categorical, not numeric quality scores. Reports label derived pass indicators explicitly. Billing unavailable from these endpoints; cost and usage remain `null`.

Before provider requests, set `SPECVOICE_LIVE_EVAL_ESTIMATE_USD` from your provider plan: positive, at most $10. Runner reserves it in `artifacts/evals/live-budget.json` against `SPECVOICE_LIVE_BUDGET_USD` (default $10). Reservations survive failures and unknown outcomes. Exhausted, malformed or locked ledgers fail closed. Review provider billing before manually starting a new approved budget period. Never delete uncertain reservations to permit retries. Estimates are not a billing ceiling.

Nightly CI warns only; paid checks require credentials and an estimate. Each isolated run gets its own $10 estimated budget; scheduled runs incur recurring cost. GitHub retains versioned scores/latency/estimates for 90 days; compare matching datasets and prompts. LLM failures warn; deterministic gates block. No calibrated quality or latency threshold without enough live observations.

`docker compose exec worker npm run ops:status`: worker heartbeat freshness, Build/receipt queues, 24-hour model estimates/unknown usage/p95 latency, latest backup/drill outcomes. PostgreSQL retains gateway requests and reported token usage for 180 days. Gateway reserves cost before dispatch; unknown responses retain reservations.

## Deployment and scale checks

`npm run test:compose` creates isolated Compose project, database volume and fixed credentials. Checks private login, durable restart/SSE replay, provider-only ingress, allowed/denied proxy traffic. `npm run test:isolation` runs pinned Claude CLI with synthetic responses. Checks non-root/read-only operation, resource/workspace limits, blocked direct egress. Neither calls paid models. Build backup image: `docker build --target backup -t specvoice-backup:test .`. `npm run test:backups` checks real encryption and disposable PostgreSQL restoration.

`npm run bench:repositories`: actual Git objects and LocalCodeSource at 5,000, 25,000, 100,000 and 100,001 files. Checks explicit 25-file scope under normal discovery limits. `artifacts/repository-scale.json` records results, configured limits, platform and memory usage. Measures synthetic local inventory/search, not GitHub throughput or large-repository generation quality.

## Live acceptance

External acceptance awaits wizard configuration: provider credentials, dedicated disposable GitHub repository, public provider ingress, real second-disk/NAS destination.

1. Use only synthetic source and conversation content. Disposable repository requires small Node/npm app, lockfile and passing explicit test command. Check URL against `SPECVOICE_LIVE_TEST_REPO`; no production repositories for first acceptance.
2. Record run ID, source commit, provider plan and current billing baseline locally. Reserve up to $5 estimated for **one voice call of at most five minutes**, and $5 for **one Build**. Shared initial estimated total: $10. If provider pricing makes the estimate insufficient, shorten or defer the call. Include evaluation-suite cost within that total before adding it to this run.
3. Sign in privately, create Session, await pinned profile, confirm small scope including package/lockfile/test inputs. Start private call: one simple change, file evidence, Spec. Stop within five minutes.
4. Confirm actual audio, permitted tool results, durable decisions, signed post-call completion. Reload dashboard; same Session must remain usable. Expired login requires reauthentication without losing planning records.
5. Start one explicit Build. Confirm isolated npm verification, expected limited diff, one unique branch and one draft PR. Check operational records: gateway request counts, token usage, charged estimates, duration. Repeated HTTP acceptance with the same idempotency key must not generate again.
6. Stop new paid work when reserved/reported estimates exhaust budget or outcomes become uncertain. In-flight requests and delayed billing can overshoot. Record actual provider charges when available, call duration, queue/build latency and errors. Never fabricate missing usage.
7. Review disposable PR; never auto-merge. Separately initialize backups on mounted destination; run its restore drill. Record restore time. Verify recovery password retrieval without application host.

Synthetic tests do not establish microphone quality, provider billing accuracy, real-host disk-loss recovery, deployed usage or customer impact. Record those observations only after this procedure.
