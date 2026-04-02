# Post-Call Build System

> Depends on: session types with BuildStatus (feature 01), post-call webhook setting buildStatus to 'ready' (feature 01), broadcastEvent on session store (feature 01)
> Blocked by: feature 01 (session type changes)
> Blocks: dashboard "Build it" button

## Files

New: `src/lib/build/complexity.ts`, `src/lib/build/executor.ts`, `src/lib/build/clone.ts`, `src/lib/build/github-pr.ts`, `src/lib/build/index.ts`, `src/app/api/sessions/[id]/build/route.ts`
Tests: `tests/build/complexity.test.ts`, `tests/build/executor.test.ts`, `tests/build/github-pr.test.ts` (skipped)
Modified: `src/lib/env.ts`, `.env.local.example`

**Session fields added by Feature 02:** `prUrl: string | null` and `complexityAssessment: ComplexityAssessment | null`, both defaulting to `null` on session creation. `ComplexityAssessment` is defined in `types.ts` alongside them. These fields are already in `Session` as of the Feature 01 + scaffold implementation — Feature 02 must not redeclare them locally.

## Why Claude Code, not raw API calls

I started designing this as a direct Anthropic API call: send spec + code context, get JSON with file changes, parse and commit. Then I realised I was building a worse version of Claude Code. It already reads codebases, writes files, runs tests, catches errors, and iterates until things pass. The `claude -p` headless mode gives me all of that. The `--output-format stream-json` flag lets me parse progress in real time for the dashboard.

Using Claude Code as an execution engine inside a product demonstrates the "AI first" principle.

## How it works

```
POST /api/sessions/{id}/build → 202 immediately
  → executeBuild(sessionId) runs in background
    → prerequisites check (claude binary, ANTHROPIC_API_KEY)
    → complexity assessment (file count, open questions)
    → clone repo to temp dir
    → write SPEC.md + CONTEXT.md into clone
    → spawn claude -p with implementation prompt
    → stream progress to dashboard via SSE
    → create draft PR from pushed branch
    → clean up temp dir (always, even on failure)
```

## Complexity gate

Scored by file count from the spec. Prevents "Claude Code runs for 10 minutes and produces garbage" scenarios.

Small (1-3 files): proceed. Medium (4-7): proceed. Large (8-12): proceed with warning. Too large (13+ files OR open questions remain): blocked with split suggestion grouping files by top-level directory.

Line estimate is `files × 50`. Rough heuristic. File count is the real signal.

Open questions force a block regardless of file count. If the planning conversation left things unresolved, the spec isn't ready for code generation.

After a complexity block, set `buildStatus` back to `'ready'`, not `'idle'`. The spec is still present and the session is actionable (the split suggestion is useful). `'idle'` means "no spec yet" — that signals the wrong state to the dashboard.

The `ComplexityAssessment` interface:

```typescript
interface ComplexityAssessment {
  fileCount: number
  openQuestionCount: number
  lineEstimate: number          // fileCount * 50
  size: 'small' | 'medium' | 'large' | 'too_large'
  blocked: boolean
  blockReason?: 'too_large' | 'open_questions'
  splitSuggestion?: string[][]  // files grouped by top-level directory, only when blocked
}
```

File count comes from `session.decisions.flatMap(d => d.relevantFiles)` deduplicated with a `Set`. Never parse `specOutput` markdown to recover this data.

## SPEC.md and CONTEXT.md

Two files written into the cloned repo root before Claude Code runs.

**SPEC.md:** Raw spec output from `generate_spec`. The structured PR description.

**CONTEXT.md:** Conversation transcript plus every decision with rationale, alternatives, and relevant files. Gives Claude Code the "why" behind each decision. If the spec says "use Postgres," the context says "we considered Redis but rejected it because the existing setup handles this load."

The prompt references both: "Read SPEC.md for what to implement and CONTEXT.md for why each decision was made."

## Claude Code invocation

```
claude -p "<prompt>" \
  --output-format stream-json \
  --allowedTools "Read,Write,Edit,Bash(git *),Bash(npm test *),Bash(npx *)" \
  --max-turns 30
```

The prompt tells Claude Code to: implement the spec, follow existing patterns, handle edge cases, run tests, fix failures, create a branch named `spec-voice/<feature-slug>`, commit, and push to origin.

Stream-json output is parsed line by line. Tool use events map to SSE progress broadcasts: Read → "Reading src/...", Write/Edit → "Writing src/...", Bash npm test → "Running tests...", post-failure Bash → "Fixing test failure..."

## Branch naming

`spec-voice/<slugified-first-decision-summary>`. Example: `spec-voice/add-payment-webhook`. Fallback: `spec-voice/<session-id-first-8-chars>`.

## PR creation

Always a draft via Octokit. Never auto-merge. Spec is the PR body so reviewers see what was planned alongside what was built. Created after Claude Code pushes the branch.

## Concurrency guard

Build route sets `buildStatus: 'building'` synchronously before returning 202. Second POST while building gets 409. `'assessing'` does not exist in the `BuildStatus` union — it was cut as over-engineering. The gap between returning 202 and `executeBuild` setting `'building'` is sub-millisecond and invisible to the user.

## Temp directory

`fs.mkdtemp` in OS temp. Cleaned up in a `finally` block, always, even on failure.

## Prerequisites

Checked before any work:
1. `claude --version` exits 0 → if not: `build_failed` with install message
2. `ANTHROPIC_API_KEY` set → if not: `build_failed` with env message

These use `build_failed`, not `build_blocked`. `build_blocked` is reserved for spec-content issues that have a ComplexityAssessment attached.

## SSE events

```
session_updated  — existing, fires on any session mutation
build_started    — build kicked off
build_progress   — phase + detail for dashboard progress indicator
build_complete   — done, includes PR URL
build_failed     — error string
build_blocked    — ComplexityAssessment with split suggestion
```

`broadcastEvent(sessionId, event)` is already public on the store — Feature 01 made it public. Do not redefine it. Build operations call it directly.

## Constraints

Never call Anthropic API directly. Claude Code headless mode only.
Never clone into the server's own directory. Always temp dir.
Always create PRs as draft. Never auto-merge.
Never run code generation during the voice call. Build is post-call only.
Never use WebSockets. SSE only.
If session is deleted mid-build, log warning and return. Don't throw.

## What this doesn't do

No code review feedback loop. PR gets created, done.
No automatic retry. Developer can click "Build it" again manually.
No partial builds. Whole spec built in one go even for "large" complexity.
No code generation during the call. Phone call produces the spec, build is async after.

## Done when

- POST `/api/sessions/{id}/build` returns 202 and SSE broadcasts `build_started`
- Complexity assessment blocks a session with 13+ affected files and broadcasts `build_blocked` with split suggestion
- Missing `claude` binary returns `build_failed` with install instructions
- Missing `ANTHROPIC_API_KEY` returns `build_failed` with env message
- A session with a valid spec triggers clone → Claude Code → draft PR → `build_complete` with PR URL
- Second POST while building returns 409
- Temp directory is cleaned up even when build fails
- `npm run build` clean, `npm test` passes including complexity and executor tests