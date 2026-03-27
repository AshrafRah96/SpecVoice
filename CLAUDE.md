# CLAUDE.md

## Project

SpecVoice: a code-aware voice agent on ElevenLabs Conversational AI. Joins phone calls as a senior engineer, reads a GitHub repo during the conversation, and outputs a structured PR spec. After the call, a build system uses Claude Code headless mode to implement the spec and open a draft PR. Next.js full-stack, TypeScript throughout.

## Commands

```bash
npm install                                  # install
npm run dev                                  # dev server (frontend + API)
npm run build                                # production build
npm run lint                                 # lint
npm test                                     # vitest
npx tsx src/scripts/setup-agent.ts           # create/update ElevenLabs agent
npm run test:agent                           # run behavioural agent evals
```

## Stack

Next.js 14+ App Router. TypeScript. @elevenlabs/elevenlabs-js for voice + Twilio phone. @elevenlabs/react for the dashboard conversation widget. Octokit for GitHub. Zod for validation. Tailwind for styling. Vitest for tests. SSE for real-time dashboard updates.

## Architecture Rules

- IMPORTANT: No vector database, no embeddings, no RAG. Agent tools give Claude file access on demand; Claude reasons about code natively.
- IMPORTANT: Agent tools are webhooks. ElevenLabs calls our API routes at src/app/api/tools/. Never put tool logic anywhere else.
- IMPORTANT: Dashboard uses Server-Sent Events, NOT WebSockets. Next.js App Router does not support WebSocket upgrade. See src/app/api/sessions/[id]/events/route.ts.
- IMPORTANT: Claude runs as the LLM inside the ElevenLabs agent config — never via direct Anthropic API calls during a call. The one exception is the post-call build pipeline, which uses Claude Code CLI (`claude -p --output-format stream-json`), not the Anthropic API directly.
- IMPORTANT: The build pipeline runs strictly post-call. Never trigger code generation during a voice conversation.
- IMPORTANT: Always clone repos into `os.tmpdir()`, never into the project directory. Always clean up temp dirs in a `finally` block, even on failure.

## Code Style

- Type hints on everything. Shared types live in src/lib/session/types.ts and are imported by both API routes and components — never redeclare locally.
- Zod validation on all API route inputs; never trust incoming webhook data.
- Next.js Route Handler conventions only (NextRequest, NextResponse); never use Express/Fastify patterns.
- Error messages must be specific and actionable; never return generic errors.
- Comments explain WHY, not WHAT. Delete comments that restate code.
- Use the `ignore` npm package for .gitignore handling; never write custom glob matching.
- Use @/ path alias for all imports; never use relative paths between src/lib/ and src/app/.

## Key Patterns

- `save_decision` fires incrementally during conversations, not batched at the end. Each call broadcasts via SSE to update the dashboard live.
- Every session store mutation must update `updatedAt` and fire the SSE broadcast. If a mutation doesn't broadcast, the dashboard breaks silently with no error.
- File reads are capped at 4000 characters. Always record a FileRead entry in the session when reading a file.
- CodeSource has two implementations (GitHub via Octokit, local via fs). Resolve from session state using src/lib/code/index.ts. Never instantiate directly in route handlers.

## ElevenLabs

IMPORTANT: ElevenLabs API changes frequently. Never write ElevenLabs-specific code from training data. If current docs have been provided in this conversation, use those exclusively. When in doubt, check the .d.ts files in node_modules/@elevenlabs/elevenlabs-js/dist/api/types/ — they are more reliable than the published docs.

- System prompt is in src/lib/agent/system-prompt.ts. Do not modify without explicit instruction.
- Phone integration uses ElevenLabs native Twilio support; never build custom Twilio webhooks.

## Mistakes to Avoid

- Never use `WebSocket` or `ws` package; use SSE via ReadableStream + TransformStream in route handlers.
- Never store session state in module-level variables; use the SessionStore singleton in src/lib/session/store.ts. Module-level variables reset on hot reload.
- Never skip .gitignore filtering in code tools; always use the ignore filter from src/lib/code/ignore-rules.ts.
- Never send raw strings over SSE; always JSON-serialize objects matching shared types from src/lib/session/types.ts.
- Never import ElevenLabs SDK methods without checking current docs first; method signatures change frequently.
- Never use `setBuildStatus('error')` — `'error'` is not in the BuildStatus union. The correct value is `'failed'`.