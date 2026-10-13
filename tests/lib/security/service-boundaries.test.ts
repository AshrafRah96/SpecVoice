import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executionContainerArgs } from '@/execution-launcher'
import { publicProviderRoute } from '@/provider-ingress'
import { serviceAuthorized } from '@/lib/security/service-http'

const image = `sha256:${'a'.repeat(64)}`
const token = 'attempt-only-token-'.padEnd(43, 'x')
const network = 'specvoice-execution-test'
const limitNames = [
  'SPECVOICE_EXECUTION_MEMORY_BYTES',
  'SPECVOICE_EXECUTION_WORKSPACE_BYTES',
  'SPECVOICE_EXECUTION_PIDS',
  'SPECVOICE_EXECUTION_CPUS',
] as const

function values(args: string[], option: string): string[] {
  return args.flatMap((arg, index) => (arg === option ? [args[index + 1]] : []))
}

function containerArgs(allowScripts = false) {
  return executionContainerArgs('specvoice-attempt-1-test', image, network, token, allowScripts)
}

beforeEach(() => {
  for (const name of [...limitNames, 'SPECVOICE_EXECUTION_DEADLINE_MS', 'SPECVOICE_BUILD_BUDGET_USD']) {
    vi.stubEnv(name, undefined)
  }
})

afterEach(() => vi.unstubAllEnvs())

describe('disposable execution container boundary', () => {
  it('uses a non-root, read-only container with bounded resources and one private workspace', () => {
    const args = containerArgs()
    expect(args[0]).toBe('create')
    expect(args.at(-1)).toBe(image)
    expect(args).toEqual(
      expect.arrayContaining([
        '-i',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--init',
        '--log-driver=none',
      ])
    )
    expect(values(args, '--user')).toEqual(['10001:10001'])
    expect(values(args, '--pids-limit')).toEqual(['256'])
    expect(values(args, '--cpus')).toEqual(['2'])
    expect(values(args, '--memory')).toEqual([String(4 * 1024 ** 3)])
    expect(values(args, '--memory-swap')).toEqual(values(args, '--memory'))
    expect(values(args, '--ulimit')).toEqual(['nofile=1024:1024', 'core=0'])
    expect(values(args, '--network')).toEqual([network])
    expect(values(args, '--dns')).toEqual(['127.0.0.1'])
    expect(values(args, '--tmpfs')).toEqual([
      `/work:rw,nosuid,nodev,size=${2 * 1024 ** 3},uid=10001,gid=10001,mode=0700`,
    ])
    expect(
      args.filter(arg => /^(-v|--volume|--mount|--privileged|--device|--pid|--ipc|--userns|--cap-add)(=|$)/.test(arg))
    ).toEqual([])
    expect(args.join(' ')).not.toContain('docker.sock')
    expect(args).not.toContain('--network=host')
    expect(args).not.toContain('--net=host')
  })

  it('passes only fixed execution settings and an attempt token, never inherited orchestration credentials', () => {
    const inheritedSecrets = [
      'DATABASE_URL',
      'GITHUB_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'SPECVOICE_SERVICE_SECRET',
      'SPECVOICE_SESSION_SECRET',
      'SPECVOICE_OPERATOR_PASSWORD_HASH',
      'ELEVENLABS_API_KEY',
    ]
    for (const name of inheritedSecrets) vi.stubEnv(name, `fixture-private-${name}`)
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://untrusted.example')
    vi.stubEnv('HTTP_PROXY', 'http://untrusted.example')
    const args = containerArgs()
    expect(values(args, '--env')).toEqual([
      'HOME=/work/home',
      'TMPDIR=/work/tmp',
      'NPM_CONFIG_CACHE=/work/npm-cache',
      'ANTHROPIC_BASE_URL=http://model-gateway:3201',
      `ANTHROPIC_AUTH_TOKEN=${token}`,
      'ANTHROPIC_MODEL=claude-sonnet-4-6',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192',
      'SPECVOICE_BUILD_BUDGET_USD=5',
      'SPECVOICE_EXECUTION_DEADLINE_MS=1800000',
      'HTTP_PROXY=http://egress-proxy:3128',
      'HTTPS_PROXY=http://egress-proxy:3128',
      'NO_PROXY=model-gateway,localhost,127.0.0.1',
      'NODE_USE_ENV_PROXY=1',
      'SPECVOICE_ALLOW_INSTALL_SCRIPTS=false',
    ])
    expect(args.join(' ')).not.toContain('fixture-private-')
    expect(args.join(' ')).not.toContain('untrusted.example')
  })

  it('applies explicit resource limits without adding swap or another writable mount', () => {
    vi.stubEnv('SPECVOICE_EXECUTION_MEMORY_BYTES', String(3 * 1024 ** 3))
    vi.stubEnv('SPECVOICE_EXECUTION_WORKSPACE_BYTES', String(512 * 1024 ** 2))
    vi.stubEnv('SPECVOICE_EXECUTION_PIDS', '64')
    vi.stubEnv('SPECVOICE_EXECUTION_CPUS', '1')
    vi.stubEnv('SPECVOICE_EXECUTION_DEADLINE_MS', '60000')
    vi.stubEnv('SPECVOICE_BUILD_BUDGET_USD', '2')
    const args = containerArgs(true)
    expect(values(args, '--memory')).toEqual([String(3 * 1024 ** 3)])
    expect(values(args, '--memory-swap')).toEqual(values(args, '--memory'))
    expect(values(args, '--pids-limit')).toEqual(['64'])
    expect(values(args, '--cpus')).toEqual(['1'])
    expect(values(args, '--tmpfs')).toEqual([
      `/work:rw,nosuid,nodev,size=${512 * 1024 ** 2},uid=10001,gid=10001,mode=0700`,
    ])
    expect(values(args, '--env')).toEqual(
      expect.arrayContaining([
        'SPECVOICE_EXECUTION_DEADLINE_MS=60000',
        'SPECVOICE_BUILD_BUDGET_USD=2',
        'SPECVOICE_ALLOW_INSTALL_SCRIPTS=true',
      ])
    )
  })

  it.each(limitNames)('rejects invalid %s instead of dropping its resource limit', name => {
    for (const value of ['', '0', '-1', '1.5', 'not-a-number', 'Infinity', '9007199254740992']) {
      vi.stubEnv(name, value)
      expect(() => containerArgs()).toThrow(`Invalid execution limit: ${name}`)
    }
  })

  it('rejects workspace memory exceeding the container limit', () => {
    vi.stubEnv('SPECVOICE_EXECUTION_MEMORY_BYTES', String(1024 ** 3))
    expect(() => containerArgs()).toThrow('Execution workspace cannot exceed memory limit')
  })

  it.each(['0', '-1', '1.5', 'NaN', '2147483648'])('rejects invalid total deadline %s', deadline => {
    vi.stubEnv('SPECVOICE_EXECUTION_DEADLINE_MS', deadline)
    expect(() => containerArgs()).toThrow('Invalid SPECVOICE_EXECUTION_DEADLINE_MS')
  })
})

