# Documentation map

Start with [README.md](../README.md): setup, commands, product flow.

## Current docs

- [Tutorial](./TUTORIAL.md): run one voice session from setup to draft PR.
- [Architecture](./architecture.md): system boundaries and data flow. [Interactive diagram](./diagrams/specvoice-architecture.html), [SVG](./diagrams/specvoice-architecture.svg).
- [API reference](./api-reference.md): routes, payloads, responses, and SSE events.
- [Build pipeline](./build-pipeline.md): post-call complexity gate, Claude Code execution, and draft PR flow.
- [Extending](./extending.md): add tools, session fields, and SSE events.
- [Manual smoke test](./testing/manual-smoke.md): exercise the HTTP and SSE path locally.
- [Local durable runtime](./local-runtime.md): run Compose, migrations, backups, and restore locally.
- [Backups and retention](./backups.md): encrypted second-disk/NAS backups, disposable restore drills, and expiry.
- [Repository scale](./repository-scale.md): profile large repositories and confirm bounded scopes.
- [Evaluation](./evaluation.md): run secret-free deterministic regression fixtures.
- [System prompt](./system-prompt.md): runtime prompt loaded by `src/lib/agent/system-prompt.ts`.

## Agent guidance

- [Agent contract](../AGENTS.md): provider-neutral workflow and safety rules.
- [Claude Code adapter](../CLAUDE.md): Claude-specific routing.
- [Claude Code integration](./agents/claude-code.md): post-call executor boundary.
- [ElevenLabs tool names](./agents/elevenlabs-tools.md): agent-to-route name mapping.
- [Graphify workflow](./agents/graphify.md): repository topology and impact workflow.
- [Ponytail workflow](./agents/ponytail.md): global lean implementation discipline.
- [Issue tracker](./agents/issue-tracker.md): GitHub Issues conventions.
- [Domain docs](./agents/domain.md): glossary and ADR rules.

## Decisions and security

- [Glossary](../GLOSSARY.md): canonical domain terms.
- [ADRs](./adr/): durable architectural decisions.
- [ADR 0004: Local-first durable runtime](./adr/0004-local-first-durable-runtime.md): self-hosted Compose, PostgreSQL, workers, scoped repositories, and recovery rules.
- [ADR 0005: Private operator and hostile execution](./adr/0005-private-operator-and-hostile-execution.md): operator login, disposable execution, model budgets, retention, and external local recovery.
- [Operational hardening](./operational-hardening-plan.md): approved delivery phases and verified evidence.
- [Contributing](../CONTRIBUTING.md): local checks and pull requests.
- [Security](../SECURITY.md): secrets, webhooks, and generated changes.

## Historical notes

[DX audit](./DX-AUDIT.md) and [ElevenLabs SDK notes](./elevenlabs-sdk-holes.md): historical evidence. Verify against installed SDK and current source before acting.

## Research

- [Production-readiness research](./research/specvoice-production-readiness.md): durable architecture, AI evaluation, secure execution, webhook recovery, observability, and repository-scale support.
