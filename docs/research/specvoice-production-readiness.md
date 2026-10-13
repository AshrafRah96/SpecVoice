# SpecVoice production-readiness research

**Date:** 2026-10-11  
**Status:** Research and architecture recommendation  
**Scope:** Durable sessions, agent evaluation, secure build execution, webhook recovery, observability, and mid-to-very-large repositories.

The accepted local-first deployment decision is recorded in [ADR 0004](../adr/0004-local-first-durable-runtime.md).

## Decision summary

Keep the product contract intact:

```text
voice discovery → evidence-backed spec → human-reviewed draft PR
```

Change the implementation around that contract in four boundaries:

1. **Stateless web tier:** Next.js handles authentication, session reads, tool webhooks, and SSE connections. It does not own session state or long-running builds.
2. **Durable control plane:** a database stores sessions, transcripts, decisions, file evidence, webhook receipts, build jobs, state transitions, and an append-only event log.
3. **Worker plane:** a queue delivers post-call finalization and build jobs to isolated workers. Every handler is idempotent and safe to retry.
4. **Repository intelligence plane:** a repository snapshot and scope planner decide what the agent may inspect and what a build may change. The agent does not crawl an entire large repository by default.

This is the smallest design that addresses restart safety, multiple workers, duplicate webhooks, partial PR failures, and repository size without changing the user-facing workflow.

## Findings from the current repository

The existing boundaries are useful and should be retained:

- `SessionStore` currently owns state and SSE listeners in memory (`src/lib/session/store.ts`). ADR-0003 already records that this is single-process only.
- `POST /api/agent/post-call` mutates the session synchronously after parsing the webhook (`src/app/api/agent/post-call/route.ts`).
- `BuildPipeline` runs in the request process and owns clone, Claude Code, PR creation, and cleanup (`src/lib/build/pipeline.ts`).
- `SessionStore.tryStartBuild()` provides idempotency only inside one process.
- `GitHubCodeSource.listFiles()` uses one recursive tree request and warns when GitHub reports truncation (`src/lib/code/github-source.ts`).
- The complexity gate counts files read during discovery, not the estimated implementation scope (`src/lib/session/complexity.ts`).
- Agent tests and ElevenLabs success criteria already exist (`src/scripts/test-agent.ts`, `src/lib/agent/config.ts`), but their results are not a versioned regression artifact or a CI quality gate.

The product is therefore not starting from zero. The migration should introduce durable adapters behind these existing interfaces, then move execution out of the web process.

## 1. Durable sessions, events, and builds

### Recommended shape

Use a relational database as the system of record. Model these records separately:

| Record             | Purpose                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `sessions`         | Repository identity, capability metadata, status, spec, transcript pointer, and timestamps          |
| `session_events`   | Ordered state and progress events with a monotonic sequence number                                  |
| `webhook_receipts` | Provider delivery ID, event type, conversation ID, signature result, and processing status          |
| `build_jobs`       | Idempotency key, attempt count, lease, worker status, branch, commit SHA, PR URL, and failure class |
| `evaluations`      | Agent version, prompt version, model, scenario, scores, cost, latency, and trace ID                 |
| `repo_snapshots`   | Commit SHA, repository profile, manifest version, and indexing status                               |

Keep the current `SessionStore` API as a domain service, but replace its Map with a repository implementation. The domain service should write the state transition and its `session_updated` event in one transaction.

SSE should read from `session_events`, support `Last-Event-ID`, and replay events after reconnect. A new worker or web instance can then serve a browser without sharing process memory. Redis or another pub/sub system may reduce notification latency, but it should be a delivery optimization; the database event log remains the source of truth.

