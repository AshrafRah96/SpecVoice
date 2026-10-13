import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { database, transaction } from '@/lib/db/postgres'
import { executionDeadlineMs } from '@/execution/limits'

export interface ModelUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

export interface ModelReservation {
  id: string
  tokenHash: string
  reservedUsd: number
}

export class ModelBudgetError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'ModelBudgetError'
  }
}

const count = z.number().int().min(0).max(1_000_000_000)
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  cache_creation_input_tokens: count.optional(),
  cache_read_input_tokens: count.optional(),
  cache_creation: z
    .object({ ephemeral_5m_input_tokens: count.optional(), ephemeral_1h_input_tokens: count.optional() })
    .optional(),
})

/** USD prices per million tokens, verified 2026-10-13; missing cache TTL uses the higher one-hour price. */
export function usageCost(usage: ModelUsage): number | undefined {
  const parsed = usageSchema.safeParse(usage)
  if (!parsed.success) return undefined
  const value = parsed.data
  let creationCost = (value.cache_creation_input_tokens ?? 0) * 6
  if (value.cache_creation) {
    const short = value.cache_creation.ephemeral_5m_input_tokens ?? 0
    const long = value.cache_creation.ephemeral_1h_input_tokens ?? 0
    if (value.cache_creation_input_tokens !== undefined && short + long !== value.cache_creation_input_tokens)
      return undefined
    creationCost = short * 3.75 + long * 6
  }
  return (
    (value.input_tokens * 3 + value.output_tokens * 15 + creationCost + (value.cache_read_input_tokens ?? 0) * 0.3) /
    1_000_000
  )
}

const cacheControl = z.object({ type: z.literal('ephemeral'), ttl: z.enum(['5m', '1h']).optional() }).strict()
const textBlock = z
  .object({ type: z.literal('text'), text: z.string(), cache_control: cacheControl.optional() })
  .strict()
const contentBlock: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    textBlock,
    z
      .object({
        type: z.literal('tool_use'),
        id: z.string(),
        name: z.string(),
        input: z.record(z.unknown()),
        cache_control: cacheControl.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('tool_result'),
        tool_use_id: z.string(),
        content: z.union([z.string(), z.array(contentBlock)]).optional(),
        is_error: z.boolean().optional(),
        cache_control: cacheControl.optional(),
      })
      .strict(),
    z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string() }).strict(),
    z.object({ type: z.literal('redacted_thinking'), data: z.string() }).strict(),
  ])
)

const requestSchema = z
  .object({
    model: z.literal('claude-sonnet-4-6'),
    max_tokens: z.number().int().min(1).max(8192),
    messages: z
      .array(
        z
          .object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(contentBlock)]) })
          .strict()
      )
      .min(1)
      .max(1000),
    system: z.union([z.string(), z.array(textBlock)]).optional(),
    stream: z.boolean().optional(),
    tools: z
      .array(
        z
          .object({
            type: z.literal('custom').optional(),
            name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
            description: z.string().optional(),
            input_schema: z.record(z.unknown()),
            cache_control: cacheControl.optional(),
            strict: z.boolean().optional(),
            defer_loading: z.boolean().optional(),
            eager_input_streaming: z.boolean().optional(),
            allowed_callers: z.array(z.literal('direct')).optional(),
          })
          .strict()
      )
      .max(128)
      .optional(),
    tool_choice: z
      .object({
        type: z.enum(['auto', 'any', 'tool', 'none']),
        name: z.string().optional(),
        disable_parallel_tool_use: z.boolean().optional(),
      })
      .strict()
      .optional(),
    metadata: z
      .object({ user_id: z.string().max(1024).optional() })
      .strict()
      .optional(),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().min(0).max(500).optional(),
    stop_sequences: z.array(z.string().max(1024)).max(16).optional(),
    thinking: z
      .union([
        z
          .object({
            type: z.literal('enabled'),
            budget_tokens: z.number().int().min(1024).max(8192),
            display: z.enum(['summarized', 'omitted', 'updates']).optional(),
          })
          .strict(),
        z
          .object({
            type: z.enum(['disabled', 'adaptive']),
            display: z.enum(['summarized', 'omitted', 'updates']).optional(),
          })
          .strict(),
      ])
      .optional(),
    output_config: z
      .object({
        effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
        format: z
          .object({ type: z.literal('json_schema'), schema: z.record(z.unknown()) })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    cache_control: cacheControl.optional(),
    context_management: z
      .object({
        edits: z
          .array(z.object({ type: z.literal('clear_thinking_20251015'), keep: z.literal('all') }).strict())
          .max(1),
      })
      .strict()
      .optional(),
    service_tier: z.enum(['auto', 'standard_only']).optional(),
  })
  .strict()

