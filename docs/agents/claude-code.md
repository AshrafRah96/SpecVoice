# Claude Code integration

Use this document when changing the post-call build executor or ElevenLabs integration. The provider-neutral workflow remains in `AGENTS.md`.

## Source of truth

- Check the installed ElevenLabs SDK declaration files under `node_modules/@elevenlabs/elevenlabs-js/dist/api/types/` before writing SDK calls.
- Keep the agent system prompt in `docs/system-prompt.md`; the loader is not the authoring surface.
- Keep agent-facing and server-facing tool names aligned with `docs/agents/elevenlabs-tools.md`.

## Build boundary

The voice conversation produces a spec. The post-call executor clones the repository into `os.tmpdir()`, writes `SPEC.md` and `CONTEXT.md`, runs Claude Code in headless mode with the allowlisted tools, pushes a generated branch, and opens a draft PR. It cleans the temporary directory in `finally` and never auto-merges.

The build route remains asynchronous and reports progress over SSE. Do not move code generation into a live voice conversation or replace the CLI boundary with a direct Anthropic API call without an ADR that revisits ADR-0002.

## Runtime invariants

- Validate all webhook input with Zod and resolve the session before side effects.
- Use the `SessionStore` and `CodeSource` singletons through their existing `globalThis` pattern.
- Broadcast after session mutations so the dashboard stays current.
- Preserve the post-call HTTP 200 behavior for business-logic failures because ElevenLabs retries non-200 responses.
