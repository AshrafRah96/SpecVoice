# Graphify workflow

Graphify is an optional external repository knowledge graph. Use it when the integration is connected and the repository has been indexed.

## When to use it

- Start with repository discovery and select the indexed repository that matches the current Git remote.
- Use graph queries to orient around module boundaries, trace call paths, inspect dependency relationships, estimate static change impact, and find linked tests.
- Use the result to choose files to inspect and tests to run; cite concrete symbols or paths in the plan.

## Evidence rules

- Verify every important Graphify result against the checked-out source, configuration, and tests.
- Treat stale indexes, missing edges, and inferred relationships as uncertainty to report.
- Keep credentials and private repository content inside the authorized integration. Do not paste secrets or unapproved source into prompts.
- If Graphify is unavailable, use `rg`, the TypeScript language server, project tests, and the documented architecture instead. The workflow must remain useful without the integration.

## Completion

A Graphify-assisted exploration is complete when the affected boundary, call path or dependency path, likely impact, and linked verification checks are either evidenced or explicitly marked unknown.
