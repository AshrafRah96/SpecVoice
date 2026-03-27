# UI Redesign — ElevenLabs Native Feel

> Depends on: Feature 03 (dashboard built and working)
> Blocks: nothing — cosmetic only, no logic changes

Modified: `src/app/layout.tsx`, `src/app/globals.css`, everything in `src/components/`
New dependency: ElevenLabs UI component registry (see below)

---

The current dashboard reads as "developer built a dark theme." The goal is for SpecVoice to feel like it ships inside the ElevenLabs product — specifically the Agents platform, which is the exact context SpecVoice lives in. The screenshot is the reference. Everything below is derived from it.

Feature 03 banned shadcn. That gets reversed here. ElevenLabs ships an official open-source component library — `elevenlabs/ui` — built on shadcn/ui, with orbs, waveforms, and voice agent components designed specifically for this context. Using it is the right call.

Install it before touching any component:

```bash
npx shadcn@latest init
npx @elevenlabs/cli@latest components add all
```

This copies the component registry into `src/components/ui/`. They're yours — editable, no runtime lock-in. Run `npm run build` after to confirm no type conflicts. Update `CLAUDE.md` to reflect that shadcn/ui is now in the stack.

## What the actual ElevenLabs app looks like

This is based on the screenshot, not the brand guidelines PDF.

The sidebar is a warm dark tone — around `#141413` or similar — visually distinct from the main content area which sits slightly cooler and lighter, around `#1a1a18`. They're close but the contrast is enough to separate structure from content without a border doing the heavy lifting.

CTAs are solid black (`#0f0f0e` or `#000`) with white text. There is no blue. No purple. No gradient. The "Add test", "Publish", and "Preview" buttons are all the same treatment — pure black, slightly rounded corners, white label. When you want something to be the primary action, you make it black. That's it.

Nav items sit at normal weight, muted white. The active item — "Agents" in the screenshot — gets a very subtle background highlight, barely visible, like `bg-white/8`. No left border accent, no filled pill, no colour. Section labels like "Configure", "Monitor", "Deploy" are `text-xs uppercase tracking-wider text-white/40`. They label without competing.

The tab bar at the top ("Agent", "Workflow", "Tests", etc.) uses a simple bottom border underline for the active tab. Single pixel, white. No background fill, no pill shape.

Status badges are the only place colour appears — green for success, red for fail — and even those are muted, low-saturation. Colour is reserved strictly for semantic meaning.

Spacing is generous. Nothing is cramped. Content areas have substantial padding. The empty state in the screenshot ("No tests attached") sits centred in a bordered region with a small icon, two lines of text, and a button. Exactly that much, nothing more.

## Token layer

Set this up in `globals.css` before touching any component. All colours go through variables — no hardcoded hex values in components.

```css
:root {
  --background: 24 5% 9%;           /* main content area ~#1a1a18 */
  --sidebar: 24 5% 7%;              /* sidebar ~#141413, slightly warmer */
  --foreground: 0 0% 95%;           /* primary text */

  --card: 24 5% 9%;
  --card-foreground: 0 0% 95%;
  --muted: 0 0% 13%;
  --muted-foreground: 0 0% 45%;

  --primary: 0 0% 6%;               /* CTA buttons — near black */
  --primary-foreground: 0 0% 98%;

  --border: 0 0% 14%;
  --input: 0 0% 14%;
  --ring: 0 0% 20%;

  /* Semantic only — used for status badges, never decoration */
  --success: 142 50% 40%;
  --success-muted: 142 30% 18%;
  --destructive: 0 60% 45%;
  --destructive-muted: 0 30% 16%;
}
```

## Component changes

**SessionControls — left panel.** The left panel should mirror the sidebar structure in the screenshot. Nav-style section with subtle grouping. The session status indicator stays but should be a plain text badge (`text-xs font-medium`) not a coloured dot — active sessions get white text, idle gets muted. Repo URL input uses the `--input` border colour, no fill, clean. The "Start Session" button is `bg-primary text-primary-foreground` — solid near-black, white label. No other treatment.

Optionally add the ElevenLabs `Orb` component above the input — it has idle/listening/talking states that map to session lifecycle and it's a direct lift from the Agents platform visual language. If it fits the panel without dominating it, include it. If it reads as too large or decorative, skip it.

**FileExplorer — centre panel.** Keep the file path list exactly as it is structurally. Restyle it to match the row treatment in the screenshot's "Past runs" table — each file read as a clean row, monospace path on the left, character count and timestamp on the right in `text-muted-foreground text-xs`. A single `border-b border-border/50` separator between rows. No cards, no borders wrapping the whole entry.

Add `LiveWaveform` from the ElevenLabs UI library above the list as a passive indicator that the agent is working. Bar width 3, gap 1, radius 6, muted foreground, fade edges. Active when `session.status === 'active'`, resting otherwise.

**Panel chrome.** The content panels should use `bg-card border border-border/50 rounded-md`. No drop shadows. Thin borders only. Section labels inside panels use `text-xs uppercase tracking-wider text-muted-foreground` — same treatment as "Configure" and "Monitor" in the sidebar.

**Tab-style navigation for SpecPreview.** During the call, the right panel shows live decisions. After, it shows the full spec. Rather than switching the whole component, add a minimal tab bar at the top of the panel — "Decisions" and "Spec" — with the same underline-only active state from the screenshot. Single bottom border, white, normal weight text. No filled backgrounds.

**Decision rows.** Each decision should be a plain row, not a card. Summary text `text-sm`, faded timestamp `text-xs text-muted-foreground`, and a very subtle left border in `border-l-2` — white/20 for core decisions, amber/40 for scope ones. On hover the row gets `bg-muted/40`. No padding cards, no elevation.

**Build button.** Solid near-black, white text, full width. `bg-primary text-primary-foreground`. When building, replace it with a plain text status line and the `LiveWaveform` in processing mode (`active={false} processing`). No spinners, no progress bars.

**Status badges.** Build status and session status should match the "Success" and "Fail" badge treatment in the screenshot — small, rounded, muted background, slightly saturated text. Use `--success-muted` and `--destructive-muted` as backgrounds with the saturated version for text.

**Typography.** Install Geist — it matches what the ElevenLabs app uses.

```bash
npm install geist
```

```tsx
// layout.tsx
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
```

`GeistSans` on the body, `GeistMono` on file paths and any code output.

**Empty states.** Match the screenshot's empty state pattern exactly. Centred in a bordered region: small icon, one line of primary text `text-sm font-medium`, one line of secondary text `text-sm text-muted-foreground`, then the action button below. That structure, nothing else. Left panel before session: no bordered region needed, just the orb (if included) and a muted prompt. Right panel before decisions: blank space, let the left panel carry the waiting state.

## What does not change

No logic, no data flow, no SSE handling, no session store, no API routes. If anything in `src/lib/` or `src/app/api/` gets touched by this PR, something went wrong.

All Tailwind via CSS variables. `bg-primary` not `bg-[#0f0f0e]`. No inline styles. ElevenLabs UI components where they exist, shadcn primitives where they don't, custom Tailwind for the rest.

All existing `useSession` hook behaviour, component props, and SSE event handling stays identical. This is a skin, not a rewrite.

## Done when

`npm run build` is clean. `npm run dev` shows the redesigned dashboard. The panel chrome, typography, and button treatment all match the screenshot reference. Status badges use the muted green/red treatment. Decision rows are plain rows, not cards. The build button is solid near-black. Empty states match the screenshot's centred pattern. Someone who uses the ElevenLabs Agents platform daily would not feel visual whiplash opening SpecVoice.