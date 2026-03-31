---
name: specvoice-feature-02-build-system
description: Use when working on the SpecVoice post-call build pipeline, the build route handler, complexity gate logic, BuildStatus transitions, ComplexityAssessment shape, or Claude Code CLI invocation. Also use when modifying SSE events emitted by the build system or when the task involves specOutput guards, file count derivation, or draft PR creation via Octokit.
---

## Overview

Post-call build pipeline triggered by `POST /api/sessions/[id]/build`. Returns 202 immediately; runs `runGatedBuild` in background. Currently a **simulation stub** (`simulateBuild`). Real Claude Code CLI integration is not yet implemented.

## Current State

`src/app/api/sessions/[id]/build/route.ts` contains `simulateBuild` (3x 1.5s phases). Do not treat the stub as the final design.

## Complexity Gate

`fileCount = session.filesRead.length` (files the agent read during the call).

`lineEstimate = fileCount * 50`. Size thresholds on lineEstimate:

| size | lineEstimate | ~files |
|---|---|---|
| small | < 500 | < 10 |
| medium | < 2000 | < 40 |
| large | < 5000 | < 100 |
| too_large | ≥ 5000 | ≥ 100 |

Blocked when: `size === 'too_large'` OR `openQuestions.length > 0`.

`splitSuggestion` (only when `too_large`): `session.decisions.flatMap(d => d.relevantFiles)` grouped by top-level directory.

After a complexity block: set `buildStatus = 'ready'` — the spec still exists. Never set `'idle'`.

## Route Guards (enforced in order)

1. `buildStatus === 'building'` → 409
2. `!session.specOutput` → 400 `"No spec to build from."`

Set `buildStatus: 'building'` **synchronously** before returning 202.

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
  splitSuggestion?: string[][]  // files grouped by top-level dir
}
```

## Claude Code Invocation (when implemented)

```bash
claude -p "<prompt>" \
  --output-format stream-json \
  --allowedTools "Read,Write,Edit,Bash(git *),Bash(npm test *),Bash(npx *)" \
  --max-turns 30
```

Never call the Anthropic API directly. Temp dir: `fs.mkdtemp(os.tmpdir())`, always cleaned in `finally`. Draft PR via Octokit; branch: `spec-voice/<slugified-first-decision>`.

## SSE Events

`build_started` → `build_progress {phase, detail}` → `build_complete {prUrl}` | `build_failed` | `build_blocked {assessment}`

`BuildPhase`: `'analyzing' | 'writing' | 'reviewing' | 'cloning' | 'pr'`

`broadcastEvent` is already public from Feature 01. Do not redefine it.

## Common Mistakes

| # | Wrong | Correct |
|---|-------|---------|
| 1 | `setBuildStatus('error')` | `setBuildStatus('failed')` — `'error'` is not in BuildStatus |
| 2 | `{ level: 'low'\|'high'; reasoning: string }` for ComplexityAssessment | Use full shape from types.ts (fileCount, openQuestionCount, lineEstimate, size, blocked, blockReason, splitSuggestion) |
| 3 | `buildStatus = 'idle'` after complexity block | `buildStatus = 'ready'` — spec is still present |
| 4 | Parse `specOutput` markdown to count files | `fileCount = session.filesRead.length`; `decisions.flatMap` is only for `splitSuggestion` |
| 5 | Adding `'assessing'` to BuildStatus union | `'assessing'` does not exist; remove it |
| 6 | Allow build to start when `specOutput` is null | Guard with 400 `"No spec to build from."` before any other work |
| 7 | `session.specOutput ?? generateSpec(session)` in orchestrator | Remove the fallback entirely; no spec means no build |
