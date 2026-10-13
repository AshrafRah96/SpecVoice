import { createHmac } from 'crypto'

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

export const TEST_WEBHOOK_SECRET = 'specvoice-e2e-webhook-secret'

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

export { TEST_OPERATOR_PASSPHRASE } from '../helpers/operator-fixture'

export function testCapability(sessionId: string): string {
  const payload = Buffer.from(JSON.stringify({ sid: sessionId, iat: Date.now(), exp: Date.now() + 3600000 })).toString(
    'base64url'
  )
  return `${payload}.${createHmac('sha256', 'specvoice-e2e-capability-secret-fixed').update(payload).digest('base64url')}`
}
