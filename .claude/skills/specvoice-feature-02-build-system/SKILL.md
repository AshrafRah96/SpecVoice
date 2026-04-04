---
name: specvoice-feature-02-build-system
description: Use when working on the SpecVoice post-call build pipeline, the build route handler, complexity gate logic, BuildStatus transitions, ComplexityAssessment shape, or Claude Code CLI invocation. Also use when modifying SSE events emitted by the build system or when the task involves specOutput guards, file count derivation, or draft PR creation via Octokit.
---

## Overview

Post-call build pipeline triggered by `POST /api/sessions/[id]/build`. Returns 202 immediately; runs `runGatedBuild` in the background. The real Claude Code CLI integration is **fully implemented** via `executeBuild` in `src/lib/build/executor.ts`. There is no simulation stub — the previous `simulateBuild` has been replaced.

## File Map

| File | Purpose |
|---|---|
| `src/app/api/sessions/[id]/build/route.ts` | Route handler — guards, complexity gate, calls `executeBuild` |
| `src/lib/build/executor.ts` | Main orchestration: prerequisites, clone, Claude Code CLI, PR |
| `src/lib/build/clone.ts` | `cloneRepo(repoUrl)` → tmpdir, `cleanupTmpDir(dir)` |
| `src/lib/build/github-pr.ts` | `createDraftPR(opts)` via Octokit |
| `src/lib/build/index.ts` | Re-exports `executeBuild` |

## Route Handler Flow (`route.ts`)

1. `buildStatus === 'building'` → 409
2. `!session.specOutput` → 400 `"No spec to build from."`
3. `setBuildStatus('building')` + broadcast `build_started` **synchronously**
4. Return 202
5. Background: `runGatedBuild(id)` — runs complexity gate, then `executeBuild`

## Complexity Gate

`fileCount = session.filesRead.length` (files the agent read during the call).

`lineEstimate = fileCount * 50`. Size thresholds:

| size | lineEstimate | ~files |
|---|---|---|
| small | < 500 | < 10 |
| medium | < 2000 | < 40 |
| large | < 5000 | < 100 |
| too_large | ≥ 5000 | ≥ 100 |

Blocked when: `size === 'too_large'` OR `openQuestions.length > 0`.

After a complexity block: `setBuildStatus('ready')` — the spec still exists. Never set `'idle'`.

## `executeBuild` Orchestration

Guards run in this order, each emitting `build_failed` on failure:

1. **Prerequisites** (`checkPrerequisites()`): `claude --version` must succeed, `ANTHROPIC_API_KEY` must be set, `GITHUB_TOKEN` must be set.
2. **`!session.repoUrl`** → fast-fail with `"Session has no repository URL."` Sessions backed by a local path (`repoLocalPath`) hit this guard.
3. **Clone** → `cloneRepo(session.repoUrl)` into `os.tmpdir()`, always cleaned in `finally`.
4. **Write build inputs** → `writeBuildFiles(dir, session)` writes `SPEC.md` (raw spec) and `CONTEXT.md` (decisions + transcript) into the cloned dir.
5. **Claude Code CLI** → `runClaudeCode(...)` (see below).
6. **Draft PR** → `createDraftPR(...)` via Octokit; sets `buildStatus: 'complete'` and broadcasts `build_complete { prUrl }`.

## Claude Code Invocation

```bash
claude -p "<prompt>" \
  --output-format stream-json \
  --allowedTools "Read,Write,Edit,Bash(git *),Bash(npm test *),Bash(npx *)" \
  --max-turns 30
```

Spawned with `stdio: ['ignore', 'pipe', 'inherit']` — stdout piped for NDJSON parsing, stderr inherited to server logs.

Git identity injected via env: `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` set to `SpecVoice / specvoice@noreply.github.com`.

The prompt instructs Claude Code to: read `SPEC.md` and `CONTEXT.md`, checkout a new branch, implement changes, run tests, fix failures, commit, push. **Does not create the PR itself** — that's done by `createDraftPR` after `runClaudeCode` resolves.

Progress is streamed: each `tool_use` block in the NDJSON output calls `onProgress(phase, detail)` → broadcasts `build_progress` SSE event. Phase is derived by `phaseFromTool(name)`:

- `Read, Glob, Grep` → `'analyzing'`
- `Write, Edit, MultiEdit, NotebookEdit` → `'writing'`
- everything else → `'reviewing'`

## Branch Name

`spec-voice/<slugified-first-decision-summary>` or `spec-voice/<session-id-first-8>` if no decisions.

## ComplexityAssessment Shape

Defined in `src/lib/session/types.ts`:

```typescript
interface ComplexityAssessment {
  fileCount: number
  openQuestionCount: number
  lineEstimate: number          // fileCount * 50
  size: 'small' | 'medium' | 'large' | 'too_large'
  blocked: boolean
  blockReason?: 'too_large' | 'open_questions'
  splitSuggestion?: string[][]  // files grouped by top-level dir; only when too_large
}
```

## SSE Events

`build_started` → `build_progress { phase, detail }` → `build_complete { prUrl }` | `build_failed { error }` | `build_blocked { assessment }`

`BuildPhase`: `'analyzing' | 'writing' | 'reviewing' | 'cloning' | 'pr'`

`broadcastEvent` is already public from Feature 01. Do not redefine it.

## Common Mistakes

| # | Wrong | Correct |
|---|-------|---------|
| 1 | `setBuildStatus('error')` | `setBuildStatus('failed')` — `'error'` is not in BuildStatus |
| 2 | `setBuildStatus('assessing')` | `'assessing'` is not in BuildStatus; remove it |
| 3 | `buildStatus = 'idle'` after complexity block | `buildStatus = 'ready'` — spec is still present |
| 4 | Parse `specOutput` markdown to count files | `fileCount = session.filesRead.length` |
| 5 | `session.specOutput ?? generateSpec(session)` in orchestrator | No fallback — no spec means no build |
| 6 | Treat local-path sessions (`repoLocalPath`) as buildable | They hit the `!session.repoUrl` fast-fail; only GitHub URL sessions can be built |
| 7 | Calling Anthropic API directly during build | Use Claude Code CLI (`claude -p ... --output-format stream-json`) |
| 8 | Cleaning tmpDir inside try block | Always clean in `finally` — even on failure |
