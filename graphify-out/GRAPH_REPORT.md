# Graph Report - SpecVoice  (2026-10-11)

## Corpus Check
- 115 files · ~38,237 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 7 file(s) not represented in the graph (top: (none) 6, .css 1)

## Summary
- 673 nodes · 1184 edges · 47 communities (37 shown, 10 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 42 edges (avg confidence: 0.95)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f7b8314b`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- SessionControls.tsx
- local-source.ts
- tool-handler.ts
- package.json
- env.ts
- store.ts
- dependencies
- sessionStore
- compilerOptions
- ref_path
- devDependencies
- components.json
- Claude Code integration
- DX Audit
- sample-repo/package.json
- src/index.ts
- .prettierrc.json
- test-audio.ts
- next.config.js
- Tools
- docs/README.md
- Graphify workflow
- Tutorial: Your First SpecVoice Session
- specvoice-feature-02-build-system/SKILL.md
- ElevenLabs SDK — Undocumented Behavior & Workarounds
- Manual HTTP/SSE Smoke Test
- API Reference
- Adding a new agent tool
- Setup Guide
- Agent contract
- specvoice-feature-e2e/SKILL.md
- SSE Events
- Agent skills
- system-prompt.md
- Security policy
- Documentation map
- SpecVoice
- Contributing
- Issue tracker: GitHub
- SpecVoice
- Canonical agent contract and least-privilege execution
- Keep Claude Code execution post-call
- Bound session capabilities and require an explicit in-memory deployment mode
- triage-labels.md
- sample-repo/README.md

## God Nodes (most connected - your core abstractions)
1. `sessionStore` - 42 edges
2. `Session` - 34 edges
3. `next` - 21 edges
4. `vitest` - 20 edges
5. `issueSessionCapability()` - 18 edges
6. `CodeSource` - 16 edges
7. `compilerOptions` - 16 edges
8. `scripts` - 14 edges
9. `requireInMemorySessionStore()` - 13 edges
10. `requireSessionCapability()` - 12 edges

## Surprising Connections (you probably didn't know these)
- ``POST /api/tools/read-file`` --references--> `FileRead`  [INFERRED]
  docs/api-reference.md → src/lib/session/types.ts
- ``build_progress`` --references--> `BuildPhase`  [INFERRED]
  docs/api-reference.md → src/lib/session/types.ts
- `Types` --references--> `BuildStatus`  [INFERRED]
  docs/api-reference.md → src/lib/session/types.ts
- `The core data flow` --references--> `sessionStore`  [INFERRED]
  docs/architecture.md → src/lib/session/store.ts
- `How session capabilities travel from browser to tool webhook` --references--> `Session`  [INFERRED]
  docs/architecture.md → src/lib/session/types.ts

## Import Cycles
- None detected.

## Communities (47 total, 10 thin omitted)

### Community 0 - "SessionControls.tsx"
Cohesion: 0.07
Nodes (46): Common Mistakes, data-testid Attributes (Required for E2E), ElevenLabs UI Components, Overview, SpecPreview Tab-Switch Logic, Status State Machine, Visual Design System, How the dashboard stays in sync (+38 more)

### Community 1 - "local-source.ts"
Cohesion: 0.08
Nodes (31): Architecture, Build pipeline placement, Code source abstraction, How session capabilities travel from browser to tool webhook, The core data flow, Why ElevenLabs tools are standalone entities, Why `globalThis` for singletons, Why no RAG, no embeddings, no vector database (+23 more)

### Community 2 - "tool-handler.ts"
Cohesion: 0.07
Nodes (40): Step 1: Create the route, next, POST(), PostCallPayloadSchema, TranscriptTurnSchema, GET(), GET(), GET() (+32 more)

### Community 3 - "package.json"
Cohesion: 0.05
Nodes (36): engines, node, typescript, zod, name, private, scripts, build (+28 more)

### Community 4 - "env.ts"
Cohesion: 0.09
Nodes (20): Agent Configuration, Common Mistakes, Core Rule, Enum Quick Reference, Imports, Post-Call Webhook, Standalone Tool Definitions, useConversation Hook (React) (+12 more)

### Community 5 - "store.ts"
Cohesion: 0.06
Nodes (41): useSession Hook, Branch naming, Build Pipeline, Claude Code invocation, Common mistakes, Complexity gate, `ComplexityAssessment` shape, Gate logic (+33 more)

### Community 6 - "dependencies"
Cohesion: 0.14
Nodes (14): dependencies, class-variance-authority, clsx, @elevenlabs/elevenlabs-js, @elevenlabs/react, geist, ignore, next (+6 more)

### Community 7 - "sessionStore"
Cohesion: 0.14
Nodes (13): Common Mistakes, Key Files, Overview, Post-Call Webhook, Session Types, Voice Settings, SSE Events, `POST /api/agent/post-call` (+5 more)

### Community 8 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 9 - "ref_path"
Cohesion: 0.15
Nodes (9): @playwright/test, systemPrompt, FIXTURE_PATH, source, driveSessionToReady(), fixturePath, buildSignedPostCallRequest(), loadEnvVar() (+1 more)

### Community 10 - "devDependencies"
Cohesion: 0.13
Nodes (15): devDependencies, autoprefixer, eslint, eslint-config-next, @playwright/test, postcss, prettier, tailwindcss (+7 more)

### Community 11 - "components.json"
Cohesion: 0.14
Nodes (13): aliases, components, utils, rsc, $schema, style, tailwind, baseColor (+5 more)

### Community 12 - "Claude Code integration"
Cohesion: 0.40
Nodes (4): Build boundary, Claude Code integration, Runtime invariants, Source of truth

### Community 13 - "DX Audit"
Cohesion: 0.15
Nodes (13): `connectionType: 'webrtc'` drops the connection, DX Audit, ElevenLabs unit tests require `dynamicVariables` even for non-tool tests, Setup friction, Signature verification is conditional, Silent failures, Testing friction, The complexity gate always blocks the smoke test (+5 more)

### Community 14 - "sample-repo/package.json"
Cohesion: 0.25
Nodes (7): dependencies, typescript, zod, typescript, zod, name, version

### Community 15 - "src/index.ts"
Cohesion: 0.32
Nodes (3): user, User, greet()

### Community 16 - ".prettierrc.json"
Cohesion: 0.33
Nodes (5): arrowParens, printWidth, semi, singleQuote, trailingComma

### Community 21 - "Tools"
Cohesion: 0.29
Nodes (7): flag_question, generate_spec, list_files, read_file, save_decision, search_code, Tools

### Community 23 - "Graphify workflow"
Cohesion: 0.18
Nodes (7): Completion, Evidence rules, Graphify workflow, Outputs, Setup, When to use it, Ponytail workflow

### Community 24 - "Tutorial: Your First SpecVoice Session"
Cohesion: 0.18
Nodes (11): Before you start, Setting up ngrok, Step 1: Create a session, Step 2: Start the call, Step 3: Have the conversation, Step 4: End the call, Step 5: Review the spec, Step 6: Trigger the build (+3 more)

### Community 26 - "specvoice-feature-02-build-system/SKILL.md"
Cohesion: 0.20
Nodes (9): Branch Name, `BuildPipeline` Orchestration, Claude Code Invocation, Common Mistakes, Complexity Gate, ComplexityAssessment Shape, File Map, Overview (+1 more)

### Community 27 - "ElevenLabs SDK — Undocumented Behavior & Workarounds"
Cohesion: 0.20
Nodes (10): 1. `checkAnyToolMatches: true` expects zero tool calls without `toolCallParameters`, 2. Unit tests require `dynamicVariables` even when they don't call tools, 3. `type: 'llm'` tests evaluate the full agent turn, tool calls included, 4. Array items in `requestBodySchema` require a value-source field, 5. The agent ignores explicit guardrails when chat history shows no prior exploration, 6. `simulateConversation` requires `dynamicVariables` for all agent tool dynamic variables, 7. camelCase vs snake_case is never documented together, 8. Agent config types are only discoverable by reading generated source files (+2 more)

### Community 28 - "Manual HTTP/SSE Smoke Test"
Cohesion: 0.11
Nodes (17): `POST /api/tools/flag-question`, `POST /api/tools/generate-spec`, `POST /api/tools/list-files`, `POST /api/tools/read-file`, `POST /api/tools/save-decision`, `POST /api/tools/search-code`, Tool Webhooks, Manual HTTP/SSE Smoke Test (+9 more)

### Community 29 - "API Reference"
Cohesion: 0.29
Nodes (7): API Reference, `GET /api/sessions/:id`, `GET /api/sessions/:id/events`, `POST /api/sessions`, `POST /api/sessions/:id/build`, Sessions, Types

### Community 33 - "Adding a new agent tool"
Cohesion: 0.22
Nodes (9): Adding a new agent tool, Adding a new SSE event type, Extending SpecVoice, Step 2: Define the tool, Step 3: Register the tool in setup-agent.ts, Step 4: Re-run setup, Step 5: Update the system prompt (if needed), Step 6: Add it to the API reference (+1 more)

### Community 34 - "Setup Guide"
Cohesion: 0.22
Nodes (9): 1. Prerequisites, 2. Install dependencies, 3. Configure environment variables, 4. Start your tunnel, 5. Start the dev server, 6. Create the ElevenLabs agent, 7. Configure the post-call webhook in ElevenLabs, 8. Verify the setup (+1 more)

### Community 36 - "Agent contract"
Cohesion: 0.25
Nodes (8): Agent contract, Change report, Coding workflow, Graphify and Ponytail, Instruction precedence, Project boundaries, Safety and side effects, Start here

### Community 37 - "specvoice-feature-e2e/SKILL.md"
Cohesion: 0.25
Nodes (7): Common Mistakes, Correct post-call webhook payload shape, data-testid requirements, Manual smoke test steps, Overview, Playwright test, What is NOT tested

### Community 38 - "SSE Events"
Cohesion: 0.25
Nodes (8): `build_blocked`, `build_complete`, `build_failed`, `build_progress`, `build_started`, `call_ended`, `session_updated`, SSE Events

### Community 39 - "Agent skills"
Cohesion: 0.29
Nodes (7): Agent skills, Claude Code adapter, Claude Code context, Domain docs, Issue tracker, Project invariants, Triage labels

### Community 40 - "system-prompt.md"
Cohesion: 0.33
Nodes (5): Environment, Goal, Guardrails, Personality, Tone

### Community 41 - "Security policy"
Cohesion: 0.33
Nodes (5): Generated changes, Reporting, Secrets, Security policy, Webhooks and repository content

### Community 43 - "Documentation map"
Cohesion: 0.40
Nodes (5): Agent guidance, Current docs, Decisions and security, Documentation map, Historical notes

### Community 44 - "SpecVoice"
Cohesion: 0.40
Nodes (4): Conversation and planning, Execution, Security and execution, SpecVoice

### Community 45 - "Contributing"
Cohesion: 0.50
Nodes (3): Contributing, Local workflow, Pull requests

### Community 46 - "Issue tracker: GitHub"
Cohesion: 0.50
Nodes (3): Conventions, Issue tracker: GitHub, Pull requests as a triage surface

### Community 47 - "SpecVoice"
Cohesion: 0.50
Nodes (4): Architecture, Commands, SpecVoice, Troubleshooting

## Knowledge Gaps
- **295 isolated node(s):** `Overview`, `Key Files`, `Voice Settings`, `Post-Call Webhook`, `Session Types` (+290 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 336 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `sessionStore` connect `sessionStore` to `local-source.ts`, `tool-handler.ts`, `store.ts`, `Claude Code integration`, `DX Audit`?**
  _High betweenness centrality (0.144) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `sessionStore` (e.g. with `SSE Events` and `Runtime invariants`) actually correct?**
  _`sessionStore` has 5 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Overview`, `Key Files`, `Voice Settings` to the rest of the system?**
  _295 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `SessionControls.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.06838106370543542 - nodes in this community are weakly interconnected._
- **Why does `Architecture` connect `local-source.ts` to `SessionControls.tsx`, `docs/README.md`?**
  _High betweenness centrality (0.103) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `Session` (e.g. with `How session capabilities travel from browser to tool webhook` and `How the dashboard stays in sync`) actually correct?**
  _`Session` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Should `local-source.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08484848484848485 - nodes in this community are weakly interconnected._