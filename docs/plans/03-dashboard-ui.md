# Dashboard UI

A single-page React dashboard that serves as the visual companion to the phone call. It shows what the agent is doing during the conversation and gives the developer controls for the full lifecycle: connect a repo, start a session, watch the spec build in real time, review it, trigger the code generation, and get a link to the PR.

## Why this matters

The phone call is impressive but invisible. The dashboard is what makes the demo video work. Without it, you're watching someone talk to their laptop for three minutes. With it, the viewer sees files being explored, decisions being recorded, and a spec forming in real time alongside the conversation.

It also demonstrates "eye for design" which the job posting calls out explicitly.

## Layout

Three panels, dark theme matching ElevenLabs aesthetic.

**Left panel (300px): Session controls.** Repo URL input, "Start Session" button, session status indicator that tracks the full lifecycle (idle → in call → spec ready → building → complete), phone number display, call duration.

**Centre panel (flex-1): File explorer.** Which files the agent read during the conversation, updating live via SSE. Monospace paths, character counts, relative timestamps. Most recently read at top. Feels like a lightweight VS Code sidebar. Empty state: "Waiting for agent to explore the codebase..."

**Right panel (flex-1): Spec preview + Build.** Top: decisions appearing in real time during the call, switching to full rendered spec when `session.specOutput !== null`. Do not switch on `call_ended` — `specOutput` is already populated before `call_ended` fires, so switching on the event would leave the user watching stale decision cards while the spec is ready. Bottom: "Build it" button when spec is ready, build progress timeline during generation, PR link when complete, error/retry when failed, complexity assessment when blocked.

## Tech choices

**@elevenlabs/react SDK** with `useConversation` hook. Even though the primary flow is phone dial-in, having the React SDK wired up means the dashboard can optionally support web-based conversations and it demonstrates the React ecosystem.

**SSE consumer.** Custom `useSession` hook that connects to `/api/sessions/[id]/events` via EventSource and dispatches typed SessionEvent union to update React state. Reconnects on error with backoff. Cleans up on unmount.

**Tailwind only.** No component libraries. No shadcn, no MUI. Keep it clean and custom.

**React state only.** No Redux, no Zustand. One session state object updated via SSE events.

**No routing.** Single page. Session lifecycle drives UI state, not URL changes.

**No markdown library.** The spec follows a known structure. Parse it with basic formatting or render as preformatted text.

## Design

Dark background (#0a0a0b). Primary text #e5e5e5, secondary #888. Subtle borders (#1a1a2e) between panels. Monospace for file paths, sans-serif for everything else. Fade transitions (200ms) for new items appearing. "Build it" button in a clear accent colour, large enough to be an obvious call to action. No loading spinners, use pulsing dots or text indicators. Desktop optimised (1280px+).

## Status state machine

The `SessionControls` lifecycle indicator is a derived display state. Map session fields as follows:

| Display      | Condition |
|--------------|-----------|
| idle         | `session` is null |
| in call      | `session.status === 'active'` |
| spec ready   | `session.specOutput !== null && session.buildStatus === 'ready'` |
| building     | `session.buildStatus === 'building'` |
| complete     | `session.buildStatus === 'complete'` |
| failed       | `session.buildStatus === 'failed'` |

`call_ended` SSE only transitions the status indicator. It does not determine when the spec becomes available — `specOutput` is already set before `call_ended` fires (the agent calls `generate_spec` during the conversation).

## Components

```
src/components/
├── Dashboard.tsx           # Three-column grid layout
├── SessionControls.tsx     # Left panel
├── FileExplorer.tsx        # Centre panel
├── SpecPreview.tsx         # Right panel top
├── BuildPanel.tsx          # Right panel bottom (trigger + progress + result)
├── BuildProgress.tsx       # Vertical timeline of build events
└── hooks/
    └── useSession.ts       # SSE connection, session state, createSession, triggerBuild
```

## SSE event handling

The `useSession` hook switches on event.type from the discriminated union:

- `session_updated` → replace entire session state
- `call_ended` → transition UI to "spec ready for review"
- `build_started` → clear build log, show progress panel
- `build_progress` → append to build log array with phase + detail
- `build_complete` → store PR URL, show link
- `build_failed` → store error, show retry button
- `build_blocked` → store complexity assessment, show split suggestion

## Implementation order

1. `useSession` hook first. Everything depends on it.
2. `Dashboard.tsx` layout shell.
3. `SessionControls.tsx` with create session flow.
4. `FileExplorer.tsx` fed by session.filesRead.
5. `SpecPreview.tsx` with dual mode (live decisions vs full spec).
6. `BuildPanel.tsx` and `BuildProgress.tsx` for the post-call build flow.
7. Update `page.tsx` and `layout.tsx`.

## Files

Prerequisites: `npm install @elevenlabs/react` if `@elevenlabs/react` is not already in `package.json`. The `useConversation` hook in `SessionControls` imports from this package.

Modified: `src/app/page.tsx`, `src/app/layout.tsx`
Created: All components above plus `src/components/hooks/useSession.ts`

## Verification

`npm run build` clean, `npm run dev` renders the dashboard. Create a session via the UI, check devtools Network tab for SSE connection, curl a `save-decision` against that session, confirm the dashboard updates without page refresh.