# Documentation map

Read [README.md](../README.md) first for setup, commands, and the product path.

## Current docs

- [Tutorial](./TUTORIAL.md): run one voice session from setup to draft PR.
- [Architecture](./architecture.md): system boundaries and data flow.
- [API reference](./api-reference.md): routes, payloads, responses, and SSE events.
- [Build pipeline](./build-pipeline.md): post-call complexity gate, Claude Code execution, and draft PR flow.
- [Extending](./extending.md): add tools, session fields, and SSE events.
- [Manual smoke test](./testing/manual-smoke.md): exercise the HTTP and SSE path locally.
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
- [Contributing](../CONTRIBUTING.md): local checks and pull requests.
- [Security](../SECURITY.md): secrets, webhooks, and generated changes.

## Historical notes

[DX audit](./DX-AUDIT.md) and [ElevenLabs SDK notes](./elevenlabs-sdk-holes.md) record discoveries from development. They are evidence, not current instructions. Verify them against the installed SDK and source before acting.
