# Dashboard UI Build — Learnings

Findings from building the feature 03 dashboard. ElevenLabs React SDK, SSE patterns, and project-specific gotchas.

---

## @elevenlabs/react — useConversation API (verified via context7, v0.4+)

### Status values: 'connected' | 'disconnected' ONLY

`useConversation().status` emits exactly two values: `'connected'` and `'disconnected'`. There is no `'connecting'` state. Any conditional checking `=== 'connecting'` is dead code.

```typescript
const { status } = useConversation()
// safe: status === 'connected' | 'disconnected'
// NOT safe: status === 'connecting' — never emitted
```

### startSession requires agentId, signedUrl, OR conversationToken

Three modes available:

| Mode | Field | Use case |
|------|-------|----------|
| Public agent (no auth) | `agentId` | Demo/dev, matches `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` |
| Authenticated WebSocket | `signedUrl` | Production, fetched from your server |
| Authenticated WebRTC | `conversationToken` | Production, fetched from your server |

For this project we use `agentId` + `connectionType: 'webrtc'` since the agent is public during dev.

### isSpeaking is a boolean, not an event

`conversation.isSpeaking` is a plain boolean reactive value. No event listener needed — read it directly in JSX.

### @elevenlabs/react is a separate package from @elevenlabs/elevenlabs-js

The server SDK (`@elevenlabs/elevenlabs-js`) and the React SDK (`@elevenlabs/react`) are separate npm packages with separate versioning. The React SDK only provides `useConversation` (and `useScribe` for transcription). Do not look for webhook tool creation or agent config in `@elevenlabs/react`.

---

## SSE Design: build_progress without sessionId is correct

The `build_progress` event intentionally omits `sessionId`:

```typescript
| { type: 'build_progress'; phase: BuildPhase; detail: string }
```

Rationale: every `EventSource` connects to `/api/sessions/[id]/events` — the session is already scoped by URL. Adding `sessionId` to every high-frequency `build_progress` event is redundant payload. All other build events (`build_started`, `build_complete`, `build_failed`, `build_blocked`) include `sessionId` for any future fan-out consumers (admin view, logging, replay).

If you add a fan-out broadcast in the future, `build_progress` will need `sessionId` added at that point.

---

## Build log lives in hook state, not Session object

`BuildLogEntry[]` is maintained as local state in `useSession`, accumulated from `build_progress` SSE events:

```typescript
const [buildLog, setBuildLog] = useState<BuildLogEntry[]>([])
// case 'build_started': setBuildLog([])  — clear on new build
// case 'build_progress': setBuildLog(prev => [...prev, newEntry])
```

This means:
- Build log is reset on page reload (by design — you can POST to `/api/sessions/[id]/build` again)
- Build log is NOT persisted on the Session object in the store
- `BuildLogEntry` is exported from `useSession.ts`, not from `types.ts`

---

## .gitignore: 'build/' matches API route directories

The `.gitignore` line `build/` matches any directory named `build` at any depth, including `src/app/api/sessions/[id]/build/`. This caused the build route file to be invisible to git.

**Fix applied:** Added `!src/**/build/` negation immediately after the `build/` rule.

```gitignore
build/
!src/**/build/
```

Watch for this pattern if any future Next.js API route has a path segment named `dist`, `out`, or `coverage` — all of which are also in the `.gitignore`.

---

## ComplexityAssessment field name: score, not level

Feature 2 extended `ComplexityAssessment`:

```typescript
// Before feature 02:
export interface ComplexityAssessment {
  level: 'low' | 'medium' | 'high'
  reasoning: string
}

// After feature 02 (dashboard-compatible):
export interface ComplexityAssessment {
  score: 'low' | 'medium' | 'high' | 'too_large'
  reasoning: string
  splitSuggestion?: string[]  // populated when score === 'too_large'
}
```

Any component checking complexity must use `.score`, not `.level`. The blocked state is `score === 'too_large'`, not `score === 'high'`.

---

## BuildStatus: 'failed' not 'error'

`BuildStatus = 'idle' | 'ready' | 'building' | 'complete' | 'failed'`

The terminal error state is `'failed'`, not `'error'`. (`SessionStatus` still uses `'error'` — two different status types, different naming conventions. Add a comment if this causes confusion.)

---

## pre-existing setup-agent.ts TypeScript errors

`src/scripts/setup-agent.ts` and `src/lib/agent/tool-definitions.ts` had pre-existing TypeScript errors from the ElevenLabs SDK's `WebhookToolApiSchemaConfigInputMethod` union type:

- `method: 'POST'` needs `WebhookToolApiSchemaConfigInputMethod.Post`
- Schema property type literals need `as const` or explicit enum values
- Return types needed explicit annotations to prevent union widening

These were fixed during the Task 10 build verification step. If the ElevenLabs SDK version is bumped, check this file first — the method enum values change between SDK releases.

---

## Record<BuildPhase, ...> enforces exhaustiveness at compile time

Using `Record<BuildPhase, string>` for the phase labels/colors maps in `BuildProgress.tsx` means any new `BuildPhase` value added to `types.ts` will immediately cause a TypeScript error in `BuildProgress.tsx`. This is intentional — it prevents silent UI gaps when new phases are added.

```typescript
// If 'testing' is added to BuildPhase, this line will error:
const PHASE_LABELS: Record<BuildPhase, string> = {
  analyzing: 'Analyzing',
  writing: 'Writing',
  reviewing: 'Reviewing',
  // TypeScript error: property 'testing' is missing
}
```
