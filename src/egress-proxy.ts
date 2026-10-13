import net from 'node:net'
import dns from 'node:dns/promises'
import { allowedHost } from '@/lib/security/egress'

const rules = (process.env.SPECVOICE_EGRESS_ALLOWLIST ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)

const server = net.createServer(client => {
  let buffer = Buffer.alloc(0)
  let upstream: net.Socket | undefined
  let settled = false
  const reject = (status: string) => {
    if (settled) return
    settled = true
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  }

  const onHeaders = () => {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    client.off('data', onData)
    const headers = buffer.subarray(0, end).toString('utf8')
    const [requestLine] = headers.split('\r\n')
    const [method, target] = requestLine.split(' ')
    if (method !== 'CONNECT' || !target) return reject('405 Method Not Allowed')
    const separator = target.lastIndexOf(':')
    const hostname = separator < 0 ? target : target.slice(0, separator)
    const port = separator < 0 ? 443 : Number(target.slice(separator + 1))
    if (!Number.isInteger(port) || ![443, 80].includes(port) || !allowedHost(hostname, rules)) {
      return reject('403 Forbidden')
    }
    void dns
      .lookup(hostname, { all: true })
      .then(addresses => {
        if (addresses.some(address => privateAddress(address.address))) return reject('403 Forbidden')
        upstream = net.connect(port, addresses[0].address)
        upstream.setTimeout(60_000, () => upstream?.destroy(new Error('idle timeout')))
        upstream.once('connect', () => {
          if (settled) return upstream?.destroy()
          settled = true
          client.setTimeout(60_000, () => client.destroy())
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream!.pipe(client)
          client.pipe(upstream!)
        })
        upstream.once('error', () => reject('502 Bad Gateway'))
        upstream.once('close', () => client.destroy())
      })
      .catch(() => reject('502 Bad Gateway'))
  }

  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > 16 * 1024) return reject('431 Request Header Fields Too Large')
    onHeaders()
  }
  client.on('data', onData)
  client.setTimeout(10_000, () => reject('408 Request Timeout'))
  client.once('error', () => upstream?.destroy())
  client.once('close', () => upstream?.destroy())
})

const port = Number(process.env.SPECVOICE_EGRESS_PROXY_PORT ?? 3128)
const maxConnections = Number(process.env.SPECVOICE_EGRESS_MAX_CONNECTIONS ?? 32)
let activeConnections = 0
server.on('connection', socket => {
  activeConnections += 1
  if (activeConnections > maxConnections) socket.destroy()
  socket.once('close', () => {
    activeConnections = Math.max(0, activeConnections - 1)
  })
})
server.listen(port, '0.0.0.0', () => {
  console.log(`[egress-proxy] listening on ${port}; ${rules.length} allowlist rules`)
})

process.once('SIGTERM', () => server.close(() => process.exit(0)))
process.once('SIGINT', () => server.close(() => process.exit(0)))

function privateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const octets = address.split('.').map(Number)
    const [a, b] = octets
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
    )
  }
  const normalized = address.toLowerCase()
  if (normalized.startsWith('::ffff:')) return privateAddress(normalized.slice('::ffff:'.length))
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
}
