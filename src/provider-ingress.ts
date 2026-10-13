import { createServer, request as forward } from 'node:http'
import { pathToFileURL } from 'node:url'

const providerPaths = new Set([
  '/api/agent/post-call',
  ...['list-files', 'read-file', 'search-code', 'save-decision', 'flag-question', 'generate-spec'].map(
    name => `/api/tools/${name}`
  ),
])
export function publicProviderRoute(method: string | undefined, url: string | undefined): boolean {
  return method === 'POST' && providerPaths.has(url ?? '')
}
export function createProviderIngress() {
  const server = createServer((request, response) => {
    if (!publicProviderRoute(request.method, request.url)) {
      response.writeHead(404)
      response.end()
      return
    }
    const upstream = forward(
      {
        hostname: 'web',
        port: 3000,
        path: request.url,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(request.headers['elevenlabs-signature']
            ? { 'elevenlabs-signature': request.headers['elevenlabs-signature'] }
            : {}),
          ...(request.headers['elevenlabs-delivery-id']
            ? { 'elevenlabs-delivery-id': request.headers['elevenlabs-delivery-id'] }
            : {}),
        },
      },
      result => {
        response.writeHead(result.statusCode ?? 502, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        })
        result.pipe(response)
      }
    )
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        upstream.destroy()
        if (!response.headersSent) response.writeHead(413)
        response.end()
        request.destroy()
      }
    })
    upstream.setTimeout(30000, () => upstream.destroy())
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    request.on('aborted', () => upstream.destroy())
    response.on('close', () => upstream.destroy())
    request.pipe(upstream)
  })
  server.headersTimeout = 10000
  server.requestTimeout = 30000
  server.maxConnections = 64
  return server
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createProviderIngress().listen(3001, '0.0.0.0')
  const stop = () => {
    server.closeAllConnections()
    server.close()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
