import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { PostgresSessionRepository } from '@/lib/session/postgres-repository'
import { createHotReloadSafeSingleton } from '@/lib/singleton'
import { runtimePool, transaction } from '@/lib/db/postgres'
import { SessionCalls } from '@/lib/session/calls'
import { retainedTranscript } from '@/lib/session/retention'

export interface PostCallInput {
  provider: 'elevenlabs'
  deliveryId?: string
  eventType: string
  conversationId: string
  eventTimestamp?: string
  body: string
  sessionId: string
  callId?: string
  callDurationSecs: number
  transcript: string
}

export interface PostCallJob {
  id: string
  receiptKey: string
  sessionId: string
  callId?: string
  conversationId: string
  callDurationSecs: number
  transcript: string
  leaseToken: string
}

export function receiptKey(input: PostCallInput): string {
  const bodyHash = createHash('sha256').update(input.body).digest('hex')
  if (input.deliveryId) return `${input.provider}:delivery:${input.deliveryId}`
  return [input.provider, input.eventType, input.conversationId, input.eventTimestamp ?? '', bodyHash].join(':')
}

export interface PostCallQueue {
  accept(input: PostCallInput): Promise<{ duplicate: boolean }>
  claim(): Promise<PostCallJob | undefined>
  finish(job: PostCallJob, status: 'complete' | 'failed', error?: string): Promise<void>
}

class MemoryPostCallQueue implements PostCallQueue {
  private receipts = new Map<string, string>()

  async accept(input: PostCallInput) {
    const key = receiptKey(input)
    const bodyHash = createHash('sha256').update(input.body).digest('hex')
    const existing = this.receipts.get(key)
    if (existing && existing !== bodyHash) throw new Error('Webhook delivery ID was reused with a different body')
    if (existing) return { duplicate: true }
    this.receipts.set(key, bodyHash)
    return { duplicate: false }
  }

  async claim() {
    return undefined
  }

  async finish() {}
}

export class PostgresPostCallQueue implements PostCallQueue {
  constructor(
    private readonly pool: Pool,
    private readonly leaseSeconds = 300
  ) {}

  async accept(input: PostCallInput) {
    const key = receiptKey(input)
    const bodyHash = createHash('sha256').update(input.body).digest('hex')
    return transaction(this.pool, async client => {
      const receipt = await client.query(
        `INSERT INTO webhook_receipts
          (receipt_key, provider, delivery_id, event_type, conversation_id, event_timestamp, body_sha256, signature_valid, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
         ON CONFLICT (receipt_key) DO NOTHING`,
        [
          key,
          input.provider,
          input.deliveryId ?? null,
          input.eventType,
          input.conversationId,
          input.eventTimestamp ?? null,
          createHash('sha256').update(input.body).digest('hex'),
          input.sessionId,
        ]
      )
      if (!receipt.rowCount) {
        const existing = await client.query<{ body_sha256: string }>(
          'SELECT body_sha256 FROM webhook_receipts WHERE receipt_key = $1',
          [key]
        )
        if (existing.rows[0]?.body_sha256 !== bodyHash) {
          throw new Error('Webhook delivery ID was reused with a different body')
        }
        return { duplicate: true }
      }
      const origin = input.callId
        ? (
            await client.query<{ created_at: Date }>(
              'SELECT created_at FROM session_calls WHERE id = $1 AND session_id = $2',
              [input.callId, input.sessionId]
            )
          ).rows[0]?.created_at
        : undefined
      const transcript = retainedTranscript(input.transcript, (origin ?? new Date()).toISOString()) ?? ''
      await client.query(
        'INSERT INTO post_call_jobs (receipt_key, session_id, call_duration_secs, transcript, call_id, conversation_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [key, input.sessionId, input.callDurationSecs, transcript, input.callId ?? null, input.conversationId]
      )
      return { duplicate: false }
    })
  }

