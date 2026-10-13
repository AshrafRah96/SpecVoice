import assert from 'node:assert/strict'
import { execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Session } from '@/lib/session/types'
import { TEST_OPERATOR_HASH, TEST_OPERATOR_PASSPHRASE } from '../../tests/helpers/operator-fixture'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const postgresPassword = 'synthetic-compose-postgres-password'
const serviceSecret = 'synthetic-compose-service-secret-'.padEnd(43, 'x')
const sessionSecret = 'synthetic-compose-session-secret-'.padEnd(43, 'x')
const webhookSecret = 'synthetic-compose-webhook-secret-'.padEnd(43, 'x')
const redactions = new Set([
  postgresPassword,
  serviceSecret,
  sessionSecret,
  webhookSecret,
  TEST_OPERATOR_HASH,
  TEST_OPERATOR_HASH.replaceAll('$', () => '$$'),
  TEST_OPERATOR_PASSPHRASE,
])
function sanitized(text: string) {
  for (const secret of redactions) text = text.split(secret).join('[REDACTED]')
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[REDACTED_DATABASE_URL]')
}

async function reservePort() {
  const server = createServer()
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { port: address.port, server }
}

const workerProbe = String.raw`
const assert = require('node:assert/strict');
const net = require('node:net');
(async () => {
  for (const name of ['GITHUB_TOKEN','ANTHROPIC_API_KEY','ELEVENLABS_API_KEY']) assert.ok(!process.env[name]);
  const launcher = await fetch('http://execution-launcher:3202/health', {signal:AbortSignal.timeout(5000)});
  assert.equal(launcher.status, 200);
  assert.equal((await launcher.json()).ready, true);
  const gateway = await fetch('http://model-gateway:3201/health', {signal:AbortSignal.timeout(5000)});
  assert.equal(gateway.status, 200);
  await gateway.arrayBuffer();
  const allowed = await fetch('https://registry.npmjs.org/npm/latest', {signal:AbortSignal.timeout(15000)});
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).name, 'npm');
  const denied = await new Promise((accept,reject) => {
    const socket = net.connect(3128,'egress-proxy');
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('Proxy probe timed out')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (data.includes('\r\n')) { socket.destroy(); accept(data.split('\r\n')[0]); }
    });
  });
  assert.equal(denied, 'HTTP/1.1 403 Forbidden');
  console.log(JSON.stringify({launcher:true,gateway:true,allowedRegistry:true,forbiddenHost:true}));
})().catch(error => { console.error(error.message); process.exitCode=1 });
`

