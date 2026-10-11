# Canonical agent contract and least-privilege execution

SpecVoice is developed with multiple coding agents, while the build pipeline can execute generated changes with shell access. We use a provider-neutral `AGENTS.md` as the contract for inspection, planning, verification, secrets, and side effects, with vendor-specific guidance behind pointers and bounded permissions. This keeps behavior consistent across agents and makes external effects reviewable without denying the post-call workflow the capabilities it needs.

## Consequences

Agents must inspect the glossary and relevant ADRs, verify changes, and report their evidence. The contract adds a small documentation surface, but it prevents vendor-specific instructions from becoming the accidental source of truth.
