import { createHmac } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Compute an ElevenLabs webhook signature header value.
 * Algorithm matches elevenlabs-js constructEvent:
 *   HMAC-SHA256({timestamp}.{rawBody}, secret), prefixed with "v0="
 *   Header format: "t={unix_seconds},v0={hex}"
 */
export function signWebhookPayload(rawBody: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const sig = 'v0=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  return `t=${timestamp},${sig}`
}

/**
 * Read an env var from .env.local first, falling back to process.env.
 * Lets E2E tests sign webhook requests using the same secret the running
 * server is configured with, without baking the value into the test file.
 */
export function loadEnvVar(key: string): string | undefined {
  try {
    const envFile = fs.readFileSync(path.resolve('.env.local'), 'utf8')
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const eqIdx = trimmed.indexOf('=')
      if (trimmed.slice(0, eqIdx) === key) return trimmed.slice(eqIdx + 1)
    }
  } catch { /* .env.local not found */ }
  return process.env[key]
}

/**
 * Build the fetch options needed to send a signed post-call webhook.
 * Pass webhookSecret = undefined to send unsigned (only safe when
 * ELEVENLABS_WEBHOOK_SECRET is not configured on the server).
 */
export function buildSignedPostCallRequest(
  sessionId: string,
  webhookSecret: string | undefined,
  overrides: { callDurationSecs?: number } = {}
): { headers: Record<string, string>; data: string } {
  const rawBody = JSON.stringify({
    type: 'post_call_transcription',
    data: {
      metadata: { call_duration_secs: overrides.callDurationSecs ?? 60 },
      transcript: [{ role: 'agent', message: 'OK.', time_in_call_secs: 0 }],
      conversation_initiation_client_data: {
        dynamic_variables: { session_id: sessionId },
      },
    },
  })

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (webhookSecret) {
    headers['ElevenLabs-Signature'] = signWebhookPayload(rawBody, webhookSecret)
  }

  return { headers, data: rawBody }
}
