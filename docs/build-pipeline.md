# Build Pipeline

The post-call build pipeline takes a completed PR spec and turns it into a draft pull request. This document covers the implementation, the complexity gate that guards it, and the SSE event sequence the dashboard consumes.

---

## Implementation

The build route at [src/app/api/sessions/[id]/build/route.ts](../src/app/api/sessions/%5Bid%5D/build/route.ts) calls `executeBuild()` from `src/lib/build/executor.ts`. The `simulateBuild` stub has been removed.

### Orchestration sequence

Guards run in this order, each emitting `build_failed` on failure:

1. **Prerequisites** — `claude --version` must succeed; `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` must be set
2. **Repo URL check** — sessions with only `repoLocalPath` (no `repoUrl`) fast-fail: `"Session has no repository URL."`
3. **Clone** — `cloneRepo(session.repoUrl)` into `os.tmpdir()`; cleaned up in `finally`
4. **Write build inputs** — `writeBuildFiles(dir, session)` writes `SPEC.md` (raw spec) and `CONTEXT.md` (decisions + transcript) into the clone dir, and appends both to `.gitignore` so they don't appear in the PR diff
5. **Claude Code CLI** — spawned in headless mode (see below); `tool_use` events in the NDJSON output are mapped to SSE `build_progress` events
6. **Draft PR** — `createDraftPR()` via Octokit; sets `buildStatus: 'complete'` and broadcasts `build_complete { prUrl }`

This is post-call only. The pipeline is never triggered during an active voice conversation.

### Claude Code invocation

```bash
claude -p "<prompt>" \
  --output-format stream-json \
  --verbose \
  --allowedTools "Read,Write,Edit,Bash(git *),Bash(npm test *),Bash(npx *)" \
  --max-turns 300
```

Spawned with `stdio: ['ignore', 'pipe', 'pipe']` — stdout piped for NDJSON parsing; stderr drained line-by-line (avoids 64KB buffer deadlock) and included in error messages on non-zero exit. Git identity injected via `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` env vars.

The prompt instructs Claude Code to: read `SPEC.md` and `CONTEXT.md`, checkout a new branch, implement changes, run tests, fix failures, commit, and push. The PR is opened by `createDraftPR()` after `runClaudeCode()` resolves — not by Claude Code itself.

### Branch naming

`spec-voice/<slugified-first-decision-summary>` or `spec-voice/<session-id[:8]>` if no decisions.

### Phase mapping

Each `tool_use` block in the NDJSON output emits a `build_progress` SSE event. Phase derived by `phaseFromTool(name)`:

| Tools | Phase |
|---|---|
| `Read, Glob, Grep` | `'analyzing'` |
| `Write, Edit, MultiEdit, NotebookEdit` | `'writing'` |
| everything else | `'reviewing'` |

Cloning and PR creation emit `'cloning'` and `'pr'` directly.

---

## Complexity gate

Before any build work starts, `runGatedBuild()` calls `assessComplexity(session)`. This runs synchronously and may block the build before a single line of code is generated.

### Gate logic

```typescript
fileCount    = session.filesRead.length      // files the agent read during the call
lineEstimate = fileCount * 50
```

| `size` | `lineEstimate` | ~files read |
|---|---|---|
| `small` | < 500 | < 10 |
| `medium` | < 2000 | < 40 |
| `large` | < 5000 | < 100 |
| `too_large` | ≥ 5000 | ≥ 100 |

**Blocked when** either condition is true:
- `size === 'too_large'`
- `session.openQuestions.length > 0`

When blocked, `buildStatus` resets to `'ready'` (not `'idle'` — the spec still exists). The `build_blocked` SSE event carries the full `ComplexityAssessment`.

### `splitSuggestion`

Only populated when `blockReason === 'too_large'`. Groups the relevant files from all decisions by top-level directory:

```typescript
splitSuggestion = session.decisions
  .flatMap(d => d.relevantFiles)
  .groupBy(path => path.split('/')[0])  // top-level dir
```

This gives the developer a suggested way to split the spec into smaller, independently buildable pieces.

### `ComplexityAssessment` shape

Defined in [src/lib/session/types.ts](../src/lib/session/types.ts):

```typescript
interface ComplexityAssessment {
  fileCount: number
  openQuestionCount: number
  lineEstimate: number
  size: 'small' | 'medium' | 'large' | 'too_large'
  blocked: boolean
  blockReason?: 'too_large' | 'open_questions'
  splitSuggestion?: string[][]   // files grouped by top-level directory
}
```

---

## Route guards

Enforced in order before any build work:

| Check | Response |
|---|---|
| `session.buildStatus === 'building'` | `409 { error: "Build already in progress..." }` |
| `!session.specOutput` | `400 { error: "No spec to build from." }` |

`buildStatus` is set to `'building'` synchronously — before the 202 is returned. This ensures the 409 guard works correctly if a second request arrives before the async build resolves.

---

## SSE event sequence

A successful unblocked build:

```
build_started
build_progress { phase: 'analyzing', detail: '...' }
build_progress { phase: 'writing',   detail: '...' }
build_progress { phase: 'reviewing', detail: '...' }
build_progress { phase: 'cloning',   detail: '...' }
build_progress { phase: 'pr',        detail: '...' }
session_updated { buildStatus: 'complete', prUrl: '...' }
build_complete  { prUrl: '...' }
```

A blocked build:

```
build_started
session_updated { buildStatus: 'ready', complexityAssessment: {...} }
build_blocked   { assessment: {...} }
```

A failed build:

```
build_started
build_progress { phase: 'cloning', detail: '...' }
session_updated { buildStatus: 'failed' }
build_failed    { error: '...' }
```

The `session_updated` event always carries the authoritative state. `build_complete` and `build_failed` are signals; the dashboard should render from `session.buildStatus` and `session.prUrl`, not from the signal events alone.

---

## Common mistakes

| Wrong | Correct |
|---|---|
| `setBuildStatus('error')` | `setBuildStatus('failed')` — `'error'` is not in `BuildStatus` |
| `buildStatus = 'idle'` after a complexity block | `buildStatus = 'ready'` — the spec still exists |
| Call the Anthropic API directly for code generation | Use `claude -p ... --output-format stream-json` CLI in headless mode — never import `anthropic` in the build path |
| Skip the `finally` cleanup for the temp dir | Always clean up — failed clones leave large directories in `os.tmpdir()` |
