# Build pipeline

A Build turns a Session's Spec into a draft PR for human review. Voice tools gather evidence and produce the Spec; explicit Builds run Claude Code. This reference owns execution and recovery. Command, process limits, credentials: [Claude Code integration](agents/claude-code.md).

## Accepting a Build

`POST /api/sessions/{id}/build` requires an operator cookie, Spec, and Repository Profile matching the Session's pinned Repository Snapshot. Profile status must be `ready` or `partial`. Mid, large, very-large, and incomplete profiles require confirmed scope. Every existing Scope Plan must be confirmed and match the pinned commit, even for small repositories.

Send an `Idempotency-Key`; reuse it for retries. Omission generates a fresh key. Acceptance returns `202`; the same key replays acceptance. Competing requests return `409` while an attempt is queued, running, or awaiting reconciliation. Missing Specs return `400`; unavailable or changed profile/scope readiness returns `409`.

PostgreSQL acceptance locks Session and snapshot, rechecks readiness, and freezes repository SHA, accepted scope, Spec, decisions, transcript, and other Session evidence. Branch: `spec-voice/<session-id>/<attempt-id>`. Later Session edits cannot change accepted inputs. Regenerating a Spec during execution preserves active Build state.

The route only enqueues durable work; tests retain an injected fake-runner path. Default execution requires PostgreSQL and isolated Compose. Memory mode supports discovery and UI development, not host execution. Deployment: [local runtime](local-runtime.md). Requests: [API reference](api-reference.md).

## Execution sequence

The Worker claims a Build Attempt, then passes frozen inputs to `BuildPipeline`:

1. **Validate readiness.** Require completed call, captured Spec, permitted scope, durable runtime and GitHub publication credentials. Local discovery alone cannot make a repository buildable.
2. **Prepare pinned source.** Fetch the immutable commit into trusted temporary Git storage with partial clone and literal sparse checkout. Reject generated `SPEC.md`/`CONTEXT.md` collisions; exclusions stay in checkout-local `.git/info/exclude`.
3. **Checkpoint generation.** Persist `generating` before any model execution. Export only scoped, regular tracked files within 64 MiB; verify bytes against Git objects.
4. **Execute in a disposable container.** The restricted launcher fixes the image and limits resources, filesystem and network. Node/npm lockfile installation disables lifecycle scripts by default. Claude gets 80 turns and 15 minutes within a 30-minute attempt. The model gateway reserves estimated spending and checks lease ownership. An explicit npm test command must pass after generation.
5. **Validate output in trusted Git.** Receive only a bounded patch. Terminate/remove execution and revoke its credential before applying the patch in trusted checkout. Commit locally; validate ancestry and every changed path, including deletion and rename endpoints. Repository-controlled Git metadata never enters publication.
6. **Publish through the Worker.** Persist `push_pending` with validated SHA; recheck ownership, then push that exact SHA to the unique attempt branch. Persist `pushed`; reuse an existing PR or create a draft against the default branch. Recovery reuses these identities.
7. **Finish atomically.** Commit terminal attempt status, Session state and events together. Await subprocess/container termination before deleting temporary files. Persistence or ownership failure cancels execution.

Boundaries: [Build Attempt execution](../src/lib/build/attempt.ts), [pipeline orchestration](../src/lib/build/pipeline.ts), [workflow steps](../src/lib/build/workflow-steps.ts). Generated PRs never auto-merge.

## Recovery and ownership

Default lease: 15 minutes, renewed every 30 seconds. State writes require the current token and an unexpired lease. Worker shutdown or renewal failure aborts execution; Git and Claude receive the same cancellation signal. Expired attempts are reclaimed for checkpoint inspection.

| Checkpoint     | Recovery behavior                                                                         |
| -------------- | ----------------------------------------------------------------------------------------- |
| `queued`       | Preparation may restart; generation has not been checkpointed.                            |
| `generating`   | Fail with an explicit new-Build requirement. Never automatically repeat model generation. |
| `push_pending` | Compare the remote branch with the recorded generated SHA before recovering PR creation.  |
| `pushed`       | Verify the same remote SHA, then reuse or create the branch's draft PR.                   |

A missing published branch requires a new explicit Build; a different remote SHA requires human review. Legacy attempts lacking immutable inputs and branch identity fail, never regenerate. Temporary checkouts are not durable recovery artifacts. Older backups may contain queued attempts already generated since backup. Without publication checkpoints, those restored attempts require explicit new work.

Transient publication failures preserve branch, inputs, and generated SHA. Reconciliation gets five attempts with exponential delays capped at 60 seconds; the initial publication failure consumes none. Exhaustion sets `buildStatus: 'failed'` and exposes `buildRecovery` with attempt ID and retryability. Pending recovery keeps the Session `building`.

Retry publication without generation: send `POST /api/sessions/{id}/build` with operator cookie, `Content-Type: application/json`, and `{"retryAttemptId":"<attempt-id>"}`. Eligible failed publication attempts reset recovery, preserving identity and inputs. Acceptance returns `202 { accepted: true, recoveryOnly: true }`; ineligible or conflicting attempts return `409`. Normal Build requests create new attempts and can consume model quota.

## Complexity gate

The gate conservatively estimates from discovery evidence, independently of Repository Profile size and Scope Plan inventory. Default estimated lines: `session.filesRead.length * 50`. It never parses the Spec to infer change size.

| Size        | Estimated lines | Files read |
| ----------- | --------------- | ---------- |
| `small`     | < 500           | < 10       |
| `medium`    | < 2,000         | < 40       |
| `large`     | < 5,000         | < 100      |
| `too_large` | ≥ 5,000         | ≥ 100      |

Unresolved questions or `too_large` estimates block generation; open questions take precedence in `blockReason`. Blocked Builds return to `ready` because the Spec remains. Oversized estimates group available decision `relevantFiles` by first path segment into `splitSuggestion`, suggesting smaller proposals. Suggestions never replace confirmed scope or publication validation.

Assessment: [complexity.ts](../src/lib/session/complexity.ts). Shared event and assessment types: [Session types](../src/lib/session/types.ts).

## Dashboard events

Acceptance emits `build_started`; execution emits `build_progress` for cloning, fixed activities, and PR creation. Persist progress in order before consuming further runner output. The parser maps reading to `analyzing`, editing to `writing`, other activity to `reviewing`. The trusted runner stores fixed labels and sanitized errors, never arbitrary model commands or transcript fragments.

Terminal paths emit `build_complete`, `build_failed`, or `build_blocked` alongside corresponding `session_updated` state. Recovery updates `buildRecovery` through Session events; it never starts another generation stream. Render status and PR links from Session state, not signal events alone.

PostgreSQL events persist for replay. SSE reconnects retain their cursor, drain pages with backpressure, and combine periodic polling with notification wakeups. Session event boundary: [architecture](architecture.md).
