# CLAUDE.md

## Project

SpecVoice: a code-aware voice agent on ElevenLabs Conversational AI. Joins phone calls as a senior engineer, reads a GitHub repo during the conversation, and outputs a structured PR spec. After the call, a build system uses Claude Code headless mode to implement the spec and open a draft PR. Next.js full-stack, TypeScript throughout.

## Commands

```bash
npm install                                  # install
npm run dev                                  # dev server (frontend + API)
npm run build                                # production build
npm run lint                                 # lint
npm test                                     # vitest (run once)
npm run test:watch                           # vitest watch mode
npx vitest run tests/lib/complexity.test.ts  # run a single test file
npm run test:e2e                             # Playwright E2E tests
npm run test:e2e:ui                          # Playwright with interactive UI
npx tsx src/scripts/setup-agent.ts           # create/update ElevenLabs agent
npm run test:agent                           # run behavioural agent evals
```

## Stack

Next.js 14+ App Router. TypeScript. @elevenlabs/elevenlabs-js for voice + Twilio phone. @elevenlabs/react for the dashboard conversation widget. Octokit for GitHub. Zod for validation. Tailwind + shadcn/ui for styling (Button primitive; Orb and LiveWaveform in `src/components/ui/`). Geist font. `clsx` + `tailwind-merge` via `cn()` in `src/lib/utils.ts`. Vitest for tests. SSE for real-time dashboard updates.

## Architecture Rules

- IMPORTANT: No vector database, no embeddings, no RAG. Agent tools give Claude file access on demand; Claude reasons about code natively.
- IMPORTANT: Agent tools are webhooks. ElevenLabs calls our API routes at src/app/api/tools/. Never put tool logic anywhere else.
- IMPORTANT: Dashboard uses Server-Sent Events, NOT WebSockets. Next.js App Router does not support WebSocket upgrade. See src/app/api/sessions/[id]/events/route.ts.
- IMPORTANT: Claude runs as the LLM inside the ElevenLabs agent config, not via direct Anthropic API calls during a call. The one exception is the post-call build pipeline, which uses Claude Code CLI (`claude -p --output-format stream-json`).
- IMPORTANT: The build pipeline runs post-call only. Never trigger code generation during a voice conversation.
- IMPORTANT: Always clone repos into `os.tmpdir()`, never into the project directory. Always clean up temp dirs in a `finally` block, even on failure.

## Code Style

- Type hints on everything. Shared types live in src/lib/session/types.ts and are imported by both API routes and components; never redeclare locally.
- Zod validation on all API route inputs; never trust incoming webhook data.
- Next.js Route Handler conventions only (NextRequest, NextResponse); never use Express/Fastify patterns.
- Error messages must be specific and actionable; never return generic errors.
- Comments explain WHY, not WHAT. Delete comments that restate code.
- Use the `ignore` npm package for .gitignore handling; never write custom glob matching.
- Use @/ path alias for all imports; never use relative paths between src/lib/ and src/app/.

## Key Patterns

- `save_decision` fires incrementally during conversations, not batched at the end. Each call broadcasts via SSE to update the dashboard live.
- Every session store mutation must update `updatedAt` and fire the SSE broadcast. If a mutation doesn't broadcast, the dashboard breaks with no error.
- File reads are capped at 4000 characters. Always record a FileRead entry in the session when reading a file.
- CodeSource has two implementations (GitHub via Octokit, local via fs). Resolve from session state using src/lib/code/index.ts. Never instantiate directly in route handlers.
- The SessionStore singleton and per-session CodeSource cache both live on `globalThis` (not a module variable) so they survive Next.js hot reloads. Follow this same pattern for any future process-level singletons.
- The build pipeline in `src/app/api/sessions/[id]/build/route.ts` is currently a simulation stub (3 × 1.5s phases). The real Claude Code CLI integration is not yet implemented. Do not treat the stub as the final design.
- Tool webhooks receive the session ID via `conversation_initiation_client_data.dynamic_variables.session_id` (injected when the call starts). This is the only routing key; all tool routes resolve the session from it before doing any work.

## ElevenLabs

IMPORTANT: ElevenLabs API changes frequently. Never write ElevenLabs-specific code from training data. If current docs have been provided in this conversation, use those exclusively. When in doubt, check the .d.ts files in node_modules/@elevenlabs/elevenlabs-js/dist/api/types/; they are more reliable than the published docs.

- System prompt source is `docs/system-prompt.md`; `src/lib/agent/system-prompt.ts` loads it at runtime. Edit the `.md` file, not the loader. Do not modify without explicit instruction.
- Phone integration uses ElevenLabs native Twilio support; never build custom Twilio webhooks.
- `connectionType: 'websocket'` when starting a web session via `useConversation`. The WebRTC/LiveKit v1 path fails and drops the connection.
- Post-call webhook must return HTTP 200 for all business-logic failures (missing session_id, unknown session, schema mismatch). ElevenLabs retries any non-200 response and will flood the server.

- Full documentation: https://elevenlabs.io/docs/eleven-agents
- API reference: https://elevenlabs.io/docs/api-reference/introduction
- Agents API: https://elevenlabs.io/docs/api-reference/agents/get
- Conversations API: https://elevenlabs.io/docs/api-reference/conversations/get

## Mistakes to Avoid

- Never use `WebSocket` or `ws` package; use SSE via ReadableStream + TransformStream in route handlers.
- Never store session state in module-level variables; use the SessionStore singleton in src/lib/session/store.ts. Module-level variables reset on hot reload.
- Never skip .gitignore filtering in code tools; always use the ignore filter from src/lib/code/ignore-rules.ts.
- Never send raw strings over SSE; always JSON-serialize objects matching shared types from src/lib/session/types.ts.
- Never import ElevenLabs SDK methods without checking current docs first; method signatures change frequently.
- Never use `setBuildStatus('error')` or `setBuildStatus('assessing')`; neither value is in the BuildStatus union (`'idle' | 'ready' | 'building' | 'complete' | 'failed'`). Use `'failed'` for errors.
- Never set `buildStatus = 'idle'` after a complexity block; the spec still exists. Set `buildStatus = 'ready'`.
- Never use inline `style={{ color: '#hex' }}` in components; use Tailwind token classes (`text-primary`, `text-muted-foreground`, etc.) backed by CSS custom properties in `src/app/globals.css`. All colours derive from the token layer.
- shadcn/ui is in the stack. The Feature 03 "no shadcn" ban is reversed as of Feature 05 (UI redesign). Use shadcn primitives where they fit; avoid full Radix component suite beyond `@radix-ui/react-slot`.