function rejectSources(value: unknown, depth = 0): void {
  if (depth > 64) throw new ModelBudgetError(400, 'Model request nesting exceeds 64 levels.')
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (
    record.type === 'image' ||
    record.type === 'document' ||
    ((record.type === 'base64' || record.type === 'url') && ('data' in record || 'url' in record))
  ) {
    throw new ModelBudgetError(400, 'Image, document, and remote or base64 sources are not permitted.')
  }
  for (const child of Object.values(record)) rejectSources(child, depth + 1)
}

export function requestReservation(body: unknown, bodyBytes: number): number {
  if (!Number.isInteger(bodyBytes) || bodyBytes < 1 || bodyBytes > 1024 * 1024)
    throw new ModelBudgetError(413, 'Model request must be at most 1 MiB.')
  rejectSources(body)
  const result = requestSchema.safeParse(body)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new ModelBudgetError(400, `Unsupported model request at ${issue.path.join('.') || 'body'} (${issue.code}).`)
  }
  if (result.data.thinking?.type === 'enabled' && result.data.thinking.budget_tokens >= result.data.max_tokens)
    throw new ModelBudgetError(400, 'Thinking budget must be below max_tokens.')
  return ((bodyBytes + 1024) * 6 + result.data.max_tokens * 15) / 1_000_000
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
const validToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token)

