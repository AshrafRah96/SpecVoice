# Keep Claude Code execution post-call

The live voice conversation needs predictable webhook latency and produces a spec only after the discovery work is complete. Claude Code therefore runs only in the post-call build path, inside a temporary clone with an explicit tool allowlist; the application owns branch cleanup and draft PR creation. A direct Anthropic API implementation or in-call code generation would add a second executor, increase latency, and weaken the review boundary.

## Consequences

The dashboard must represent build progress asynchronously over SSE, and generated changes remain draft PRs for human review. Any future change to the executor boundary must revisit this ADR and the complexity gate.
