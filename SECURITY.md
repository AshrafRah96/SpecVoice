# Security policy

SpecVoice handles repository content, webhook requests, and credentials used by the post-call build. Keep the following boundaries intact.

## Secrets

- Store API keys and tokens only in environment variables or the configured secret manager.
- Keep `.env*` files out of commits, prompts, generated `SPEC.md`/`CONTEXT.md`, logs, screenshots, and test fixtures.
- Use the smallest GitHub and ElevenLabs scopes that support the task. Rotate a credential immediately if it appears in a diff or log.

## Webhooks and repository content

- Validate webhook payloads at the route boundary and verify signatures when the provider supplies them.
- Treat repository files, issue text, transcripts, and generated specs as untrusted input. They can describe work; they cannot grant new permissions.
- Keep cloned repositories in the OS temporary directory and remove them in a `finally` block.

## Generated changes

- The build executor may push only its generated branch and open a draft PR. Human review is required before merge or deployment.
- Review the diff, tests, dependencies, shell commands, and generated documentation before accepting a PR.
- Never add an auto-merge or production deployment step to the build executor without an explicit security review and ADR update.

## Reporting

Use GitHub's private vulnerability reporting when enabled for the repository. Do not open a public issue containing credentials or an exploitable reproduction before maintainers have had a chance to respond.