export async function main() {
  // Compose receives only Docker-client configuration, never inherited application credentials or .env settings.
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    COMPOSE_DISABLE_ENV_FILE: 'true',
    COMPOSE_ANSI: 'never',
    BUILDKIT_PROGRESS: 'plain',
  }
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'])
    if (process.env[name]) env[name] = process.env[name]
  const project = `sv-smoke-${randomUUID().slice(0, 12)}`
  const directory = await mkdtemp(join(tmpdir(), 'specvoice-compose-smoke-'))
  const envFile = join(directory, 'synthetic.env')
  const ports: Server[] = []
  const abort = new AbortController()
  let command: ChildProcess | undefined
  let configured = false
  let started = false
  let result: object | undefined
  const interrupt = () => {
    abort.abort(new Error('Compose smoke interrupted'))
    command?.kill('SIGTERM')
  }
  const docker = (args: string[], timeout = 30000, input?: string, cleanup = false): Promise<string> => {
    if (!cleanup) abort.signal.throwIfAborted()
    return new Promise((accept, reject) => {
      const child = execFile(
        'docker',
        args,
        { cwd: root, env, timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (command === child) command = undefined
          if (error)
            reject(
              new Error(
                sanitized(
                  `docker ${args[0]} failed: ${stderr.slice(-10000)}\n${stdout.slice(-10000)}\n${error.message.slice(0, 1000)}`
                )
              )
            )
          else accept(stdout.trim())
        }
      )
      command = child
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    })
  }
  const compose = (args: string[], timeout?: number, input?: string, cleanup = false) =>
    docker(
      [
        'compose',
        '--project-name',
        project,
        '--project-directory',
        root,
        '--env-file',
        envFile,
        '--file',
        join(root, 'docker-compose.yml'),
        ...args,
      ],
      timeout,
      input,
      cleanup
    )
  const closePorts = async () => {
    for (const server of ports)
      if (server.listening)
        await new Promise<void>((accept, reject) => server.close(error => (error ? reject(error) : accept())))
  }
  process.once('SIGTERM', interrupt)
  process.once('SIGINT', interrupt)
  try {
    await docker(['version', '--format', '{{.Server.Version}}'])
    const webPort = await reservePort()
    ports.push(webPort.server)
    const providerPort = await reservePort()
    ports.push(providerPort.server)
    const web = `http://127.0.0.1:${webPort.port}`
    const provider = `http://127.0.0.1:${providerPort.port}`
    const values = {
      COMPOSE_PROJECT_NAME: project,
      POSTGRES_USER: 'specvoice',
      POSTGRES_PASSWORD: postgresPassword,
      POSTGRES_DB: 'specvoice_compose_test',
      SPECVOICE_PORT: String(webPort.port),
      SPECVOICE_PROVIDER_PORT: String(providerPort.port),
      SPECVOICE_OPERATOR_PASSWORD_HASH: TEST_OPERATOR_HASH,
      SPECVOICE_OPERATOR_ORIGIN: web,
      SESSION_CAPABILITY_SECRET: sessionSecret,
      SPECVOICE_SERVICE_SECRET: serviceSecret,
      NEXT_PUBLIC_APP_URL: provider,
      ELEVENLABS_WEBHOOK_SECRET: webhookSecret,
      GITHUB_TOKEN: '',
      GITHUB_READ_TOKEN: '',
      ELEVENLABS_API_KEY: '',
      ELEVENLABS_AGENT_ID: '',
      ANTHROPIC_API_KEY: '',
    }
    await writeFile(
      envFile,
      Object.entries(values)
        .map(([key, value]) => `${key}='${value}'`)
        .join('\n') + '\n',
      { mode: 0o600 }
    )
    configured = true
    const config = JSON.parse(await compose(['config', '--format', 'json']))
    assert.equal(config.name, project)
    // Compose's printable configuration doubles dollars; the running service must receive the original hash.
    assert.equal(
      config.services.web.environment.SPECVOICE_OPERATOR_PASSWORD_HASH.replaceAll('$$', '$'),
      TEST_OPERATOR_HASH
    )
    assert.equal(config.services['model-gateway'].environment.ANTHROPIC_API_KEY, '')
    for (const service of ['web', 'worker']) assert.equal(config.services[service].environment.GITHUB_TOKEN, '')
    assert.equal(config.services.web.environment.ELEVENLABS_API_KEY, '')
    assert.equal(config.services.web.ports[0].host_ip, '127.0.0.1')
    assert.equal(config.services['provider-ingress'].ports[0].host_ip, '127.0.0.1')
    console.log('Compose smoke: building the real service images with synthetic configuration.')
    await compose(['build'], 15 * 60_000)
    await closePorts()
    console.log('Compose smoke: starting the full service graph and waiting for health checks.')
    started = true
    await compose(['up', '--detach', '--no-build', '--wait', '--wait-timeout', '180'], 210_000)
    const request = async (base: string, path: string, options: RequestInit = {}) => {
      try {
        return await fetch(`${base}${path}`, {
          ...options,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        })
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error)
        throw new Error(`HTTP ${options.method ?? 'GET'} ${base}${path} failed: ${cause}`)
      }
    }
    assert.equal((await request(web, '/api/sessions')).status, 401)
    const login = await request(web, '/api/operator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: web },
      body: JSON.stringify({ passphrase: TEST_OPERATOR_PASSPHRASE }),
    })
    assert.equal(login.status, 200)
    await login.arrayBuffer()
    const setCookie = login.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /SameSite=Strict/i)
    const cookie = setCookie.split(';')[0]
    assert.match(cookie, /^specvoice_operator=[A-Za-z0-9_-]{43}$/)
    redactions.add(cookie)
    redactions.add(cookie.split('=')[1])
    const session: Session = {
      id: 'synthetic-compose-session',
      repoUrl: 'https://github.com/example/synthetic',
      repositorySha: 'b'.repeat(40),
      decisions: [],
      openQuestions: [],
      filesRead: [],
      specOutput: '# Synthetic persistent Spec',
      status: 'complete',
      callDurationSecs: null,
      transcript: null,
      buildStatus: 'ready',
      buildAttemptKey: null,
      prUrl: null,
      complexityAssessment: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const sql = (query: string) =>
      compose(
        [
          'exec',
          '-T',
          'postgres',
          'psql',
          '-XAt',
          '--set',
          'ON_ERROR_STOP=1',
          '--username',
          'specvoice',
          '--dbname',
          'specvoice_compose_test',
        ],
        30000,
        query
      )
    await sql(`INSERT INTO sessions (id,data) VALUES ('${session.id}', $fixture$${JSON.stringify(session)}$fixture$::jsonb);
      INSERT INTO session_events (session_id,event) SELECT id,jsonb_build_object('type','session_updated','session',data) FROM sessions;`)
    const eventId = await sql(`SELECT id::text FROM session_events WHERE session_id='${session.id}'`)
    assert.match(eventId, /^\d+$/)
    const readSession = async () => {
      const response = await request(web, `/api/sessions/${session.id}`, { headers: { Cookie: cookie } })
      assert.equal(response.status, 200)
      assert.deepEqual((await response.json()).session, session)
    }
    await readSession()
    const heartbeat = await sql("SELECT max(heartbeat_at)::text FROM worker_heartbeats WHERE state='running'")
    assert.ok(heartbeat)
    console.log('Compose smoke: restarting web and worker; checking durable state and SSE replay.')
    await compose(['restart', '--no-deps', '--timeout', '60', 'web', 'worker'], 150_000)
    await compose(['up', '--detach', '--no-build', '--wait', '--wait-timeout', '120'], 150_000)
    await readSession()
    console.log('Compose smoke: Session and operator cookie survived restart; checking replay.')
    assert.equal(await sql(`SELECT id::text FROM session_events WHERE session_id='${session.id}'`), eventId)
    assert.equal(
      await sql(
        `SELECT count(*) FROM worker_heartbeats WHERE state='running' AND heartbeat_at > '${heartbeat}'::timestamptz AND heartbeat_at > clock_timestamp()-interval '15 seconds'`
      ),
      '1'
    )
    const health = await request(web, '/api/health')
    assert.equal(health.status, 200)
    assert.equal((await health.json()).ready, true)
    const events = await request(web, `/api/sessions/${session.id}/events`, {
      headers: { Cookie: cookie, 'Last-Event-ID': '0' },
    })
    assert.equal(events.status, 200)
    assert.ok(events.body)
    const reader = events.body.getReader()
    let replay = ''
    try {
      const decoder = new TextDecoder()
      while (!replay.includes('\n\n')) {
        const chunk = await reader.read()
        assert.equal(chunk.done, false, 'SSE closed before replaying the persisted event')
        replay += decoder.decode(chunk.value, { stream: true })
        assert.ok(replay.length < 1024 * 1024)
      }
      assert.equal(replay.split('\n')[0], `id: ${eventId}`)
      const data = replay.split('\n').find(line => line.startsWith('data: '))
      assert.ok(data)
      assert.deepEqual(JSON.parse(data.slice(6)), { type: 'session_updated', session })
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    console.log('Compose smoke: durable SSE replay passed; checking public ingress restrictions.')
    for (const [method, path] of [
      ['GET', '/'],
      ['GET', '/api/sessions'],
      ['POST', '/api/operator'],
      ['GET', `/api/sessions/${session.id}/events`],
    ])
      assert.equal((await request(provider, path, { method, headers: { Cookie: cookie } })).status, 404)
    assert.equal(
      (
        await request(provider, '/api/agent/post-call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401
    )
    assert.equal(await sql('SELECT count(*) FROM webhook_receipts'), '0')
    console.log('Compose smoke: checking launcher readiness and real allowlisted worker egress.')
    const probe = JSON.parse(await compose(['exec', '-T', 'worker', 'node', '-e', workerProbe], 40000))
    assert.deepEqual(probe, { launcher: true, gateway: true, allowedRegistry: true, forbiddenHost: true })
    assert.equal(
      (await request(web, '/api/operator', { method: 'DELETE', headers: { Origin: web, Cookie: cookie } })).status,
      200
    )
    assert.equal((await request(web, '/api/sessions', { headers: { Cookie: cookie } })).status, 401)
    result = {
      compose: 'passed',
      durableSession: true,
      durableOperatorSession: true,
      eventReplay: true,
      providerIngressRestricted: true,
      unsignedCallbackRejected: true,
      workerHeartbeat: true,
      ...probe,
      paidProviderCalls: 0,
    }
  } catch (error) {
    if (started) {
      const state = await compose(['ps', '--all', '--format', 'json'], 20000, undefined, true).catch(
        () => 'Service state unavailable.'
      )
      console.error(sanitized(state))
      const ingress = await compose(['ps', '-q', 'provider-ingress'], 20000, undefined, true).catch(() => '')
      if (ingress) {
        const ports = await docker(
          ['inspect', '--format', '{{json .HostConfig.PortBindings}} {{json .NetworkSettings.Ports}}', ingress],
          20000,
          undefined,
          true
        ).catch(() => 'Ingress port inspection unavailable.')
        console.error(sanitized(`Provider ingress publication: ${ports}`))
        const listener = await compose(
          [
            'exec',
            '-T',
            'provider-ingress',
            'node',
            '-e',
            "fetch('http://127.0.0.1:3001/',{signal:AbortSignal.timeout(2000)}).then(r=>console.log('Local ingress status: '+r.status)).catch(e=>{console.error(e.message);process.exitCode=1})",
          ],
          5000,
          undefined,
          true
        ).catch(error => (error instanceof Error ? error.message : 'Ingress probe failed.'))
        console.error(sanitized(listener))
      }
      const logs = await compose(['logs', '--no-color', '--tail', '80'], 20000, undefined, true).catch(
        () => 'Service logs unavailable.'
      )
      console.error(sanitized(logs))
    }
    throw error
  } finally {
    try {
      await closePorts()
      if (configured) {
        await compose(['down', '--volumes', '--remove-orphans', '--timeout', '60'], 180_000, undefined, true)
        assert.equal(
          await docker(
            ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
            30000,
            undefined,
            true
          ),
          ''
        )
        assert.equal(
          await docker(
            ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
            30000,
            undefined,
            true
          ),
          ''
        )
        assert.equal(
          await docker(
            ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
            30000,
            undefined,
            true
          ),
          ''
        )
      }
      await rm(directory, { recursive: true, force: true })
    } finally {
      process.removeListener('SIGTERM', interrupt)
      process.removeListener('SIGINT', interrupt)
    }
  }
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(error => {
    console.error(sanitized(error instanceof Error ? error.message : 'Compose verification failed'))
    process.exitCode = 1
  })
