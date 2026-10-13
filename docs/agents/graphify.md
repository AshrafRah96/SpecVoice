# Graphify workflow

Locally installed Graphify indexes repository code into `graphify-out/`. Use for navigation, not as a source of truth.

## When to use it

- Start with `graphify-out/graph.json` when it exists.
- Use `graphify query "<question>"` for broad context, `graphify path "<source>" "<target>"` for a relationship, and `graphify explain "<concept>"` for one node.
- Use `graphify affected "<symbol>"` to inspect reverse impact before changing a shared boundary.
- After source changes, run `npm run graphify:refresh`. The repository adapter invokes `graphify update .` while retaining source directories named `build`, checks coverage, and exports HTML.
- Choose files and tests from results; cite concrete symbols or paths in the plan.

## Setup

Graphify CLI and skill stay global. Install local hooks once from the repository root:

```bash
graphify hook install
```

Adds post-commit and post-checkout refresh hooks plus the `graph.json` merge driver. Remove with `graphify hook uninstall`.

## Evidence rules

- Verify every important Graphify result against the checked-out source, configuration, and tests.
- Report uncertainty from stale indexes, missing edges, and inferred relationships.
- Keep credentials and private repository content inside the authorized integration. Do not paste secrets or unapproved source into prompts.
- If Graphify is unavailable, use `rg`, the TypeScript language server, project tests, and documented architecture. The workflow must remain useful without Graphify.

## Outputs

- `graphify-out/graph.json`: queryable graph data.
- `graphify-out/GRAPH_REPORT.md`: generated architecture report.
- `graphify-out/graph.html`: local interactive visualization when exported.

The post-commit hook updates code relationships. Documentation semantics require the Graphify skill’s `/graphify --update` flow; the CLI `update` command refreshes code only.

## Source directories named build

The global extractor normally prunes directories named `build`. `scripts/graphify-refresh.py` overrides this only in its own process for `src/lib/build`, `tests/lib/build`, and the Build route. Global installation and skill stay unchanged; dependency/generated directories and secret filters remain active. Run `python3 scripts/graphify-refresh.py --check` to verify detection independently.

The wrapper checks all Build source/test files before extraction and verifies their evidence in the refreshed graph. It pins the Python hash seed before invoking Graphify; upstream interpreter restarts cannot discard the override. If Graphify changes its private detection interface, coverage checks fail visibly. Update or remove the adapter when the upstream heuristic is fixed.

Unwrapped global hooks may still omit these modules. Use the repository refresh command after hook updates before drawing architecture conclusions. The refresh is code-only and uses no provider calls; semantic documentation extraction remains separate. Graph edges are navigation evidence, not proof of runtime safety.

## Completion

Complete when the affected boundary, call or dependency path, likely impact, and linked verification checks have evidence or are explicitly unknown.
