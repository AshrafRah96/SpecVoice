# AI-Assisted Development Log

This project was built using [Claude Code](https://docs.anthropic.com/en/docs/claude-code) as the primary development tool. This log captures the real workflow: what the AI handled, where I had to step in, and what I'd do differently next time.

## Scaffolding (Days 1-2)

**Prompt strategy:** Single detailed prompt covering project structure, code access layer, session management, and Next.js API routes. Fed the CLAUDE.md file first so Claude Code had architecture constraints before generating anything.

**What Claude Code handled well:**
- Generated the full project skeleton, Zod schemas, session store, and API route handlers from one prompt
- (add more after build)

**Where I stepped in:**

*CLAUDE.md bloat.* The first version of CLAUDE.md was 105 lines with full project structure trees and explanatory prose. Claude Code started ignoring rules buried in the middle. I cut it to 59 lines following the principle: every line should prevent a mistake, not explain the project. Instruction-following improved immediately.

*Stale context across pivots.* I originally planned a Python/FastAPI backend but switched to Next.js midway through planning to align with full-stack best practices and simplify the developer setup experience (one `npm install`, one process). Claude Code kept referencing Python patterns, FastAPI conventions, and the old project structure despite the pivot. I had to explicitly clear context and restate the current stack before it stopped mixing the two. This is worth keeping in mind for the voice agent itself: when developers change direction during a planning call, the agent will need to handle the same kind of context invalidation gracefully. Scoping conversations per feature using separate session state (or even separate markdown files per feature) could help.

---

## ElevenLabs Integration (Day 3)

**Prompt strategy:** Fed current ElevenLabs docs (Conversational AI overview, tools/webhooks, phone integration, Python SDK README) directly into context before writing any integration code.

**Key learning:** Claude Code's training data lagged behind the current ElevenLabs API. Method signatures, agent configuration fields, and Twilio integration patterns had all changed since training. Without it, the generated code used deprecated methods and missing parameters.

- You can simulate a conversation with another AI! this helped me save cost to test live

**Where I stepped in:**
- *MCP vs webhooks for agent tooling.* I considered using the official ElevenLabs MCP server to expose the six agent tools (`list_files`, `read_file`, `search_code`, `save_decision`, `flag_open_question`, `generate_spec`) instead of individual webhook routes. MCP and webhooks are two different transports for the same thing, and the webhook approach was already built and tested, so switching would have added complexity with no functional gain. I also looked at adding the ElevenLabs MCP to the Claude Code workflow for account management tasks, but the server requires `uvx` (a Python package manager), which is an unnecessary dependency in a TypeScript project where the `elevenlabs-js` SDK is already available. Context7 remained the only MCP in the stack.

- *Enum types instead of plain strings.* Fields like `modelId`, `llm`, `turnEagerness`, and `clientEvents` don't accept plain strings — they require specific SDK enum types (`TtsConversationalModel`, `Llm`, `TurnEagerness`, `ClientEvent`). Context7 surfaced the raw string values from the API reference, which documents what strings the REST API accepts at the HTTP level. That is correct as far as it goes, but it is not the same as knowing the SDK wrapper type names required in TypeScript. Those names have exactly three sources of truth: the [changelog](https://elevenlabs.io/docs/changelog) (partial — type names appear only when a new enum value is added, not as a complete reference), the interactive API reference (browser-only — the "Show properties" dropdowns are JavaScript-rendered and return blank in any static or programmatic fetch), and the `.d.ts` files inside `node_modules` (the only complete and always-current source). The [SDK README](https://github.com/elevenlabs/elevenlabs-js/blob/main/README.md) confirms that types are exported under the `ElevenLabs` namespace but never enumerates them. The [overrides guide](https://elevenlabs.io/docs/agents-platform/customization/personalization/overrides) explicitly sends developers to "the Agent API reference" for model strings — pointing back to that same browser-only panel. Reading the `.d.ts` files directly was the only reliable path.

- *Evaluation and data collection input schema gaps.* The [success evaluation docs](https://elevenlabs.io/docs/eleven-agents/customization/agent-analysis/success-evaluation) and [data collection docs](https://elevenlabs.io/docs/agents-platform/customization/agent-analysis/data-collection) describe both features exclusively through dashboard UI steps — navigate to the Analysis tab, click "Add criteria" or "Add item." Fields like `identifier`, `data type`, and `description` appear only in prose, never as a JSON schema or API payload example. The [quickstart](https://elevenlabs.io/docs/eleven-agents/quickstart) and the [create agent API reference](https://elevenlabs.io/docs/api-reference/agents/create) both acknowledge these features exist but neither shows the programmatic input shape. The API reference puts `platform_settings` behind a JavaScript-rendered "Show 11 properties" panel that returns blank in any static fetch - meaning the sub-schemas for `evaluation` and `data_collection` are not accessible without logging in and clicking through the interactive docs. The JSON field names are inferrable from the UI prose, but inferring field names is exactly what the CLAUDE.md rule "don't guess ElevenLabs field names" was written to prevent.

- *TurnConfig as a pleasant surprise.* `TurnConfig` wasn't documented in any Context7 result, but reading the SDK type file directly (`.d.ts` in `node_modules`) gave exact field names with JSDoc comments attached. That is how `turnTimeout` and `turnEagerness` got confirmed and filled in rather than left as TODOs. The pattern worth remembering: when the human-written docs haven't caught up, the generated types usually have.

---

## System Prompt Engineering (Day 4)

**Not AI-generated.** Claude Code produced a first draft of the system prompt, but every revision after that came from live phone calls. I'd call the agent, talk through planning a real feature against my own repo, listen to how it sounded, hang up, adjust the prompt, and call again.

The things I tuned by ear:
- How aggressive the pushback felt (too much and it derails the conversation, too little and it's a yes-machine)
- Whether it verbalised tool calls naturally or sounded robotic ("Let me pull up your route handlers" vs silence)
- How it handled long pauses when I was thinking (the turn-taking model needed the prompt to guide it)
- Whether the conversation phases flowed naturally or felt like a checklist

This is the part of the project that cannot be vibe coded. The system prompt is 894 words and took a full day of iteration. The scaffolding is 10x more code and took half the time.

---

## Frontend (Day 5)

**Prompt strategy:** (fill in after)

**Design direction:** (fill in after: how you directed the visual aesthetic, what you pushed back on, what you accepted)

---

## Observations

**What works well with AI-assisted development:**
- (fill in after)

**What still needs a human:**
- (fill in after)

**Would I use this workflow again:**
- (fill in after)

**What I'd do differently:**
- (fill in after)