# SpecVoice

A code-aware voice agent on ElevenLabs Conversational AI. Joins phone calls or web conversations as a senior engineer, reads a GitHub repo during the call, and outputs a structured PR spec. After the call, a build pipeline uses Claude Code in headless mode to implement the spec and open a draft PR.

**Stack:** Next.js 14 App Router · TypeScript · ElevenLabs Conversational AI · Anthropic Claude · Octokit · Tailwind + shadcn/ui · Vitest · Playwright

---

## Setup Guide

### 1. Prerequisites

- Node.js 18+
- An [ElevenLabs](https://elevenlabs.io) account (free tier works for testing)
- An [Anthropic](https://console.anthropic.com) API key (for the post-call build pipeline)
- A GitHub personal access token (optional — needed for private repos and higher rate limits)
- [ngrok](https://ngrok.com) or equivalent tunnel for local development (ElevenLabs must reach your webhooks)

---

### 2. Install dependencies

```bash
npm install
```

---

### 3. Configure environment variables

Copy the example file and fill in each value:

```bash
cp .env.local.example .env.local
```

| Variable | Required | Description |
|---|---|---|
| `ELEVENLABS_API_KEY` | Yes | Found in ElevenLabs → Profile → API Keys |
| `ELEVENLABS_AGENT_ID` | After step 5 | Filled automatically by `setup-agent.ts` output |
| `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` | After step 5 | Same value as above — needed for the browser web-call widget |
| `NEXT_PUBLIC_APP_URL` | Yes | Your public URL (ngrok tunnel for local dev, e.g. `https://abc123.ngrok-free.app`) |
| `GITHUB_TOKEN` | Recommended | Personal access token with `repo` read scope |
| `ANTHROPIC_API_KEY` | Yes (build pipeline) | Used by Claude Code CLI in the post-call build step |
| `ELEVENLABS_WEBHOOK_SECRET` | Recommended | HMAC secret for verifying ElevenLabs webhook signatures |

> **Important for local development:** `NEXT_PUBLIC_APP_URL` must be your ngrok tunnel URL, not `localhost`. ElevenLabs calls your tool webhooks over the internet — localhost is unreachable from their servers.

---

### 4. Start your tunnel

```bash
ngrok http 3000
```

Copy the `https://` URL ngrok prints and set it as `NEXT_PUBLIC_APP_URL` in `.env.local`. Keep the ngrok process running whenever you're developing.

> If your ngrok URL changes (free tier assigns a new URL on each restart), you must update `NEXT_PUBLIC_APP_URL` and re-run step 5.

---

### 5. Start the dev server

```bash
npm run dev
```

---

### 6. Create the ElevenLabs agent

This script creates (or updates) the ElevenLabs agent, registers all tool webhook URLs pointing to your `NEXT_PUBLIC_APP_URL`, and prints the agent ID:

```bash
npx tsx src/scripts/setup-agent.ts
```

Copy the printed agent ID into `.env.local`:

```
ELEVENLABS_AGENT_ID=agent_xxxxxxxxxxxx
NEXT_PUBLIC_ELEVENLABS_AGENT_ID=agent_xxxxxxxxxxxx
```

Restart the dev server after updating `.env.local`.

> Re-run this script any time your ngrok URL changes — the tool webhook URLs are baked into the ElevenLabs agent config.

---

### 7. Configure the post-call webhook in ElevenLabs

This step is **not automated** by `setup-agent.ts` and must be done once manually.

1. Go to [ElevenLabs → Settings → Webhooks](https://elevenlabs.io/app/settings/webhooks)
2. Create a new webhook:
   - **URL:** `https://<your-ngrok-url>/api/agent/post-call`
   - **Auth Method:** HMAC
3. Copy the signing secret ElevenLabs provides and add it to `.env.local`:
   ```
   ELEVENLABS_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
   ```
4. Go to [ElevenLabs → Agents → your agent → Settings](https://elevenlabs.io/app/agents) and assign the webhook under **Post-Call Webhook**, ticking the **Transcript** event.
5. Restart the dev server.

---

### 8. Verify the setup

Open the dashboard at `http://localhost:3000`.

1. Enter a GitHub repo URL and click **Start Session**
2. Click **Start Web Call** — your browser mic will activate and you'll be connected to the agent
3. Talk to the agent — it will read the repo, ask clarifying questions, and log decisions live in the dashboard
4. End the call — within a few seconds the session status should transition from **In Call** to **Build It** (buildStatus: ready)

To confirm webhooks are flowing, watch the ngrok inspector at `http://localhost:4040` — you should see POSTs to `/api/tools/read-file`, `/api/tools/save-decision`, and `/api/agent/post-call`.

---

## Commands

```bash
npm run dev            # start dev server
npm run build          # production build
npm run lint           # lint
npm test               # vitest unit tests
npm run test:e2e       # Playwright E2E tests (requires dev server running)
npx tsx src/scripts/setup-agent.ts   # create/update ElevenLabs agent
```

---

## Architecture

```
Browser (Next.js dashboard)
  └─ creates session via POST /api/sessions
  └─ subscribes to real-time updates via SSE /api/sessions/:id/events
  └─ starts web call via @elevenlabs/react → ElevenLabs WebRTC

ElevenLabs Agent (Claude LLM + voice)
  └─ reads repo files   → POST /api/tools/read-file
  └─ saves decisions    → POST /api/tools/save-decision
  └─ flags questions    → POST /api/tools/flag-question
  └─ generates spec     → POST /api/tools/generate-spec
  └─ post-call webhook  → POST /api/agent/post-call

Post-call build pipeline
  └─ triggered by "Build It" button → POST /api/sessions/:id/build
  └─ runs Claude Code CLI in headless mode
  └─ opens a draft PR on GitHub
```

No vector database, no embeddings, no RAG. The agent reads files on demand via tools and reasons about code natively.

---

## Troubleshooting

**Session stuck in "In Call" after the call ends**
The post-call webhook didn't fire. Check:
1. The webhook URL in ElevenLabs matches your current ngrok URL
2. `ELEVENLABS_WEBHOOK_SECRET` in `.env.local` matches the HMAC secret in ElevenLabs
3. The dev server was restarted after adding the secret
4. ngrok inspector (`localhost:4040`) shows a POST to `/api/agent/post-call`

**Agent connects but no audio**
1. Check the browser tab isn't muted (right-click tab → Unmute)
2. Check system audio output device
3. Click anywhere on the page after starting the call (browsers sometimes suspend audio context until a user gesture)

**Tool webhooks not firing (filesRead stays empty)**
The agent's tool URLs point to the wrong host. Re-run `setup-agent.ts` after updating `NEXT_PUBLIC_APP_URL` in `.env.local`.

**ngrok URL changed**
1. Update `NEXT_PUBLIC_APP_URL` in `.env.local`
2. Re-run `npx tsx src/scripts/setup-agent.ts`
3. Update the post-call webhook URL in ElevenLabs dashboard manually
4. Restart the dev server
