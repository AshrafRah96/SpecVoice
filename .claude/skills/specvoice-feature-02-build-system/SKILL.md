---
name: specvoice-feature-02-build-system
description: Use when working on the SpecVoice post-call build pipeline, the build route handler, complexity gate logic, BuildStatus transitions, ComplexityAssessment shape, or Claude Code CLI invocation. Also use when modifying SSE events emitted by the build system or when the task involves specOutput guards, file count derivation, or draft PR creation via Octokit.
---

## Overview

Post-call build pipeline triggered by `POST /api/sessions/[id]/build`. Returns 202 immediately; runs `BuildPipeline.run` in the background. Claude Code CLI execution is handled by `ClaudeProcessRunner`; workflow steps own cloning, build inputs, cleanup, and draft PR creation.

## File Map

| File                                       | Purpose                                             |
| ------------------------------------------ | --------------------------------------------------- |
| `src/app/api/sessions/[id]/build/route.ts` | Route handler — guards and starts the pipeline      |
| `src/lib/build/pipeline.ts`                | Validation, workflow sequencing, state transitions  |
| `src/lib/build/validate.ts`                | Complexity, prerequisite, and repository URL checks |
| `src/lib/build/process-runner.ts`          | Claude Code CLI process and progress parsing        |
| `src/lib/build/workflow-steps.ts`          | Clone, build inputs, draft PR, and cleanup steps    |

## Route Handler Flow (`route.ts`)

1. `buildStatus === 'building'` → 409
2. `!session.specOutput` → 400 `"No spec to build from."`
3. `setBuildStatus('building')` + broadcast `build_started` **synchronously**
4. Return 202
5. Background: `pipeline.run(id)` — validates, then runs workflow steps

## Complexity Gate

`fileCount = session.filesRead.length` (files the agent read during the call).

`lineEstimate = fileCount * 50`. Size thresholds:

| size      | lineEstimate | ~files |
| --------- | ------------ | ------ |
| small     | < 500        | < 10   |
| medium    | < 2000       | < 40   |
| large     | < 5000       | < 100  |
| too_large | ≥ 5000       | ≥ 100  |

Blocked when: `size === 'too_large'` OR `openQuestions.length > 0`.

After a complexity block: `setBuildStatus('ready')` — the spec still exists. Never set `'idle'`.

## `BuildPipeline` Orchestration

Validation and execution run in this order:

1. **Complexity** → `assessComplexity(session)` blocks unresolved questions or oversized sessions.
2. **Prerequisites** → `checkPrerequisites()` checks the Claude Code CLI, `ANTHROPIC_API_KEY`, and `GITHUB_TOKEN`.
3. **Repository URL** → sessions backed only by `repoLocalPath` fail with `"Session has no repository URL."`
4. **Clone and write inputs** → workflow steps use `os.tmpdir()` and write `SPEC.md` plus `CONTEXT.md`.
5. **Claude Code CLI** → `ClaudeProcessRunner` runs the bounded command and parses progress.
6. **Draft PR** → workflow steps call `createDraftPR()` via Octokit and complete the build.

## Claude Code Invocation

```bash
claude -p "<prompt>" \
  --output-format stream-json \
  --allowedTools "Read,Write,Edit,Bash(git *),Bash(npm test *),Bash(npx *)" \
  --max-turns 300
```

Spawned with `stdio: ['ignore', 'pipe', 'pipe']` — stdout is parsed as NDJSON and stderr is drained into logs and failure messages.

Git identity injected via env: `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` set to `SpecVoice / specvoice@noreply.github.com`.

The prompt instructs Claude Code to: read `SPEC.md` and `CONTEXT.md`, checkout a new branch, implement changes, run tests, fix failures, commit, push. **Does not create the PR itself** — that's done by `createDraftPR` after `ClaudeProcessRunner` resolves.

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
  lineEstimate: number // fileCount * 50
  size: 'small' | 'medium' | 'large' | 'too_large'
  blocked: boolean
  blockReason?: 'too_large' | 'open_questions'
  splitSuggestion?: string[][] // files grouped by top-level dir; only when too_large
}
```

## SSE Events

`build_started` → `build_progress { phase, detail }` → `build_complete { prUrl }` | `build_failed { error }` | `build_blocked { assessment }`

`BuildPhase`: `'analyzing' | 'writing' | 'reviewing' | 'cloning' | 'pr'`

`broadcastEvent` is public on `SessionStore`. Use it for signal events; use `updateSession()` for state changes.

## Common Mistakes

| #   | Wrong                                                         | Correct                                                                          |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | `setBuildStatus('error')`                                     | `setBuildStatus('failed')` — `'error'` is not in BuildStatus                     |
| 2   | `setBuildStatus('assessing')`                                 | `'assessing'` is not in BuildStatus; remove it                                   |
| 3   | `buildStatus = 'idle'` after complexity block                 | `buildStatus = 'ready'` — spec is still present                                  |
| 4   | Parse `specOutput` markdown to count files                    | `fileCount = session.filesRead.length`                                           |
| 5   | `session.specOutput ?? generateSpec(session)` in orchestrator | No fallback — no spec means no build                                             |
| 6   | Treat local-path sessions (`repoLocalPath`) as buildable      | They hit the `!session.repoUrl` fast-fail; only GitHub URL sessions can be built |
| 7   | Calling Anthropic API directly during build                   | Use Claude Code CLI (`claude -p ... --output-format stream-json`)                |
| 8   | Cleaning tmpDir inside try block                              | Always clean in `finally` — even on failure                                      |
