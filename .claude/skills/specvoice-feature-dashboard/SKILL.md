---
name: specvoice-feature-dashboard
description: Use when changing dashboard components, Session state, SSE reconnects, repository scope controls, Build gating, or voice-call UI.
---

# Dashboard work

1. Preserve operator-cookie authentication, URL/history Session recovery, and fresh private call credentials. Login expiry closes SSE but leaves accepted work intact. Inspect `Dashboard`, `useSession`, and the touched component. `session_updated` replaces authoritative Session state; progress stays in the hook's Build log. `build_failed` also surfaces its error. Completion: each changed display maps to Session/profile state or an explicit request error.
2. Preserve native EventSource reconnects. Keep the same instance after `onerror` so the browser sends Last-Event-ID; close only during cleanup. The server drains paged replay, handles backpressure, and polls for missed notifications. Completion: disconnects do not reset replay position.
3. `ScopeControls` polls the profile route through `useSession`. Voice discovery waits for `ready`/`partial`, then may proceed before confirmation. Builds use `buildReadiness`; every saved scope edit needs explicit confirmation, and unsaved edits cannot confirm an older plan. Completion: status, pinned commit, partial counts, errors, and the blocking reason remain visible.
4. Preserve separate recovery-only and new-generation retry actions. A new Build may spend model quota. Completion: a user can distinguish publication recovery from regeneration.
5. Keep explicit lost-call abandonment separate from normal call completion. Expired profiles retry at the same commit and preserve confirmed scope. Run `npm run verify` and `npm run test:e2e` for changed browser behavior. Keep selectors used by the tests and assert visible outcomes without sleeps.

Use existing Button, Orb, and LiveWaveform components; colors come from `src/app/globals.css` tokens. Keep plain React state. SpecPreview's Spec tab depends on `specOutput`, not the timing of `call_ended`. Read `docs/architecture.md` for the data flow and `docs/repository-scale.md` for scope semantics.