describe('public provider ingress route boundary', () => {
  const allowed = [
    '/api/agent/post-call',
    '/api/tools/list-files',
    '/api/tools/read-file',
    '/api/tools/search-code',
    '/api/tools/save-decision',
    '/api/tools/flag-question',
    '/api/tools/generate-spec',
  ]

  it.each(allowed)('accepts only exact POST requests to %s', path => {
    expect(publicProviderRoute('POST', path)).toBe(true)
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE', 'post', undefined]) {
      expect(publicProviderRoute(method, path)).toBe(false)
    }
    for (const other of [`${path}?token=anything`, `${path}/`, `${path}/extra`, path.toUpperCase()]) {
      expect(publicProviderRoute('POST', other)).toBe(false)
    }
  })

  it.each([
    undefined,
    '',
    '/',
    '/health',
    '/api/operator',
    '/api/sessions',
    '/api/sessions/session-id',
    '/api/sessions/session-id/build',
    '/api/sessions/session-id/call',
    '/api/sessions/session-id/events',
    '/api/tools/unknown',
    '/api/tools/../operator',
    '/api/tools/%2e%2e/operator',
    '//api/agent/post-call',
    'http://web:3000/api/agent/post-call',
  ])('rejects dashboard, control, and alternate URL paths: %s', path => {
    expect(publicProviderRoute('POST', path)).toBe(false)
  })
})

describe('internal service authentication', () => {
  const secret = 'fixture-service-secret-'.padEnd(43, 'x')

  function request(authorization?: string) {
    const incoming = new IncomingMessage(new Socket())
    if (authorization !== undefined) incoming.headers.authorization = authorization
    return incoming
  }

  it('accepts an exact bearer secret and rejects absent, short, or changed credentials', () => {
    expect(serviceAuthorized(request(`Bearer ${secret}`), secret)).toBe(true)
    for (const header of [undefined, '', secret, `Basic ${secret}`, `bearer ${secret}`, `Bearer ${secret}x`]) {
      expect(serviceAuthorized(request(header), secret)).toBe(false)
    }
    expect(serviceAuthorized(request(`Bearer ${'z'.repeat(secret.length)}`), secret)).toBe(false)
    for (const invalid of [undefined, '', 'short']) {
      expect(serviceAuthorized(request(`Bearer ${invalid}`), invalid)).toBe(false)
    }
  })

  it('rejects equal-character-length Unicode tokens without throwing on unequal byte lengths', () => {
    const unicode = 'é'.repeat(secret.length)
    expect(unicode.length).toBe(secret.length)
    expect(Buffer.byteLength(unicode)).not.toBe(Buffer.byteLength(secret))
    expect(serviceAuthorized(request(`Bearer ${unicode}`), secret)).toBe(false)
    expect(serviceAuthorized(request(`Bearer ${secret}`), unicode)).toBe(false)
  })

  it('compares actual bytes even when different strings have matching encoded lengths', () => {
    const unicode = 'é'.repeat(32)
    expect(serviceAuthorized(request(`Bearer ${'x'.repeat(64)}`), unicode)).toBe(false)
    expect(serviceAuthorized(request(`Bearer ${unicode}`), unicode)).toBe(true)
  })
})