If Postgres `NOTIFY` is used to wake SSE listeners, treat it only as a hint to re-read the event table. PostgreSQL documents payload limits and notification behavior that make `NOTIFY` unsuitable as the durable event transport ([PostgreSQL `NOTIFY`](https://www.postgresql.org/docs/current/sql-notify.html)).

Build requests should enqueue a job and return `202` with the job ID. A worker claims the job using a lease, renews the lease during long work, and records every transition. The queue must be treated as at-least-once delivery: AWS documents that standard SQS can deliver a message more than once, recommends idempotent consumers, and provides visibility timeouts and dead-letter queues for failed work ([SQS standard queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html), [visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)). SQS is an example; the code should depend on a `BuildJobQueue` interface so the deployment can use an equivalent managed or Postgres-backed queue.

If adding a hosted queue is too much infrastructure for the first deployment, a Postgres-backed queue can claim rows with `FOR UPDATE SKIP LOCKED`; the database remains the source of truth while workers still use leases and idempotency keys ([PostgreSQL `SELECT`](https://www.postgresql.org/docs/current/sql-select.html)). A workflow engine becomes useful when builds need durable timers, cancellation, and long-running retries; it is not required for the first durable slice.

### Partial failure recovery

Use explicit states instead of treating the whole build as one opaque promise:

```text
queued → running → branch_pushed → pr_pending → complete
                    ↘ retryable_failure
                    ↘ terminal_failure
```

Before creating a PR, persist the branch name and commit SHA. On retry, look up an existing PR by repository and head branch before calling `pulls.create`. If the branch exists but the PR does not, create it. If the PR exists, record its URL and finish. This makes “push succeeded, PR creation timed out” safe to reconcile.

The worker should have a bounded retry policy for provider errors, a dead-letter path for exhausted jobs, and a human-visible retry/reconcile action. Never rely on an in-memory promise surviving a process restart.

## 2. Webhook reliability and security

Make `ELEVENLABS_WEBHOOK_SECRET` mandatory in production. ElevenLabs documents HMAC validation, prompt acknowledgment, retry behavior, and idempotent processing because a retry has the same payload as the original delivery ([ElevenLabs webhooks](https://elevenlabs.io/docs/eleven-api/resources/webhooks)). The current optional verification in `src/app/api/agent/post-call/route.ts` should become a startup/configuration failure in production.

The post-call route should:

1. Read and verify the raw body.
2. Validate the event type and extract `conversation_id`, `event_timestamp`, and the session capability variables.
3. Insert a receipt keyed by provider event identity. Return the same successful response for a previously processed receipt.
4. Enqueue finalization and return promptly.

Do not run transcript persistence and build preparation synchronously in the webhook request. GitHub’s webhook guidance recommends responding within ten seconds, using a queue for longer work, using a secret, and using the delivery ID to prevent replay processing ([GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)). The same pattern applies to ElevenLabs.

ElevenLabs retries failed deliveries with the same payload and warns that repeated failures can disable a webhook. Persist the provider conversation ID and event timestamp as part of the deduplication key, and add a scheduled reconciliation job that checks recent conversations when a webhook has been unavailable ([ElevenLabs post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks)).

Capabilities should remain short-lived, but production needs revocation and ownership checks in the database. A capability should identify the session, tenant/user, expiry, and version. The session route, SSE route, tool handlers, and build worker should all enforce the same ownership boundary.

## 3. Secure Claude execution

The current executor allows broad command patterns and a 300-turn ceiling (`src/lib/build/process-runner.ts`). Keep Claude Code post-call, but run it in a dedicated worker with these controls:

- Create a fresh per-job workspace and never mount the application host filesystem.
- Use OS/container sandboxing with both filesystem and network isolation. Anthropic’s secure-deployment guidance recommends defense in depth, non-root execution, dropped Linux capabilities, `no-new-privileges`, a read-only root filesystem, resource limits, and stronger isolation such as gVisor or a microVM when the threat model requires it ([Claude Code secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment), [Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)).
- Allow network only to the Git host, package registries required by the selected package manager, and the model service. Default deny everything else.
- Replace broad shell patterns with a small wrapper command surface: `git` operations against the job repository, the repository’s declared test/lint/build commands, and no arbitrary shell interpolation. Anthropic’s CLI supports explicit allowed and disallowed tool patterns, but those flags are a permission layer, not a substitute for OS isolation ([Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)).
- Remove branch push and PR creation from the model prompt. Let the worker orchestrator inspect the result, run policy checks, push the generated branch, and reconcile or create the draft PR. This preserves the product outcome while keeping provider side effects outside model-controlled shell instructions.
- Enforce wall-clock, CPU, memory, disk, child-process, and output limits. Kill the entire process group on timeout and mark the job retryable or terminal with a reason.
- Keep generated `SPEC.md` and `CONTEXT.md` outside the untrusted repository content or clearly delimit them as trusted control input. Treat repository files, issue text, and transcripts as untrusted instructions; they may describe the task but cannot grant permissions.
- Redact secrets and transcript content from logs. Store full traces only in the protected evaluation/audit store.
- Keep draft PR plus human review as the terminal boundary. Do not add auto-merge or production deploy behavior.

The existing `finally` cleanup is good, but cleanup must be paired with worker-level leases and a reaper that removes abandoned workspaces after a crash.

Anthropic’s Agent SDK hosting guidance reaches the same conclusion for long-lived agent sessions: local process state does not survive restart or movement between hosts, so session transcripts and resumable state need an external store ([Agent SDK hosting](https://code.claude.com/docs/en/agent-sdk/hosting), [session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)).

## 4. AI evaluation and operating metrics

The current ElevenLabs tests are a useful online layer. Add an offline regression suite in `evals/` using recorded, consented, or synthetic cases with no secrets:

```text
evals/
  cases/*.json
  fixtures/*
  rubrics/*.md
  run.ts
  snapshots/
```

Each case should specify the repository fixture, user request, expected exploration behavior, allowed tool calls, required evidence, expected scope outcome, and whether a build should be blocked. Store results with the git SHA, prompt version, agent version, model, scenario ID, latency, token/cost data, and trace ID.

Use three grading layers:

1. **Code-based:** schema validity, first-tool behavior, path containment, required fields, open-question blocking, no implementation during discovery, and touched-file limits.
2. **LLM rubric:** grounding in files actually read, quality of clarifying questions, scope negotiation, completeness of the spec, and resistance to repository prompt injection.
3. **Human calibration:** periodically label a sample and compare the LLM grader against those labels.

Anthropic recommends explicit success criteria, a baseline set of test cases, and choosing code-based, human, or LLM grading according to reliability and scale ([Claude evaluation guidance](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)). ElevenLabs supports simulation, next-reply, and tool-call tests plus post-call success evaluation; use those for provider-specific online checks and feed their results into the same evaluation record ([ElevenLabs agent testing](https://elevenlabs.io/docs/eleven-agents/customization/agent-testing), [success evaluation](https://elevenlabs.io/docs/eleven-agents/customization/agent-analysis/success-evaluation)).

Run deterministic offline checks on every pull request. Run live ElevenLabs tests nightly or before release because they require credentials and spend provider quota. Fail a release when a critical safety or contract criterion regresses, and publish a small scorecard rather than a single composite number.

Track at least:

- spec completion and abandonment rate;
- grounded-file citation rate and unsupported-claim rate;
- tool success/error and retry rate;
- open-question rate and build-block rate;
- build success, retry, timeout, and draft-PR acceptance rate;
- p50/p95 call latency, tool latency, build duration, and queue wait;
- model/provider cost per call and per successful draft PR;
- prompt-injection detection and sandbox violation counts.

Instrument the web tier, webhook handler, queue, worker, GitHub calls, and Claude process with traces, metrics, and logs. OpenTelemetry is a vendor-neutral framework for those three signals ([OpenTelemetry documentation](https://opentelemetry.io/docs/)). ElevenLabs also exposes conversation analytics, cost, error, latency, and evaluation data; retain the provider conversation/version identifiers so online results can be joined to application traces ([ElevenLabs analytics](https://elevenlabs.io/docs/eleven-agents/dashboard)).

When using Claude Code or an Agent SDK worker, record per-step model usage and tool spans, but treat client-side cost as an estimate and reconcile it with the provider’s authoritative usage data. Anthropic’s observability guidance recommends spans for interactions, LLM requests, and tools while keeping content capture disabled or redacted by default ([Agent SDK observability](https://code.claude.com/docs/en/agent-sdk/observability), [Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)).

## 5. Mid, large, and very-large repositories

Do not define repository size only by file count. Profile file count, bytes, languages, generated/vendor directories, dependency manifests, tree depth, and the requested scope. Use configurable limits and report the reason for every refusal or split.

| Tier       | Detection and behavior                                                                   | Agent contract                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Small      | Complete manifest fits within the configured discovery budget; no generated/vendor flood | Existing `list-files`, `read-file`, and `search-code` flow                                                                              |
| Mid        | Manifest is larger but can be indexed asynchronously; multiple packages or services      | Build a repository profile first, then require a package/directory scope and use targeted search                                        |
| Large      | Recursive tree is expensive or truncated; many packages or generated artifacts           | Fetch Git trees per subtree, use a persistent manifest, search only selected scopes, and split the spec by package or service           |
| Very large | Monorepo or repository exceeds configured bytes/files/time budget                        | Require an explicit scope and commit; create an asynchronous index job; refuse full-repository build generation and offer a scoped plan |

GitHub’s recursive Git Trees endpoint has a documented maximum of 100,000 entries or 7 MB and returns `truncated: true` when the limit is exceeded. The documented fallback is to fetch non-recursive subtrees one at a time ([Git Trees API](https://docs.github.com/en/rest/git/trees)). `GitHubCodeSource` should implement that fallback instead of merely warning.

For large builds, prefer an immutable commit snapshot and a partial clone. Git supports `--filter=blob:none` to fetch blobs on demand and sparse checkout to materialize only selected paths ([Git partial clone](https://git-scm.com/docs/partial-clone), [git clone](https://git-scm.com/docs/git-clone.html), [sparse checkout](https://git-scm.com/docs/sparse-checkout)). GitHub also documents repository-size, contents-endpoint, and API-rate considerations that make unbounded recursive reads and sequential unauthenticated scans unsuitable for large repositories ([repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits), [Contents API](https://docs.github.com/en/rest/repos/contents), [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)).

### Repository profile and scope plan

Add a `RepositoryProfile` produced at a commit SHA:

```typescript
interface RepositoryProfile {
  commitSha: string
  fileCount: number
  byteCount: number
  languages: Record<string, number>
  packages: Array<{ path: string; manifest: string; fileCount: number }>
  generatedRoots: string[]
  vendorRoots: string[]
  treeComplete: boolean
  indexStatus: 'pending' | 'ready' | 'partial' | 'failed'
}
```

The call should produce a `ScopePlan` before deep reading:

```typescript
interface ScopePlan {
  repositorySha: string
  includedRoots: string[]
  excludedRoots: string[]
  estimatedFiles: number
  estimatedBytes: number
  dependencyBoundaries: string[]
  reason: string
}
```

The agent can ask the developer to choose a package or service when the profile is too large. The dashboard should show the scope, exclusions, estimated cost, and why the build is bounded.

### Fix the current complexity gate

`filesRead.length` measures how much the agent investigated, not how large the proposed change is. Replace it with two independent budgets:

- **Discovery budget:** tool calls, files read, characters, search results, and wall-clock time during the call.
- **Implementation budget:** estimated changed files, changed lines, dependency boundaries, migrations, external side effects, and test surface from the generated spec.

Block or split on implementation risk. Keep discovery limits to protect the conversation. This avoids rejecting a small change because the agent read many files and avoids accepting a large change because the agent read only a few files.

Embeddings or RAG should remain optional. First add deterministic repository profiling, subtree manifests, package detection, and targeted search. Introduce semantic indexing only when traces show that structural navigation fails to find relevant code; measure retrieval recall against the offline eval set before adding the operational cost.

## 6. Recommended delivery order

### Phase 0 — make the existing MVP honest and measurable

- Require webhook secrets in production.
- Add explicit process timeout, cancellation, output, and workspace cleanup limits.
- Add receipt IDs and deduplication for post-call events.
- Add offline evaluation fixtures and a scorecard.
- Define a supported-repository matrix and expose current size limits in the UI.

### Phase 1 — durable control plane

- Introduce `SessionRepository`, `EventRepository`, `WebhookReceiptRepository`, and `BuildJobRepository` interfaces.
- Add database migrations and replace Map-backed state behind those interfaces.
- Persist events and implement SSE replay with `Last-Event-ID`.
- Add a queue adapter and a worker entry point; keep the current pipeline as the worker implementation.
- Add reconciliation for branch-pushed/PR-pending jobs.

### Phase 2 — isolated execution

- Run each build in an isolated worker/container.
- Add network allowlists, process/resource limits, command wrappers, secret redaction, and abandoned-workspace reaping.
- Add adversarial fixtures containing malicious repository instructions and verify that the worker cannot escape its allowed boundary.

### Phase 3 — repository scale

- Implement paginated/subtree GitHub tree retrieval and a commit-pinned repository profile.
- Add scope planning, package detection, async indexing, and separate discovery/implementation budgets.
- Make very-large repositories scope-required and build-scoped by default.

### Phase 4 — operating evidence

- Export OpenTelemetry traces/metrics/logs.
- Join ElevenLabs analytics to app and worker traces.
- Add dashboards, alerts, load tests, release gates, and a public or internal reliability scorecard.
- Run controlled prompt/model experiments with a fixed evaluation set and versioned results.

## Suggested repository changes

The first implementation slice should add these seams without changing the public API:

- `src/lib/session/repository.ts`
- `src/lib/session/event-store.ts`
- `src/lib/jobs/queue.ts`
- `src/workers/build-worker.ts`
- `src/lib/webhooks/receipts.ts`
- `src/lib/repo/profile.ts`
- `src/lib/repo/scope-plan.ts`
- `evals/cases/`, `evals/rubrics/`, and `evals/run.ts`
- ADRs for durable storage/queueing, sandboxed execution, and repository-scale support

The first stop condition is a working durable session and build job on one worker with restart recovery. Do not add embeddings, multi-region deployment, or autonomous merge until that path is reliable and measured.

## Source list

- [Amazon SQS standard queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html)
- [Amazon SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [PostgreSQL row locking and `SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html)
- [PostgreSQL `NOTIFY`](https://www.postgresql.org/docs/current/sql-notify.html)
- [GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- [GitHub REST Git Trees API](https://docs.github.com/en/rest/git/trees)
- [ElevenLabs webhooks](https://elevenlabs.io/docs/eleven-api/resources/webhooks)
- [ElevenLabs agent testing](https://elevenlabs.io/docs/eleven-agents/customization/agent-testing)
- [ElevenLabs success evaluation](https://elevenlabs.io/docs/eleven-agents/customization/agent-analysis/success-evaluation)
- [ElevenLabs analytics](https://elevenlabs.io/docs/eleven-agents/dashboard)
- [Anthropic Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)
- [Anthropic Claude Code secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)
- [Anthropic Agent SDK hosting](https://code.claude.com/docs/en/agent-sdk/hosting)
- [Anthropic Agent SDK session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [Anthropic Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Anthropic Agent SDK observability](https://code.claude.com/docs/en/agent-sdk/observability)
- [Anthropic Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- [Anthropic evaluation guidance](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)
- [Git partial clone](https://git-scm.com/docs/partial-clone)
- [Git sparse checkout](https://git-scm.com/docs/sparse-checkout)
- [GitHub repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)
- [GitHub REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [OpenTelemetry documentation](https://opentelemetry.io/docs/)
