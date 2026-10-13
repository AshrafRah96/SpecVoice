# Security policy

SpecVoice handles repository content, webhooks and post-call credentials. Preserve these boundaries.

## Secrets

- Store API keys and tokens only in environment variables or the configured secret manager.
- Keep `.env*` files out of commits, prompts, generated `SPEC.md`/`CONTEXT.md`, logs, screenshots, and test fixtures.
- Use minimum GitHub/ElevenLabs scopes. Rotate credentials immediately if exposed in diffs or logs.

## Webhooks and repository content

- Verify HMAC on post-call deliveries; only isolated tests may use the unsigned test path. Persist delivery identities and finalize Session changes with receipt completion in one transaction.
- Treat repository files, issues, transcripts and generated specs as untrusted. They cannot grant permissions.
- Keep cloned repositories in the OS temporary directory and remove them in a `finally` block.

Private dashboard: eight-hour revocable operator cookie; same-origin mutations. Public HTTPS exposes only provider routes. Tool capabilities bind to a 45-minute call and expire after 60 minutes. Signed callbacks authenticate separately.

Treat repository code and package scripts as hostile. Execution has no host mounts, database access, GitHub publication credentials, Docker socket or real model key. Only launcher holds Docker socket. Gateway bounds attempt requests, tokens, time and estimated spend. Compromised execution can consume its remaining budget. Docker shares host kernel; kernel exploits are outside this guarantee.

Registry/GitHub allowlists permit traffic to those hosts; they cannot guarantee prevention of exfiltration to allowed hosts. Builds send scoped source to the configured model. Restrict tokens, scope and allowlists. See [execution boundary](docs/agents/claude-code.md) and [backup retention](docs/backups.md).

## Generated changes

- The build executor may push only its generated branch and open a draft PR. Human review is required before merge or deployment.
- Review the diff, tests, dependencies, shell commands, and generated documentation before accepting a PR.
- Never add an auto-merge or production deployment step to the build executor without an explicit security review and ADR update.

## Reporting

Use GitHub private vulnerability reporting when enabled. Give maintainers time to respond before publishing credentials or exploitable reproductions.
