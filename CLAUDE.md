# Claude Code adapter

Read [AGENTS.md](./AGENTS.md) before changes: the provider-neutral contract. This file adds Claude Code routing and project pointers, not another source of truth.

## Claude Code context

- Read `docs/agents/claude-code.md` when changing the post-call build executor or ElevenLabs integration.
- Read matching `.claude/skills/*/SKILL.md` before changing dashboard, E2E suite, agent configuration, or build pipeline.
- Keep vendor-specific facts in `docs/agents/claude-code.md` or relevant `.claude/skills` files. Update `AGENTS.md` only for provider-neutral workflow and safety rules.

## Agent skills

### Issue tracker

Issues and specs: GitHub Issues, via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo. Before domain behavior changes, read `GLOSSARY.md` and relevant ADRs under `docs/adr/`. See `docs/agents/domain.md`.

## Project invariants

- No vector database, embeddings, or RAG. Agent reads code through tools on demand.
- Keep tool webhook configuration, server handlers, and dynamic route separate. Intentional name mapping: `docs/agents/elevenlabs-tools.md`.
- Dashboard: SSE. Build pipeline: post-call only, within ADR-0002's Claude Code CLI boundary.
- Clone repositories into `os.tmpdir()`; clean in `finally`.
- Use shared types, Zod validation, existing `globalThis` singleton pattern, and token-based Tailwind colors.
- Use global Ponytail for implementation discipline; see [Ponytail workflow](./docs/agents/ponytail.md).
