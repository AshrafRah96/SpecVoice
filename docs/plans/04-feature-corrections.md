# Feature Doc Corrections

Apply all of these before running any feature through Claude Code. Some are spec inconsistencies caught during review, two are over-engineering cuts, and the last six came out of auditing the execution plan for Feature 02 directly.

---

## From the feature spec review

Feature 01 defines `BuildStatus` in `types.ts` specifically to prevent Feature 02 from needing to touch that file again. But `assessing` — which Feature 02 introduces as a concurrency guard — never made it into Feature 01's definition. This is moot now because `assessing` is being cut entirely (see below), but the full union Feature 01 should write is `'idle' | 'ready' | 'building' | 'complete' | 'failed'`. Nothing else.

Feature 02's body says "Store gets a public `broadcastEvent(sessionId, event)` method" as if it's work to do. Feature 01 already does this. Change that line to say the method comes from Feature 01 and should not be redefined.

Feature 02 reads from and writes to `session.prUrl` and `session.complexityAssessment` without either feature declaring when those fields get added to the Session type. Feature 01 is explicit about its three additions (`callDurationSecs`, `transcript`, `buildStatus`) but leaves these two orphaned. Feature 02 needs to claim them — both default to `null` on session creation, and `ComplexityAssessment` is defined alongside them.

Feature 03's status indicator shows `idle → in call → spec ready → building → complete` but never maps these to actual session fields. "In call" and "spec ready" are derived states — Claude Code implementing `SessionControls` will guess and likely get it wrong. Add this before the Components section:

```
idle         session is null
in call      session.status === 'active'
spec ready   session.specOutput !== null && buildStatus === 'ready'
building     buildStatus === 'building'
complete     buildStatus === 'complete'
failed       buildStatus === 'failed'
```

Feature 03's Files section has no install step for `@elevenlabs/react`. If it's not already in `package.json` the build fails on the first import. Add `npm install @elevenlabs/react` to the Files section.

Feature 03 says `SpecPreview` switches from live decisions to the full spec on `call_ended`. That's wrong. `generate_spec` runs during the call, so `specOutput` already exists on the session before `call_ended` fires. Switching on `call_ended` means the user stares at stale decision cards while the spec is sitting there ready. `SpecPreview` should switch when `session.specOutput !== null`. That's the data signal. `call_ended` only transitions the status indicator.

---

## Over-engineering cuts

`assessing` as a `BuildStatus` value exists to cover the gap between returning 202 and `executeBuild` setting `buildStatus` to `'building'`. That gap is a fraction of a second and the user never sees the state. The concurrency guard works identically by checking `buildStatus === 'building'` before the 409. Set `'building'` synchronously in the route before returning 202, drop `assessing` from the union, and remove the one test case that covered a state nobody could observe.

The other cut is in `complexity.ts`. The plan has `assessComplexity` parse the "Affected Files" section out of `session.specOutput` to get a file count. The session already has this data in `session.decisions[].relevantFiles`. Reaching into a markdown string to recover information that was never lost is brittle — any change to how `spec-generator.ts` formats that section silently breaks the gate. Use `session.decisions.flatMap(d => d.relevantFiles)` with a `Set` for deduplication instead, and remove all markdown parsing. The `ComplexityAssessment` shape that falls out of this:

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

Update the complexity tests to build sessions with `decisions` arrays rather than specOutput markdown.

---

## From the execution plan (validated-weaving-wave.md)

The orchestrator calls `setBuildStatus('error')` in its catch blocks. `'error'` is not in the `BuildStatus` union. Every one of those calls is a compile error. Replace them all with `'failed'`.

The execution plan defines `ComplexityAssessment` as `{ level: 'low' | 'medium' | 'high' | 'too_large'; reasoning: string; splitSuggestion?: string[] }`. That conflicts directly with the shape above on three points: `level` vs `size`, the `low/high` vs `small/large` naming, and `splitSuggestion` typed as a flat `string[]` of pre-formatted strings rather than `string[][]` of structured groups. The plan also drops `fileCount`, `openQuestionCount`, `lineEstimate`, and `blocked` entirely, and invents `reasoning: string` which was never specced. Use the shape above. The plan's definition is wrong.

`BuildPhase` is used in the `spawnClaudeCode` signature and in the `SessionEvent` union but is never defined anywhere. Add it to `types.ts` in Step 1:

```typescript
export type BuildPhase = 'analyzing' | 'writing' | 'reviewing' | 'cloning' | 'pr'
```

The values are already implied by the NDJSON mapping in the executor section.

After a complexity block the orchestrator sets `buildStatus` back to `'idle'`. That's wrong — `'idle'` tells the dashboard "no spec yet" and the spec is sitting right there. Set it to `'ready'` instead so the session stays actionable and the developer can act on the split suggestion.

The build route only checks `buildStatus === 'building'` before firing `executeBuild`. If `specOutput` is null, the build enters the orchestrator and blows up inside `writeBuildFiles` with a useless error. Add a guard before the 202:

```typescript
if (!session.specOutput) {
  return NextResponse.json({ error: 'No spec to build from.' }, { status: 400 })
}
```

The orchestrator writes `session.specOutput ?? generateSpec(session)` to SPEC.md. If `specOutput` is null at that point it means the agent never called `generate_spec` during the call, and silently generating a spec from an incomplete session could send Claude Code off building the wrong thing with no warning. The route guard above makes this branch unreachable anyway — remove the fallback and use `session.specOutput` directly.