  async claim() {
    return transaction(this.pool, async client => {
      await client.query(
        "UPDATE post_call_jobs SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = now() WHERE status = 'running' AND lease_expires_at < now()"
      )
      await client.query(
        "UPDATE webhook_receipts r SET status = 'queued' FROM post_call_jobs j WHERE j.receipt_key = r.receipt_key AND j.status = 'queued' AND r.status = 'processing'"
      )
      const result = await client.query<{
        id: string
        receipt_key: string
        session_id: string
        call_duration_secs: string
        transcript: string
        call_id: string | null
        conversation_id: string | null
      }>(
        "SELECT id, receipt_key, session_id, call_duration_secs, transcript, call_id, conversation_id FROM post_call_jobs WHERE status = 'queued' AND available_at <= clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1"
      )
      const row = result.rows[0]
      if (!row) return undefined
      const leaseToken = randomUUID()
      await client.query(
        "UPDATE post_call_jobs SET status = 'running', attempt_count = attempt_count + 1, lease_token = $2, lease_expires_at = now() + ($3 || ' seconds')::interval, updated_at = now() WHERE id = $1",
        [row.id, leaseToken, this.leaseSeconds]
      )
      await client.query("UPDATE webhook_receipts SET status = 'processing' WHERE receipt_key = $1", [row.receipt_key])
      return {
        id: row.id,
        receiptKey: row.receipt_key,
        sessionId: row.session_id,
        callId: row.call_id ?? undefined,
        conversationId: row.conversation_id ?? row.session_id,
        callDurationSecs: Number(row.call_duration_secs),
        transcript: row.transcript,
        leaseToken,
      }
    })
  }

  async finalize(job: PostCallJob): Promise<boolean> {
    return new PostgresSessionRepository(this.pool).mutate(job.sessionId, async (store, client) => {
      const current = await client.query<{ transcript: string; created_at: Date }>(
        "SELECT transcript, created_at FROM post_call_jobs WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_expires_at > clock_timestamp() FOR UPDATE",
        [job.id, job.leaseToken]
      )
      if (!current.rowCount) return false
      await new SessionCalls(this.pool).complete(
        {
          ...job,
          transcript: current.rows[0].transcript,
          transcriptRecordedAt: current.rows[0].created_at.toISOString(),
        },
        store,
        client
      )
      await client.query(
        "UPDATE post_call_jobs SET status = 'complete', lease_token = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1",
        [job.id]
      )
      await client.query(
        "UPDATE webhook_receipts SET status = 'processed', processed_at = now(), error = NULL WHERE receipt_key = $1",
        [job.receiptKey]
      )
      return true
    })
  }

  async finish(job: PostCallJob, status: 'complete' | 'failed', error?: string) {
    await transaction(this.pool, async client => {
      const current = await client.query<{ attempt_count: number }>(
        "SELECT attempt_count FROM post_call_jobs WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_expires_at > clock_timestamp() FOR UPDATE",
        [job.id, job.leaseToken]
      )
      if (!current.rowCount) return
      const terminal = status === 'complete' || Number(current.rows[0].attempt_count) >= 5
      const jobStatus = terminal ? (status === 'complete' ? 'complete' : 'failed') : 'queued'
      const receiptStatus = status === 'complete' ? 'processed' : terminal ? 'failed' : 'queued'
      await client.query(
        "UPDATE post_call_jobs SET status = $3, error = $4, available_at = clock_timestamp() + ($5 * interval '1 second'), lease_token = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND lease_token = $2",
        [job.id, job.leaseToken, jobStatus, error ?? null, Math.min(60, 2 ** current.rows[0].attempt_count)]
      )
      await client.query(
        "UPDATE webhook_receipts SET status = $2, error = $3, processed_at = CASE WHEN $2 = 'processed' THEN now() ELSE processed_at END WHERE receipt_key = $1",
        [job.receiptKey, receiptStatus, error ?? null]
      )
    })
  }
}

export function getPostCallQueue(): PostCallQueue {
  if (!process.env.DATABASE_URL)
    return createHotReloadSafeSingleton('__memoryPostCallQueue', () => new MemoryPostCallQueue())
  return createHotReloadSafeSingleton('__postCallQueue', () => new PostgresPostCallQueue(runtimePool()))
}
