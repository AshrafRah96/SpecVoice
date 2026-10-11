# Graphify workflow

Graphify is installed locally and indexes this repository's code into `graphify-out/`. It is a navigation aid, not a source of truth.

## When to use it

- Start with `graphify-out/graph.json` when it exists.
- Use `graphify query "<question>"` for broad context, `graphify path "<source>" "<target>"` for a relationship, and `graphify explain "<concept>"` for one node.
- Use `graphify affected "<symbol>"` to inspect reverse impact before changing a shared boundary.
- After source changes, run `graphify update .`; use `graphify extract . --code-only --force` only when the graph needs a full rebuild.
- Use the result to choose files to inspect and tests to run; cite concrete symbols or paths in the plan.

## Setup

The Graphify CLI and skill stay global. From the repository root, install the local hooks once:

```bash
graphify hook install
```

This adds post-commit and post-checkout refresh hooks plus the `graph.json` merge driver. Remove them with `graphify hook uninstall`.

## Evidence rules

- Verify every important Graphify result against the checked-out source, configuration, and tests.
- Treat stale indexes, missing edges, and inferred relationships as uncertainty to report.
- Keep credentials and private repository content inside the authorized integration. Do not paste secrets or unapproved source into prompts.
- If Graphify is unavailable, use `rg`, the TypeScript language server, project tests, and the documented architecture instead. The workflow must remain useful without the integration.

## Outputs

- `graphify-out/graph.json`: queryable graph data.
- `graphify-out/GRAPH_REPORT.md`: generated architecture report.
- `graphify-out/graph.html`: local interactive visualization when exported.

The post-commit hook updates code relationships. Documentation changes still need `graphify update .` because the hook only covers code files.

## Completion

A Graphify-assisted exploration is complete when the affected boundary, call path or dependency path, likely impact, and linked verification checks are either evidenced or explicitly marked unknown.
