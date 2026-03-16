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

**Where I stepped in:**
- (fill in after)

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