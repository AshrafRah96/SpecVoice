---
name: specvoice-feature-dashboard
description: Use when building, modifying, or debugging SpecVoice dashboard components including SessionControls, FileExplorer, SpecPreview, BuildPanel, or the useSession hook. Use when wiring SSE events to React state. Use when applying the SpecVoice visual design system (tokens, colors, typography). Use when integrating ElevenLabs UI components (Orb, LiveWaveform). Use when the status state machine or SpecPreview tab-switch logic is involved.
---

## Overview

The dashboard is a three-panel layout rendered by `Dashboard.tsx`. Feature 05 redesigned the UI and reversed Feature 03 constraints — treat Feature 05 as authoritative.

Component tree:
```
src/components/
├── Dashboard.tsx
├── SessionControls.tsx   # left, 300px — repo URL, Start Session, lifecycle indicator
├── FileExplorer.tsx      # centre, flex-1 — files agent read, live via SSE
├── SpecPreview.tsx       # right top — decision cards / spec output tabs
├── BuildPanel.tsx        # right bottom — Build it button
├── BuildProgress.tsx     # right bottom — phase log while building
└── hooks/useSession.ts   # SSE consumer, plain React state
```

## useSession Hook

`src/components/hooks/useSession.ts` connects to `/api/sessions/[id]/events` via `EventSource`. It dispatches typed `SessionEvent` objects to plain React state (`useState`/`useReducer`). It reconnects with exponential backoff and cleans up on unmount. There is no Redux or Zustand involved.

SSE events and their effect on hook state:

| Event | Action |
|---|---|
| `session_updated` | Replace full session object — carries ALL state changes |
| `call_ended` | **Nothing** — session_updated fires immediately after and carries the state |
| `build_started` | Clear `buildLog` array |
| `build_progress` | Append `{phase, detail, timestamp}` to `buildLog` |
| `build_complete` | **Nothing** — session_updated carries `prUrl` and `buildStatus: 'complete'` |
| `build_failed` | **Nothing** — session_updated carries `buildStatus: 'failed'` |
| `build_blocked` | **Nothing** — session_updated carries `complexityAssessment` |

`buildLog` is a separate hook state (`BuildLogEntry[]`), not on the Session object.

## Status State Machine

| Display | Condition |
|---|---|
| idle | `session` is null |
| in call | `session.status === 'active'` |
| spec ready | `session.specOutput !== null && session.buildStatus === 'ready'` |
| building | `session.buildStatus === 'building'` |
| complete | `session.buildStatus === 'complete'` |
| failed | `session.buildStatus === 'failed'` |

## SpecPreview Tab-Switch Logic

Switch from decision cards to spec view when `session.specOutput !== null`. Do not switch on the `call_ended` SSE event — `specOutput` is populated before `call_ended` fires. Tab bar has "Decisions" and "Spec" tabs with underline-only active indicator.

## Visual Design System

All colors flow through CSS custom properties defined in `src/app/globals.css`. Never use inline hex (`style={{ color: '#hex' }}`) or Tailwind arbitrary values (`bg-[#0f0f0e]`).

Token classes to use:
- Backgrounds: `bg-primary`, `bg-sidebar`, `bg-card`
- Text: `text-foreground`, `text-muted-foreground`, `text-primary-foreground`
- Borders: `border-border`
- Status badges: `--success-muted` / `--destructive-muted` backgrounds

Typography: `GeistSans` on body, `GeistMono` on file paths and code output.

CTAs: `bg-primary text-primary-foreground` (near-black, white label). No blue, purple, or gradients.

shadcn/ui is in the stack. Use the Button primitive freely. Avoid importing the full Radix component suite beyond `@radix-ui/react-slot`.

## ElevenLabs UI Components

Install: `npx shadcn@latest init && npx @elevenlabs/cli@latest components add all`

- `Orb` (`src/components/ui/`) — idle/listening/talking states mapped to session lifecycle
- `LiveWaveform` (`src/components/ui/`) — passive indicator in FileExplorer; active when `session.status === 'active'`

Requires `@elevenlabs/react` — install it before importing `useConversation`.

## data-testid Attributes (Required for E2E)

| Attribute | Location |
|---|---|
| `session-id` | SessionControls — renders session ID (only visible when `!session.specOutput`) |
| `sse-status` | SessionControls — SSE connection status |
| `file-explorer` | FileExplorer root |
| `spec-preview` | SpecPreview root |
| `build-button` | BuildPanel — Build it button |

## Common Mistakes

1. **SpecPreview switches on `call_ended`** — Wrong. Switch when `session.specOutput !== null`. The spec is populated before `call_ended` fires.
2. **Avoiding shadcn/ui** — Wrong. Feature 05 reversed the Feature 03 ban. shadcn IS in the stack.
3. **Inline hex colors** (`style={{ color: '#3b82f6' }}`) — Wrong. Use token classes backed by `globals.css` custom properties.
4. **Tailwind arbitrary color values** (`bg-[#0f0f0e]`) — Wrong. Use token classes: `bg-primary`, `bg-card`, etc.
5. **Status state machine from intuition** — Wrong. Use the table above; the mapping between `buildStatus` values and display states is non-obvious.
6. **Importing `useConversation` without installing `@elevenlabs/react`** — Wrong. Install the package first.
7. **Managing useSession state with Redux/Zustand** — Wrong. It is plain React state, driven entirely by SSE events.
