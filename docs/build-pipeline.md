# Build Pipeline

The post-call build pipeline takes a completed PR spec and turns it into a draft pull request. This document covers the current state (a simulation stub), the intended real implementation, the complexity gate that guards it, and the SSE event sequence the dashboard consumes.

---

## Current state

The build route at [src/app/api/sessions/[id]/build/route.ts](../src/app/api/sessions/%5Bid%5D/build/route.ts) currently calls `simulateBuild()` — three phases with 1.5s delays, ending in a placeholder PR URL. **This is not the final design.**

```typescript
// Current stub — do not treat as final
async function simulateBuild(sessionId: string) {
  const phases = [
    { phase: 'analyzing', detail: 'Parsing spec decisions and identifying affected modules' },
    { phase: 'writing',   detail: 'Generating implementation scaffold' },
    { phase: 'reviewing', detail: 'Running static checks' },
  ]
  for (const { phase, detail } of phases) {
    await new Promise(r => setTimeout(r, 1500))
    sessionStore.broadcastEvent(sessionId, { type: 'build_progress', phase, detail })
  }
  const prUrl = 'https://github.com/placeholder/pr/1'
  sessionStore.updateSession(sessionId, { prUrl, buildStatus: 'complete' })
  sessionStore.broadcastEvent(sessionId, { type: 'build_complete', sessionId, prUrl })
}
```

The complexity gate, route guards, and SSE event sequence are all fully implemented. Only the actual code generation is stubbed.

---

## Intended implementation

The real pipeline will replace `simulateBuild()` with a Claude Code CLI invocation:

```bash
claude -p "<spec prompt>" \
  --output-format stream-json \
  --allowedTools "Read,Write,Edit,Bash(git *),Bash(npm test *),Bash(npx *)" \
  --max-turns 30
```

The full sequence:

1. **Clone** the target repo to a temp directory (`fs.mkdtemp(os.tmpdir())`)
2. **Run Claude Code** in headless mode with the spec as the prompt, streaming `stream-json` output
3. **Parse** the streamed output, mapping Claude Code phases to `BuildPhase` values for SSE progress events
4. **Run tests** via the allowed `Bash(npm test *)` tool — abort and emit `build_failed` if they fail
5. **Commit** the changes and push to a new branch (`spec-voice/<slugified-first-decision>`)
6. **Open a draft PR** via Octokit
7. **Clean up** the temp directory in a `finally` block — always, even on failure

**Constraints (from `CLAUDE.md`):**
- Always clone into `os.tmpdir()`, never into the project directory
- Always clean up in `finally`, even on error
- Use Claude Code CLI (`claude -p`), not the Anthropic API directly
- Branch naming: `spec-voice/<slugified-first-decision>`
- Draft PR via Octokit — not the GitHub CLI

This is post-call only. The pipeline is never triggered during an active voice conversation.

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
| Treat `simulateBuild` as the final design | It's a stub. The real implementation clones the repo and runs Claude Code CLI |
| Call the Anthropic API directly for code generation | Use `claude -p` CLI in headless mode |
| Skip the `finally` cleanup for the temp dir | Always clean up — failed clones leave large directories in `os.tmpdir()` |
