# Tutorial: Your First SpecVoice Session

This tutorial walks you through a complete SpecVoice session end-to-end, from starting a call to receiving a PR spec. It assumes you've completed the [setup guide](../README.md).

---

## What you're about to do

SpecVoice runs as a voice conversation with a Claude-powered senior engineer. During the call it reads your repo on demand, logs every architectural decision live, and at the end crystallises everything into a structured PR spec. You then trigger a build that will turn that spec into a draft PR.

The full flow takes about 10–15 minutes for a real feature conversation.

---

## Setting up ngrok

ElevenLabs tool webhooks call back to your server during a live call. `localhost:3000` is not reachable from ElevenLabs' servers, so you need a public tunnel.

**1. Install ngrok**

```bash
npm install -g ngrok
```

Or download from [ngrok.com/download](https://ngrok.com/download) and add it to your PATH.

**2. Authenticate** (one-time, free account required)

```bash
ngrok config add-authtoken YOUR_AUTH_TOKEN
```

Get your token at [dashboard.ngrok.com/authtokens](https://dashboard.ngrok.com/authtokens).

**3. Start the tunnel**

```bash
ngrok http 3000
```

Copy the `Forwarding` URL — it looks like `https://abc123.ngrok-free.app`.

**4. Update `.env.local`**

```
NEXT_PUBLIC_APP_URL=https://abc123.ngrok-free.app
```

**5. Re-sync the agent** (required whenever the URL changes)

```bash
npx tsx src/scripts/setup-agent.ts
```

This updates the tool webhook URLs registered in ElevenLabs to point at your new tunnel.

> **Note:** Free ngrok URLs change every time you restart the tunnel. Re-run steps 3–5 each session. A paid ngrok plan gives you a static domain so you only do this once.

---

## Before you start

Check these or the call will fail silently:

- `npm run dev` is running
- Your ngrok tunnel is up and `NEXT_PUBLIC_APP_URL` in `.env.local` matches the current tunnel URL
- `ELEVENLABS_AGENT_ID` is set (from running `npx tsx src/scripts/setup-agent.ts`)
- Your browser mic is not blocked — check `chrome://settings/content/microphone`

---

## Step 1: Create a session

Open [http://localhost:3000](http://localhost:3000).

In the **left panel**, paste a GitHub repo URL into the field:

```
https://github.com/your-org/your-repo
```

Or, for local repos, paste the absolute path to the directory:

```
/Users/you/code/my-project
```

Click **Start Session**. The session ID appears below the input — this is the routing key that connects the agent's tool calls back to this browser tab. The SSE status indicator should show **connected** within a second.

> **Nothing visible happened in the centre/right panels yet.** That's expected — the agent hasn't read anything yet.

---

## Step 2: Start the call

Click **Start Web Call**. Your browser will request microphone access if it hasn't already.

You'll hear the agent's opening line:

> *"Alright, I've got access to the repo. Give me a moment to look around, then tell me what we're building."*

The **Orb** in the left panel pulses to show the agent is active.

---

## Step 3: Have the conversation

Describe the feature you want to build. The agent is configured with `TurnEagerness.Patient` so it won't cut you off mid-sentence.

**What the agent does during the call:**

| You say... | Agent does... | Dashboard updates |
|---|---|---|
| "What files are in the src directory?" | Calls `list_files` | No visible change (no mutation) |
| Anything about a specific file | Calls `read_file` | Centre panel: file appears in **Files Read** list |
| "Let's use X approach because Y" | Calls `save_decision` | Right panel: decision card appears live |
| "I'm not sure about the auth layer" | Calls `flag_question` | Decision list: open question added |
| "OK write it up" | Calls `generate_spec` | Right panel: switches to **Spec** tab |

File reads are capped at 4000 characters. If the agent reads the same file twice, two entries appear.

**Tips for a good session:**

- Tell the agent the names of files you know are relevant — it reads them on demand, it doesn't crawl the whole repo
- Challenge its assumptions. The eval criteria include `assumptions_challenged` — it's designed to push back
- When you're done speccing, say "write it up" or "generate the spec" to trigger `generate_spec`

---

## Step 4: End the call

Click **End Call**. Within a few seconds:

1. The post-call webhook fires at `POST /api/agent/post-call`
2. Session status transitions to **Build It** (`buildStatus: 'ready'`)
3. The **Spec** tab in the right panel shows the full structured output

If the status stays at **In Call** for more than 10 seconds, see the [Troubleshooting section](../README.md#troubleshooting) in the README — the webhook URL or secret is likely misconfigured.

---

## Step 5: Review the spec

The **Spec** tab shows the output from `generate_spec`, structured as:

- Feature summary
- Decisions made (with rationale and alternatives considered)
- Files to modify
- Open questions (if any — these block the build)

**Before triggering the build**, resolve any open questions. The complexity gate will block a build if `openQuestions.length > 0`. See [Build Pipeline](./build-pipeline.md) for the full gate logic.

---

## Step 6: Trigger the build

Click **Build It**.

The build runs asynchronously. The right panel switches to **BuildProgress** and streams phase updates live via SSE:

| Phase | What's happening |
|---|---|
| `analyzing` | Parsing spec decisions, identifying affected modules |
| `writing` | Generating implementation scaffold |
| `reviewing` | Running static checks |
| `cloning` | Cloning repo to temp dir |
| `pr` | Creating draft PR via GitHub API |

When complete, the PR URL appears in the panel.

---

## What to do if it goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| Spec tab never appears | `generate_spec` webhook didn't fire | Ask the agent explicitly: "please generate the spec now" |
| Build blocked immediately | Open questions in the session | Resolve them by continuing the conversation, then rebuild |
| Build blocked: `too_large` | Agent read ≥ 100 files | Narrow scope — the spec's split suggestion shows how to break it up |
| Build stuck in `analyzing` for > 5 min | Claude Code CLI running a complex spec | Check server logs; kill and retry with a narrower scope |

For webhook and audio issues, see [README Troubleshooting](../README.md#troubleshooting).
