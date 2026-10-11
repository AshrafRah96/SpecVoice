# Claude Code adapter

Read [AGENTS.md](./AGENTS.md) before making changes. It is the provider-neutral contract for this repository. This file adds Claude Code routing and project-specific pointers; it is not a second source of truth.

## Claude Code context

- Read `docs/agents/claude-code.md` when changing the post-call build executor or ElevenLabs integration.
- Read the matching `.claude/skills/*/SKILL.md` before changing the dashboard, E2E suite, agent configuration, or build pipeline.
- Keep vendor-specific facts in `docs/agents/claude-code.md` or the relevant `.claude/skills` file. Update `AGENTS.md` only for provider-neutral workflow and safety rules.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. Read `GLOSSARY.md` and relevant ADRs under `docs/adr/` before changing domain behavior. See `docs/agents/domain.md`.

## Project invariants

- No vector database, embeddings, or RAG. The agent reads code through tools on demand.
- Tool webhook configuration, server handlers, and the dynamic route remain separate. See `docs/agents/elevenlabs-tools.md` for the intentional name mapping.
- The dashboard uses SSE. The build pipeline runs post-call only and uses the Claude Code CLI boundary recorded in ADR-0002.
- Clone repositories into `os.tmpdir()` and clean them in `finally`.
- Use shared types, Zod validation, the existing `globalThis` singleton pattern, and token-based Tailwind colors.
- Use the global Ponytail skill for implementation discipline; see [Ponytail workflow](./docs/agents/ponytail.md).
