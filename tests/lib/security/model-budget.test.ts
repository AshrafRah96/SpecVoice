import { describe, expect, it } from 'vitest'
import { ModelBudgetError, requestReservation, usageCost } from '@/lib/security/model-budget'

const request = () => ({
  model: 'claude-sonnet-4-6',
  max_tokens: 2048,
  messages: [{ role: 'user', content: 'Review src/app.ts.' }],
})
const reserve = (body: unknown) => requestReservation(body, Buffer.byteLength(JSON.stringify(body)))

describe('model request policy', () => {
  it('accepts a coding conversation with local tools, cached text and thinking', () => {
    const body = {
      ...request(),
      stream: true,
      system: [{ type: 'text', text: 'Work inside the repository.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
      tools: [
        {
          type: 'custom',
          name: 'Read',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
          description: 'Read local text.',
        },
      ],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [
        { role: 'user', content: 'Check https://github.com/example/repository source.' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Inspect the source first.', signature: 'signed' },
            { type: 'redacted_thinking', data: 'opaque-provider-thinking' },
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: 'src/app.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'read-1', content: [{ type: 'text', text: 'export const value = 1' }] },
          ],
        },
      ],
      metadata: { user_id: 'anonymous-local-operator' },
      output_config: { effort: 'high' },
    }
    expect(reserve(body)).toBeGreaterThan(0)
    expect(body.model).toBe('claude-sonnet-4-6')
  })

  it('reserves every body byte at the worst cache-write price and the full output allowance', () => {
    expect(requestReservation({ ...request(), max_tokens: 8192 }, 4096)).toBe(0.1536)
    expect(requestReservation(request(), 1024 * 1024)).toBeGreaterThan(6)
  })

  it.each(['claude-sonnet-4-5', 'claude-sonnet-4-6-latest', 'claude-opus-4-6', 'sonnet'])(
    'rejects model aliases and other models: %s',
    model => {
      expect(() => reserve({ ...request(), model })).toThrow(ModelBudgetError)
    }
  )

  it.each([0, -1, 8193, 1.5, '8192', null])('rejects unbounded or invalid max_tokens: %s', max_tokens => {
    expect(() => reserve({ ...request(), max_tokens })).toThrow(ModelBudgetError)
  })

  it.each([0, -1, 1.5, 1024 * 1024 + 1, Infinity, NaN])('rejects invalid request byte counts: %s', bytes => {
    expect(() => requestReservation(request(), bytes)).toThrow(expect.objectContaining({ status: 413 }))
  })

  it.each(['advisor', 'inference_geo', 'speed', 'mcp_servers', 'container', 'unknown_parameter'])(
    'rejects unpriced or unknown top-level options: %s',
    key => {
      expect(() => reserve({ ...request(), [key]: 'enabled' })).toThrow(ModelBudgetError)
    }
  )

  it.each(['web_search_20250305', 'web_fetch_20250910', 'code_execution_20250825', 'computer_20250124'])(
    'rejects provider-executed tools: %s',
    type => {
      expect(() => reserve({ ...request(), tools: [{ type, name: 'paid-tool', input_schema: {} }] })).toThrow(
        ModelBudgetError
      )
    }
  )

  it('allows ordinary custom tools with no explicit type, but no hidden paid options', () => {
    expect(reserve({ ...request(), tools: [{ name: 'Bash', input_schema: { type: 'object' } }] })).toBeGreaterThan(0)
    expect(() =>
      reserve({ ...request(), tools: [{ type: 'custom', name: 'Bash', input_schema: {}, advisor: true }] })
    ).toThrow(ModelBudgetError)
    expect(() => reserve({ ...request(), output_config: { speed: 'fast' } })).toThrow(ModelBudgetError)
  })

  it.each([
    { type: 'image', source: { type: 'base64', data: 'secret-binary' } },
    { type: 'document', source: { type: 'url', url: 'https://example.com/huge.pdf' } },
    {
      type: 'tool_result',
      tool_use_id: 'read-1',
      content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image' } }],
    },
    {
      type: 'tool_use',
      id: 'read-1',
      name: 'Read',
      input: { nested: { source: { type: 'base64', data: 'hidden-binary' } } },
    },
    { type: 'search_result', source: 'https://example.com', title: 'paid result', content: [] },
  ])('rejects unsupported content or nested binary/remote sources: %j', block => {
    expect(() => reserve({ ...request(), messages: [{ role: 'user', content: [block] }] })).toThrow(ModelBudgetError)
  })

  it('validates streaming, sampling, tool options and thinking against explicit bounds', () => {
    for (const extra of [
      { stream: 'true' },
      { temperature: 2 },
      { top_p: -1 },
      { top_k: 1.5 },
      { thinking: { type: 'enabled', budget_tokens: 2048 } },
      { tool_choice: { type: 'server' } },
      { service_tier: 'priority' },
    ])
      expect(() => reserve({ ...request(), ...extra })).toThrow(ModelBudgetError)
  })

  it('rejects absent messages and excessive nesting without overflowing the stack', () => {
    expect(() => reserve({ ...request(), messages: [] })).toThrow(ModelBudgetError)
    const recursive: Record<string, unknown> = {}
    recursive.child = recursive
    expect(() => requestReservation(recursive, 50)).toThrow('nesting exceeds')
  })
})

describe('model usage pricing', () => {
  it('accepts pinned CLI thinking controls but rejects compaction and paid server tools', () => {
    const body = {
      ...request(),
      thinking: { type: 'adaptive', display: 'updates' },
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    }
    expect(reserve(body)).toBeGreaterThan(0)
    expect(() => reserve({ ...body, context_management: { edits: [{ type: 'compact_20260112' }] } })).toThrow(
      ModelBudgetError
    )
    expect(() => reserve({ ...body, safeguards: [{ type: 'dangerous_tool_use' }] })).toThrow(ModelBudgetError)
  })
  it('prices uncached input, output, cache creation and cache hits separately', () => {
    expect(
      usageCost({
        input_tokens: 1000,
        output_tokens: 1000,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 1000,
      })
    ).toBeCloseTo(0.0243, 9)
    expect(usageCost({ input_tokens: 0, output_tokens: 0 })).toBe(0)
  })

  it('uses explicit cache durations when present, without double counting the aggregate', () => {
    expect(
      usageCost({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 500 },
      })
    ).toBeCloseTo(0.004875, 9)
    expect(
      usageCost({ input_tokens: 0, output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 1000 } })
    ).toBeCloseTo(0.00375, 9)
    expect(usageCost({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 })).toBeCloseTo(0.006, 9)
  })

  it.each([
    '{}',
    '{"input_tokens":5}',
    '{"input_tokens":-1,"output_tokens":2}',
    '{"input_tokens":"100","output_tokens":2}',
    '{"input_tokens":1.1,"output_tokens":2}',
    '{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":-1}',
    '{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":1}}',
  ])('marks malformed usage unknown so settlement retains the reservation: %s', json => {
    expect(usageCost(JSON.parse(json))).toBeUndefined()
  })
})
