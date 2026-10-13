import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { requestReservation } from '@/lib/security/model-budget'
import { bearer, readServiceJson, serviceJson } from '@/lib/security/service-http'

// Public fixture token. This server has no upstream transport or provider credentials.
export const ISOLATION_FIXTURE_TOKEN = 'specvoice-isolation-fixture-'.padEnd(43, '0')

export function createIsolationModelFixture() {
  const status = {
    active: true,
    requests: 0,
    completed: false,
    policyFailures: [] as Array<{
      error: string
      fields: string[]
      toolFields: string[][]
      toolNames: string[]
      anthropicBeta: string
      controls: Record<string, string>
    }>,
    toolFailures: [] as string[],
    unexpectedRequests: [] as string[],
  }
  const steps = [
    { name: 'Read', input: { file_path: '/work/repo/index.js' } },
    {
      name: 'Edit',
      input: {
        file_path: '/work/repo/index.js',
        old_string: 'module.exports = 0',
        new_string: 'module.exports = 42',
      },
    },
    {
      name: 'Bash',
      input: { command: 'git checkout -b spec-voice/isolation-test', description: 'Create fixture branch' },
    },
    { name: 'Bash', input: { command: 'git add index.js', description: 'Stage synthetic change' } },
    { name: 'Bash', input: { command: 'git commit -m fixture', description: 'Commit synthetic change' } },
  ]
  let step = 0
  const server = createServer((request, response) => {
    const handle = async () => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname
      if (bearer(request) !== ISOLATION_FIXTURE_TOKEN)
        return serviceJson(response, 401, { error: 'Synthetic fixture token required' })
      if (request.method === 'GET' && path === '/attempt-status') return serviceJson(response, 200, status)
      if (request.method !== 'POST' || path !== '/v1/messages') {
        status.unexpectedRequests.push(`${request.method} ${path}`.slice(0, 200))
        return serviceJson(response, 404, { error: 'Unsupported synthetic fixture request' })
      }
      status.requests++
      const body = await readServiceJson(request, 1024 * 1024)
      try {
        requestReservation(body, Buffer.byteLength(JSON.stringify(body)))
      } catch (error) {
        const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
        status.policyFailures.push({
          error: error instanceof Error ? error.message.slice(0, 500) : 'Policy rejected request',
          fields: Object.keys(record),
          toolFields: Array.isArray(record.tools)
            ? record.tools.map(tool => (tool && typeof tool === 'object' ? Object.keys(tool) : []))
            : [],
          toolNames: Array.isArray(record.tools)
            ? record.tools.map(tool => String(tool?.name ?? '').slice(0, 128))
            : [],
          anthropicBeta: String(request.headers['anthropic-beta'] ?? '').slice(0, 1000),
          controls: Object.fromEntries(
            ['thinking', 'context_management', 'safeguards', 'output_config'].map(key => [
              key,
              JSON.stringify(record[key])?.slice(0, 1000) ?? 'absent',
            ])
          ),
        })
        return serviceJson(response, 400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: status.policyFailures.at(-1)!.error },
        })
      }
      const requestBody = body as {
        messages: Array<{ content: unknown }>
        tools?: Array<{ name: string }>
        stream?: boolean
      }
      for (const message of requestBody.messages) {
        if (!Array.isArray(message.content)) continue
        for (const block of message.content) {
          if (block.type === 'tool_result' && block.is_error)
            status.toolFailures.push(JSON.stringify(block.content).slice(0, 1000))
        }
      }
      if (status.toolFailures.length)
        return serviceJson(response, 400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Synthetic tool execution failed; inspect /attempt-status' },
        })
      const action = steps[step]
      if (action && !requestBody.tools?.some(tool => tool.name === action.name))
        throw new Error(`Actual CLI request did not advertise required tool ${action.name}`)
      const id = `msg_isolation_${step}`
      const content = action
        ? { type: 'tool_use', id: `toolu_isolation_${step}`, name: action.name, input: action.input }
        : { type: 'text', text: 'Synthetic change committed.' }
      const message = {
        id,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [content],
        stop_reason: action ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }
      step++
      status.completed = !action
      if (!requestBody.stream) return serviceJson(response, 200, message)
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      const event = (type: string, data: object) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      event('message_start', {
        message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } },
      })
      event('content_block_start', {
        index: 0,
        content_block: action ? { ...content, input: {} } : { type: 'text', text: '' },
      })
      event('content_block_delta', {
        index: 0,
        delta: action
          ? { type: 'input_json_delta', partial_json: JSON.stringify(action.input) }
          : { type: 'text_delta', text: 'Synthetic change committed.' },
      })
      event('content_block_stop', { index: 0 })
      event('message_delta', {
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: 20 },
      })
      event('message_stop', {})
      response.end()
    }
    void handle().catch(error => {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Fixture failed'
      status.unexpectedRequests.push(message)
      serviceJson(response, 400, { type: 'error', error: { type: 'invalid_request_error', message } })
    })
  })
  server.requestTimeout = 10000
  server.headersTimeout = 5000
  return server
}

export function main() {
  if (process.env.SPECVOICE_ISOLATION_FIXTURE !== 'true')
    throw new Error('Synthetic fixture must be explicitly enabled')
  const server = createIsolationModelFixture().listen(3201, '0.0.0.0')
  const stop = () => {
    server.closeAllConnections()
    server.close()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
