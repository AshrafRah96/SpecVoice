# SpecVoice

Code-aware voice agent on ElevenLabs Conversational AI. Joins phone calls or web conversations as senior engineer. Reads GitHub repo during call; outputs structured PR spec. Post-call build pipeline uses Claude Code in headless mode to implement spec and open draft PR.

**Stack:** Next.js 16 App Router · TypeScript · ElevenLabs Conversational AI · Anthropic Claude · Octokit · Tailwind + shadcn/ui · Vitest · Playwright

---

## Setup Guide

### 1. Prerequisites

- Node.js 20.19+
- [ElevenLabs](https://elevenlabs.io) account (free tier supports testing)
- [Anthropic](https://console.anthropic.com) API key (post-call build pipeline)
- GitHub personal access token (optional; required for private repos and higher rate limits)
- [ngrok](https://ngrok.com) or equivalent local development tunnel (ElevenLabs must reach webhooks)

---

### 2. Install dependencies

```bash
npm install
```

---

### 3. Configure environment variables

Copy example; fill values:

```bash
cp .env.local.example .env.local
```

| Variable                             | Required                 | Description                                                           |
| ------------------------------------ | ------------------------ | --------------------------------------------------------------------- |
| `ELEVENLABS_API_KEY`                 | Yes                      | ElevenLabs → Profile → API Keys                                       |
| `ELEVENLABS_AGENT_ID`                | After step 5             | Auto-filled by `setup-agent.ts` output                                |
| `NEXT_PUBLIC_ELEVENLABS_AGENT_ID`    | After step 5             | Same value; required for browser web-call widget                      |
| `NEXT_PUBLIC_APP_URL`                | Yes                      | Public URL (local ngrok tunnel, e.g. `https://abc123.ngrok-free.app`) |
| `GITHUB_TOKEN`                       | Recommended              | Personal access token with `repo` read scope                          |
| `ANTHROPIC_API_KEY`                  | Yes (build pipeline)     | Claude Code CLI post-call build key                                   |
| `ELEVENLABS_WEBHOOK_SECRET`          | Recommended              | HMAC secret verifying ElevenLabs webhook signatures                   |
| `SESSION_CAPABILITY_SECRET`          | Required for public use  | Random 32+ character secret for session capabilities                  |
| `SPECVOICE_LOCAL_REPO_ROOT`          | Required for local paths | Allowed root for `repoLocalPath`                                      |
| `SPECVOICE_ALLOW_IN_MEMORY_SESSIONS` | Local only               | Set `true` only for deliberate single-process deployments             |

> **Local development:** `NEXT_PUBLIC_APP_URL` must be ngrok tunnel URL, not `localhost`. ElevenLabs calls tool webhooks over internet; localhost is unreachable.

---

### 4. Start your tunnel

```bash
ngrok http 3000
```

Set `NEXT_PUBLIC_APP_URL` in `.env.local` to ngrok's printed `https://` URL. Keep ngrok running during development.

> When ngrok URL changes, update `NEXT_PUBLIC_APP_URL` and re-run step 5. Free tier assigns new URL each restart.

---

### 5. Start the dev server

```bash
npm run dev
```

---

### 6. Create the ElevenLabs agent

Script creates or updates ElevenLabs agent, registers all tool webhook URLs under `NEXT_PUBLIC_APP_URL`, and prints agent ID:

```bash
npx tsx src/scripts/setup-agent.ts
```

Copy printed agent ID into `.env.local`:

```
ELEVENLABS_AGENT_ID=agent_xxxxxxxxxxxx
NEXT_PUBLIC_ELEVENLABS_AGENT_ID=agent_xxxxxxxxxxxx
```

Restart dev server after updating `.env.local`.

> Re-run script whenever ngrok URL changes; ElevenLabs agent config stores tool webhook URLs.

---

### 7. Configure the post-call webhook in ElevenLabs

Configure once manually; `setup-agent.ts` does **not automate** this step.

1. Go to [ElevenLabs → Settings → Webhooks](https://elevenlabs.io/app/settings/webhooks)
2. Create webhook:
   - **URL:** `https://<your-ngrok-url>/api/agent/post-call`
   - **Auth Method:** HMAC
3. Copy ElevenLabs signing secret into `.env.local`:
   ```
   ELEVENLABS_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx
   ```
4. Open [ElevenLabs → Agents → your agent → Settings](https://elevenlabs.io/app/agents). Assign webhook under **Post-Call Webhook**; tick **Transcript** event.
5. Restart dev server.

---

### 8. Verify the setup

Open dashboard: `http://localhost:3000`.

1. Enter GitHub repo URL; click **Start Session**
2. Click **Start Web Call**; browser mic activates and connects to agent
3. Talk; agent reads repo, asks clarifying questions, logs decisions live in dashboard
4. End call; within seconds, session status should change from **In Call** to **Build It** (buildStatus: ready)

Confirm webhooks in ngrok inspector: `http://localhost:4040`. Expect POSTs to `/api/tools/read-file`, `/api/tools/save-decision`, and `/api/agent/post-call`.

---

## Commands

```bash
npm run dev            # start dev server
npm run build          # production build
npm run lint           # lint
npm run typecheck      # TypeScript check
npm run format:check   # Prettier check
npm test               # vitest unit tests
npm run test:e2e       # Playwright E2E tests (requires dev server running)
npm run verify         # format, typecheck, lint, unit tests, and production build
npx tsx src/scripts/setup-agent.ts   # create/update ElevenLabs agent
```

Requires Node.js 20.19 or newer. `.nvmrc` pins CI and local baseline.

See [documentation map](./docs/README.md): architecture, API, build, extension, testing, agent guidance.

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

No vector database, embeddings, or RAG. Agent reads files on demand via tools; reasons about code natively.

---

## Troubleshooting

**Session stuck in "In Call" after the call ends**
Post-call webhook didn't fire. Check:

1. ElevenLabs webhook URL matches current ngrok URL
2. `ELEVENLABS_WEBHOOK_SECRET` in `.env.local` matches the HMAC secret in ElevenLabs
3. Dev server restarted after adding secret
4. ngrok inspector (`localhost:4040`) shows a POST to `/api/agent/post-call`

**Agent connects but no audio**

1. Check browser tab isn't muted (right-click tab → Unmute)
2. Check system audio output device
3. Click page after starting call (browsers may suspend audio context until user gesture)

**Tool webhooks not firing (filesRead stays empty)**
Agent tool URLs point to wrong host. Update `NEXT_PUBLIC_APP_URL` in `.env.local`, then re-run `setup-agent.ts`.

**ngrok URL changed**

1. Update `NEXT_PUBLIC_APP_URL` in `.env.local`
2. Re-run `npx tsx src/scripts/setup-agent.ts`
3. Update post-call webhook URL in ElevenLabs dashboard manually
4. Restart dev server