export class ModelBudget {
  constructor(
    private readonly pool: Pool,
    private readonly limitUsd = 5
  ) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0)
      throw new ModelBudgetError(503, 'Invalid model budget configuration.')
  }

  async issue(attemptId: string, leaseToken: string): Promise<{ token: string; expiresAt: string }> {
    return transaction(this.pool, async client => {
      const owned = await client.query(
        "SELECT id FROM build_attempts WHERE id = $1 AND lease_token = $2 AND status = 'running' AND lease_expires_at > clock_timestamp() FOR UPDATE",
        [attemptId, leaseToken]
      )
      if (!owned.rowCount) throw new ModelBudgetError(403, 'Build Attempt lease is not active.')
      const token = randomBytes(32).toString('base64url')
      const result = await client.query<{ expires_at: Date }>(
        `INSERT INTO model_runs (attempt_id, token_hash, lease_token, expires_at, state)
         VALUES ($1, $2, $3, clock_timestamp() + ($4 * interval '1 millisecond'), 'active')
         ON CONFLICT (attempt_id) DO NOTHING RETURNING expires_at`,
        [attemptId, tokenHash(token), leaseToken, executionDeadlineMs()]
      )
      if (!result.rowCount)
        throw new ModelBudgetError(409, 'This Build Attempt already has a model budget; start an explicit new Build.')
      return { token, expiresAt: result.rows[0].expires_at.toISOString() }
    })
  }

  async active(token: string): Promise<boolean> {
    if (!validToken(token)) return false
    const result = await database(() =>
      this.pool.query(
        `SELECT r.attempt_id FROM model_runs r JOIN build_attempts b ON b.id = r.attempt_id AND b.lease_token = r.lease_token
       WHERE r.token_hash = $1 AND r.state = 'active' AND r.expires_at > clock_timestamp()
       AND b.status = 'running' AND b.lease_expires_at > clock_timestamp()`,
        [tokenHash(token)]
      )
    )
    return Boolean(result.rowCount)
  }

  async reserve(token: string, reservedUsd: number): Promise<ModelReservation> {
    if (!validToken(token)) throw new ModelBudgetError(401, 'Invalid model capability.')
    if (!Number.isFinite(reservedUsd) || reservedUsd <= 0) throw new ModelBudgetError(400, 'Invalid model reservation.')
    const hash = tokenHash(token)
    return transaction(this.pool, async client => {
      const result = await client.query<{
        attempt_id: string
        in_flight: boolean
        requests: number
      }>(
        `SELECT r.attempt_id, r.in_flight, r.requests FROM model_runs r
         JOIN build_attempts b ON b.id = r.attempt_id AND b.lease_token = r.lease_token
         WHERE r.token_hash = $1 AND r.state = 'active' AND r.expires_at > clock_timestamp()
         AND b.status = 'running' AND b.lease_expires_at > clock_timestamp() FOR UPDATE OF b, r`,
        [hash]
      )
      const run = result.rows[0]
      if (!run) throw new ModelBudgetError(401, 'Model capability expired or revoked.')
      if (run.in_flight) throw new ModelBudgetError(409, 'A model request is already in flight.')
      if (run.requests >= 100) throw new ModelBudgetError(429, 'Model request limit reached.')
      const debit = await client.query(
        `UPDATE model_runs SET spent_usd = spent_usd + $2::numeric, requests = requests + 1, in_flight = true
         WHERE attempt_id = $1 AND spent_usd + $2::numeric <= $3::numeric RETURNING attempt_id`,
        [run.attempt_id, reservedUsd, this.limitUsd]
      )
      if (!debit.rowCount) throw new ModelBudgetError(429, 'Model cost budget exhausted.')
      const id = randomUUID()
      await client.query(
        "INSERT INTO model_requests (id, attempt_id, reserved_usd, charged_usd, status) VALUES ($1, $2, $3, $3, 'pending')",
        [id, run.attempt_id, reservedUsd]
      )
      return { id, tokenHash: hash, reservedUsd }
    })
  }

  async finish(reservation: ModelReservation, usage?: ModelUsage, latencyMs?: number): Promise<void> {
    const actual = usage === undefined ? undefined : usageCost(usage)
    const latency =
      typeof latencyMs === 'number' && Number.isInteger(latencyMs) && latencyMs >= 0 && latencyMs <= 2_147_483_647
        ? latencyMs
        : null
    await transaction(this.pool, async client => {
      const result = await client.query<{ attempt_id: string; reserved_usd: string }>(
        `SELECT r.attempt_id, q.reserved_usd FROM model_runs r JOIN model_requests q ON q.attempt_id = r.attempt_id
         WHERE q.id = $1 AND r.token_hash = $2 AND q.status = 'pending' FOR UPDATE OF r, q`,
        [reservation.id, reservation.tokenHash]
      )
      const row = result.rows[0]
      if (!row) return
      const charge = actual ?? Number(row.reserved_usd)
      await client.query(
        `UPDATE model_runs SET spent_usd = greatest(0, spent_usd + $2::numeric - $3::numeric), in_flight = false,
         state = CASE WHEN $2::numeric > $3::numeric OR spent_usd + $2::numeric - $3::numeric > $4::numeric THEN 'revoked' ELSE state END
         WHERE attempt_id = $1`,
        [row.attempt_id, charge, row.reserved_usd, this.limitUsd]
      )
      await client.query(
        'UPDATE model_requests SET charged_usd = $2, usage = $3, latency_ms = $4, status = $5 WHERE id = $1',
        [
          reservation.id,
          charge,
          actual === undefined ? null : JSON.stringify(usage),
          latency,
          actual === undefined ? 'unknown' : 'reported',
        ]
      )
    })
  }

  async revoke(attemptId: string, leaseToken: string): Promise<void> {
    await database(() =>
      this.pool.query("UPDATE model_runs SET state = 'revoked' WHERE attempt_id = $1 AND lease_token = $2", [
        attemptId,
        leaseToken,
      ])
    )
  }
}
