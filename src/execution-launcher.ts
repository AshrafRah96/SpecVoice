import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { readServiceJson, serviceAuthorized, serviceJson } from '@/lib/security/service-http'
import { executionDeadlineMs } from '@/execution/limits'

const exec = promisify(execFile)
const inputSchema = z
  .object({
    attemptId: z.string().regex(/^[1-9]\d*$/),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    repoUrl: z.string().url(),
    files: z
      .array(z.object({ path: z.string(), content: z.string(), mode: z.enum(['100644', '100755']) }).strict())
      .max(100000),
    spec: z.string().max(1024 * 1024),
    context: z.string().max(4 * 1024 * 1024),
    branchName: z.string().max(240),
  })
  .strict()

function positive(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid execution limit: ${name}`)
  return value
}

export function executionContainerArgs(
  name: string,
  image: string,
  network: string,
  token: string,
  allowScripts: boolean
) {
  const memory = positive('SPECVOICE_EXECUTION_MEMORY_BYTES', 4 * 1024 ** 3)
  const workspace = positive('SPECVOICE_EXECUTION_WORKSPACE_BYTES', 2 * 1024 ** 3)
  if (workspace > memory) throw new Error('Execution workspace cannot exceed memory limit')
  return [
    'create',
    '-i',
    '--name',
    name,
    '--label',
    `io.specvoice.launcher=${network}`,
    '--read-only',
    '--user',
    '10001:10001',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--init',
    '--log-driver=none',
    '--pids-limit',
    String(positive('SPECVOICE_EXECUTION_PIDS', 256)),
    '--cpus',
    String(positive('SPECVOICE_EXECUTION_CPUS', 2)),
    '--memory',
    String(memory),
    '--memory-swap',
    String(memory),
    '--ulimit',
    'nofile=1024:1024',
    '--ulimit',
    'core=0',
    '--network',
    network,
    '--dns',
    '127.0.0.1',
    '--tmpfs',
    `/work:rw,nosuid,nodev,size=${workspace},uid=10001,gid=10001,mode=0700`,
    '--env',
    'HOME=/work/home',
    '--env',
    'TMPDIR=/work/tmp',
    '--env',
    'NPM_CONFIG_CACHE=/work/npm-cache',
    '--env',
    'ANTHROPIC_BASE_URL=http://model-gateway:3201',
    '--env',
    `ANTHROPIC_AUTH_TOKEN=${token}`,
    '--env',
    'ANTHROPIC_MODEL=claude-sonnet-4-6',
    '--env',
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192',
    '--env',
    `SPECVOICE_BUILD_BUDGET_USD=${process.env.SPECVOICE_BUILD_BUDGET_USD ?? '5'}`,
    '--env',
    `SPECVOICE_EXECUTION_DEADLINE_MS=${executionDeadlineMs()}`,
    '--env',
    'HTTP_PROXY=http://egress-proxy:3128',
    '--env',
    'HTTPS_PROXY=http://egress-proxy:3128',
    '--env',
    'NO_PROXY=model-gateway,localhost,127.0.0.1',
    '--env',
    'NODE_USE_ENV_PROXY=1',
    '--env',
    `SPECVOICE_ALLOW_INSTALL_SCRIPTS=${allowScripts}`,
    image,
  ]
}

const docker = async (args: string[], timeout = 15000) =>
  (await exec('docker', args, { timeout, maxBuffer: 1024 * 1024 })).stdout.trim()
async function removeContainer(name: string) {
  await docker(['stop', '--time', '5', name]).catch(() => {})
  await docker(['rm', '--force', name])
}

export async function createExecutionLauncher() {
  const network = process.env.SPECVOICE_EXECUTION_NETWORK ?? 'specvoice-execution'
  const configuration = JSON.parse(await docker(['network', 'inspect', '--format', '{{json .}}', network]))
  if (
    configuration.Internal !== true ||
    configuration.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated' ||
    (configuration.EnableIPv6 && configuration.Options?.['com.docker.network.bridge.gateway_mode_ipv6'] !== 'isolated')
  )
    throw new Error('Execution requires an internal Docker network with isolated gateway modes')
  const image = await docker([
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    process.env.SPECVOICE_EXECUTION_IMAGE ?? 'specvoice-execution:2.1.296',
  ])
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Execution image identity is invalid')
  const old = await docker(['ps', '-aq', '--filter', `label=io.specvoice.launcher=${network}`])
  for (const id of old.split('\n').filter(Boolean)) await removeContainer(id)
  let cleanupFailed = false
  let active: { name: string; response: ServerResponse; cancel: (reason: string) => Promise<void> } | undefined
  const server = createServer((request, response) => {
    let executionError: string | undefined
    const handle = async () => {
      if (request.url === '/health' && request.method === 'GET')
        return serviceJson(response, cleanupFailed ? 503 : 200, { ready: !cleanupFailed })
      if (!serviceAuthorized(request, process.env.SPECVOICE_SERVICE_SECRET))
        return serviceJson(response, 401, { error: 'Control authentication required' })
      if (request.method === 'DELETE' && /^\/attempts\/[1-9]\d*$/.test(request.url ?? '')) {
        const id = request.url!.split('/').at(-1)!
        if (active?.name.startsWith(`specvoice-attempt-${id}-`)) await active.cancel('Execution cancelled')
        return serviceJson(response, 200, { stopped: true })
      }
      if (request.url !== '/attempts' || request.method !== 'POST')
        return serviceJson(response, 404, { error: 'Unsupported execution operation' })
      if (active || cleanupFailed)
        return serviceJson(response, 409, { error: 'Execution is busy or cleanup requires repair' })
      let stopping: Promise<void> | undefined
      let creation: Promise<string> | undefined
      let cancellation: Error | undefined
      let created = false
      let containerName = ''
      const stop = () =>
        (stopping ??= (async () => {
          if (!creation) return
          // A concurrent create must settle before removal can confirm the container is gone.
          await creation.catch(() => {})
          await removeContainer(containerName)
        })())
      const cancel = (reason: string) => {
        cancellation ??= new Error(reason)
        return stop()
      }
      // Reserve the slot before reading a potentially large request.
      active = { name: '', response, cancel }
      const abort = () => {
        void cancel('Execution connection closed').catch(() => {})
      }
      response.once('close', abort)
      let deadline: ReturnType<typeof setTimeout> | undefined
      let leaseTimer: ReturnType<typeof setInterval> | undefined
      try {
        const input = inputSchema.parse(await readServiceJson(request, 100 * 1024 * 1024))
        containerName = `specvoice-attempt-${input.attemptId}-${input.token.slice(0, 10).toLowerCase()}`
        active.name = containerName
        const valid = async () => {
          const result = await fetch('http://model-gateway:3201/attempt-status', {
            headers: { Authorization: `Bearer ${input.token}` },
            signal: AbortSignal.timeout(5000),
          })
          return result.ok
        }
        if (!(await valid()) || response.destroyed) throw new Error('Attempt lease is no longer active')
        if (cancellation) throw cancellation
        const allowScripts = (process.env.SPECVOICE_INSTALL_SCRIPT_REPOS ?? '').split(',').includes(input.repoUrl)
        created = true
        creation = docker(executionContainerArgs(containerName, image, network, input.token, allowScripts))
        await creation
        if (response.destroyed) await cancel('Execution connection closed')
        if (cancellation) throw cancellation
        deadline = setTimeout(() => {
          void cancel('Execution deadline exceeded').catch(() => {})
        }, executionDeadlineMs())
        let checking = false
        leaseTimer = setInterval(() => {
          if (checking) return
          checking = true
          void valid()
            .then(ok => {
              if (!ok) return cancel('Attempt lease is no longer active')
            })
            .catch(() => cancel('Attempt lease could not be verified'))
            .catch(() => {
              cleanupFailed = true
            })
            .finally(() => {
              checking = false
            })
        }, 5000)
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' })
        const child = spawn('docker', ['start', '-ai', containerName], { stdio: ['pipe', 'pipe', 'pipe'] })
        let pending = ''
        let result: { patch: string; verification: unknown } | undefined
        let failure = false
        let bytes = 0
        const closed = new Promise<number | null>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', resolve)
        })
        child.stderr.on('data', () => {
          /* Untrusted logs never enter control-service logs. */
        })
        child.stdin.on('error', () => {
          failure = true
        })
        child.stdin.end(
          JSON.stringify({ files: input.files, spec: input.spec, context: input.context, branchName: input.branchName })
        )
        child.stdout.setEncoding('utf8')
        try {
          for await (const chunk of child.stdout) {
            bytes += Buffer.byteLength(chunk)
            if (bytes > 64 * 1024 * 1024) throw new Error('Execution output exceeded limit')
            pending += chunk
            let newline: number
            while ((newline = pending.indexOf('\n')) !== -1) {
              const line = pending.slice(0, newline)
              pending = pending.slice(newline + 1)
              const event = JSON.parse(line)
              if (event.type === 'result') {
                if (result || typeof event.patch !== 'string') throw new Error('Invalid execution result')
                result = { patch: event.patch, verification: event.verification }
              } else if (
                event.type === 'progress' &&
                ['analyzing', 'writing', 'reviewing'].includes(event.phase) &&
                typeof event.detail === 'string'
              ) {
                await new Promise<void>((resolve, reject) =>
                  response.write(
                    JSON.stringify({ type: 'progress', phase: event.phase, detail: event.detail.slice(0, 1000) }) +
                      '\n',
                    error => (error ? reject(error) : resolve())
                  )
                )
              } else if (event.type === 'error') {
                failure = true
                if (typeof event.error === 'string')
                  executionError = event.error.split(input.token).join('[REDACTED]').slice(0, 1024)
              }
            }
          }
          if ((await closed) !== 0 || cancellation || failure || !result || pending.trim())
            throw new Error('Isolated execution failed; inspect repository toolchain and build limits')
          await stop()
          if (cancellation) throw cancellation
          response.end(JSON.stringify({ type: 'result', ...result }) + '\n')
        } catch (error) {
          try {
            await stop()
          } finally {
            child.kill('SIGKILL')
            await closed.catch(() => {})
          }
          throw error
        }
      } finally {
        clearTimeout(deadline)
        clearInterval(leaseTimer)
        response.off('close', abort)
        if (created) {
          try {
            await stop()
          } catch {
            cleanupFailed = true
          }
        }
        active = undefined
      }
    }
    void handle().catch(() => {
      if (response.headersSent && !response.destroyed)
        response.end(
          JSON.stringify({
            type: 'error',
            error: executionError ?? 'Isolated execution failed. Start a new Build explicitly.',
          }) + '\n'
        )
      else serviceJson(response, 400, { error: 'Execution request was rejected or the isolated attempt failed' })
    })
  })
  server.headersTimeout = 10000
  server.requestTimeout = executionDeadlineMs() + 10000
  server.maxConnections = 8
  const shutdown = async () => {
    await active?.cancel('Execution launcher stopping')
    server.closeAllConnections()
    server.close()
  }
  return { server, shutdown }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void createExecutionLauncher()
    .then(({ server, shutdown }) => {
      server.listen(3202, '0.0.0.0')
      process.once('SIGTERM', () => {
        void shutdown()
      })
      process.once('SIGINT', () => {
        void shutdown()
      })
    })
    .catch(() => {
      console.error('[launcher] Docker image or internal network unavailable')
      process.exitCode = 1
    })
}
