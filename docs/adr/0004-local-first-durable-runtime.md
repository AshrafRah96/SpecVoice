---
status: accepted
---

# Use a local-first durable runtime

> Execution isolation, authentication, retention and backup scheduling are refined by [ADR 0005](./0005-private-operator-and-hostile-execution.md). The following records the initial durable-runtime choice; its unimplemented-operations statements describe that earlier stage.

SpecVoice will run first as a single-tenant, self-hosted system managed by Docker Compose: a Next.js web process, one Dockerized worker, and local PostgreSQL. PostgreSQL is the durable source of truth for sessions, webhook receipts, build attempts, repository snapshots, and ordered session events; SQL migrations and small repository adapters keep the persistence boundary explicit. In-memory state is permitted only for tests and deliberate development mode. Production fails closed when PostgreSQL is unavailable.

SSE replays from the durable event log using `Last-Event-ID`; PostgreSQL `LISTEN/NOTIFY` is only a wakeup hint. The worker claims jobs with leases, reconciles partial publication after expiry. A checkpoint at generation start forbids automatic model replay; missing output requires an explicit new Build. One build runs at a time by default, with concurrency configurable later. The worker orchestrator owns branch pushes and draft PR creation; the Claude process does not receive those side effects.

Every Session pins an immutable Repository snapshot at session start. Repository profiling runs asynchronously; calls and Builds wait for profile readiness. Every partial profile requires confirmed scope, regardless of its apparent tier. Mid, large, and very-large repositories require an explicit Scope plan confirmed by the user before Build execution. Discovery may continue within its budget while confirmation is pending. Package lifecycle scripts are disabled by default inside the worker, which permits only allowlisted GitHub, model, and package-registry egress.

Offline deterministic safety evaluations run in CI. Live ElevenLabs evaluations run nightly or before release; LLM-score regressions warn rather than block unless a deterministic safety or contract check fails. The target retention policy is 30 days for transcripts, 180 days for metrics, and 7 days for repository indexes. Retention automation and stored evaluation score history are not implemented. Operators must schedule local PostgreSQL backups; the runbook documents backup and restore commands but does not install a scheduler.

## Considered options

- **AWS-managed queues and storage:** rejected for the initial deployment because the product must remain self-hostable and the current workload can use PostgreSQL-backed leases and events.
- **SQLite:** rejected as the durable runtime because concurrent web/worker queue claims and event ordering are clearer with PostgreSQL; it may still be used for isolated tests or future single-process demos.
- **One process for web and builds:** rejected because a restart would interrupt work and make recovery dependent on process memory.
- **Automatic full-repository indexing:** rejected because large repositories need bounded, user-confirmed scope and commit-pinned evidence.
- **Claude-owned Git push and PR creation:** rejected because provider side effects should be controlled by the worker’s resumable state machine.

## Consequences

The first deployment owns local database operations, backups, disk quotas, Docker updates, and monitoring. The public API can remain stable while repository and queue adapters evolve toward multiple workers or another deployment target later. The system intentionally remains single-tenant until authentication, ownership, and cross-tenant isolation are designed separately.
