# Ponytail workflow

Ponytail is installed globally. Do not copy its skills into this repository.

Use `/ponytail` for implementation work. It chooses the smallest complete change after tracing the affected flow. It keeps validation, error handling, security, accessibility, and tests for risky logic. Use `/ponytail-review` for a connected code review and `/ponytail-debt` to list deliberate `shortcut:` comments.

Mark a deliberate ceiling in code with:

```text
shortcut: <limit>, <upgrade path>
```

The repository's source, tests, `AGENTS.md`, and security policy remain authoritative. Ponytail can reduce implementation scope; it cannot remove a required behavior or verification check.
