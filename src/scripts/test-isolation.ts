import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { executionContainerArgs } from '@/execution-launcher'
import { ISOLATION_FIXTURE_TOKEN } from './isolation-model-fixture'

const IMAGE = 'specvoice-execution:2.1.296'
const MAX_OUTPUT = 64 * 1024 * 1024

function docker(args: string[], input?: string, timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      args,
      { timeout, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `docker ${args[0]} failed: ${stderr.trim().slice(0, 2000) || error.message.slice(0, 2000)}${stdout ? `\n${stdout.slice(-4000)}` : ''}`
            )
          )
        else resolve(stdout.trim())
      }
    )
    child.stdin?.on('error', () => {
      /* Early container failures are reported by execFile. */
    })
    child.stdin?.end(input)
  })
}

interface ContainerInspection {
  Config: { Image: string; User: string; Env: string[] }
  HostConfig: {
    ReadonlyRootfs: boolean
    Privileged: boolean
    CapDrop: string[]
    SecurityOpt: string[]
    NanoCpus: number
    Memory: number
    MemorySwap: number
    PidsLimit: number
    Tmpfs: Record<string, string>
    Binds: string[] | null
    NetworkMode: string
    Dns: string[]
    PidMode: string
  }
  Mounts: Array<{ Type: string; Destination: string }>
}

function assertContainer(inspection: ContainerInspection, image: string, network: string, workspace = 2 * 1024 ** 3) {
  const config = inspection.HostConfig
  assert.equal(inspection.Config.Image, image)
  assert.equal(inspection.Config.User, '10001:10001')
  assert.equal(config.ReadonlyRootfs, true)
  assert.equal(config.Privileged, false)
  assert.ok(config.CapDrop.includes('ALL'))
  assert.ok(config.SecurityOpt.includes('no-new-privileges'))
  assert.equal(config.NanoCpus, 2_000_000_000)
  assert.equal(config.Memory, 4 * 1024 ** 3)
  assert.equal(config.MemorySwap, config.Memory)
  assert.equal(config.PidsLimit, 256)
  assert.equal(config.NetworkMode, network)
  assert.equal(config.PidMode, '')
  assert.deepEqual(config.Dns, ['127.0.0.1'])
  assert.ok(!config.Binds?.length)
  assert.deepEqual(Object.keys(config.Tmpfs), ['/work'])
  for (const option of [`size=${workspace}`, 'nosuid', 'nodev', 'uid=10001', 'gid=10001', 'mode=0700'])
    assert.ok(config.Tmpfs['/work'].split(',').includes(option), `Missing workspace option ${option}`)
  assert.ok(inspection.Mounts.every(mount => mount.Type === 'tmpfs' && mount.Destination === '/work'))
  for (const entry of inspection.Config.Env) {
    const key = entry.split('=')[0]
    assert.ok(
      !/^(DATABASE_URL|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|ELEVENLABS_.*|SESSION_CAPABILITY_SECRET|SPECVOICE_SERVICE_SECRET|DOCKER_HOST)$/.test(
        key
      ),
      `Execution has forbidden environment ${key}`
    )
  }
  assert.ok(inspection.Config.Env.includes(`ANTHROPIC_AUTH_TOKEN=${ISOLATION_FIXTURE_TOKEN}`))
}

const isolationProbe = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns').promises;
const {execFileSync} = require('node:child_process');
(async () => {
  assert.equal(process.getuid(), 10001);
  for (const directory of ['/work/home', '/work/tmp', '/work/npm-cache']) fs.mkdirSync(directory, {recursive:true});
  for (const socket of ['/var/run/docker.sock','/run/docker.sock']) assert.equal(fs.existsSync(socket), false);
  for (const key of ['DATABASE_URL','GITHUB_TOKEN','GH_TOKEN','ANTHROPIC_API_KEY','SPECVOICE_SERVICE_SECRET']) assert.equal(process.env[key], undefined);
  assert.throws(() => fs.writeFileSync('/tmp/specvoice-readonly-probe', 'denied'), error => error.code === 'EROFS');
  const deny = (host,port) => new Promise((resolve,reject) => {
    const socket = net.connect({host,port});
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); reject(new Error('Unexpected connection to '+host)); });
    socket.once('error', () => { socket.destroy(); resolve(); });
    socket.once('timeout', () => { socket.destroy(); resolve(); });
  });
  await deny('1.1.1.1',443);
  await deny('postgres',5432);
  const resolver = new dns.Resolver({timeout:1000,tries:1});
  await assert.rejects(resolver.resolve4('example.com'));
  const reachable = await fetch('http://model-gateway:3201/attempt-status', {headers:{Authorization:'Bearer '+process.env.ANTHROPIC_AUTH_TOKEN},signal:AbortSignal.timeout(3000)});
  assert.equal(reachable.status,200);
  const version = execFileSync('claude',['--version'],{encoding:'utf8',timeout:15000});
  assert.match(version,/^2\.1\.296\b/);
  const help = execFileSync('claude',['--help'],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
  for (const flag of ['--bare','--setting-sources','--strict-mcp-config','--mcp-config','--tools','--allowedTools','--max-budget-usd']) assert.ok(help.includes(flag),'Missing CLI flag '+flag);
  console.log(JSON.stringify({isolation:true,cliVersion:version.trim()}));
})().catch(error => {console.error(error.message);process.exitCode=1});
`

const quotaProbe = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.throws(() => fs.writeFileSync('/work/exceeds-workspace', Buffer.alloc(9*1024*1024)), error => error.code === 'ENOSPC');
console.log(JSON.stringify({workspaceLimit:true}));
`

export async function main() {
  try {
    await docker(['version', '--format', '{{.Server.Version}}'])
  } catch {
    throw new Error('Docker daemon is required for real isolation verification; no checks were simulated')
  }
  const image = await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE])
  assert.match(image, /^sha256:[a-f0-9]{64}$/)
  const network = `specvoice-isolation-${randomUUID()}`
  const containers: string[] = []
  let networkCreated = false
  let interrupted = false
  const interrupt = () => {
    interrupted = true
    void cleanup()
  }
  const cleanup = async () => {
    for (const container of [...containers].reverse()) await docker(['rm', '--force', container]).catch(() => {})
    if (networkCreated) await docker(['network', 'rm', network]).catch(() => {})
  }
  process.once('SIGTERM', interrupt)
  process.once('SIGINT', interrupt)
  const create = async (name: string, args: string[]) => {
    if (interrupted) throw new Error('Isolation verification interrupted')
    containers.push(name)
    await docker(args)
  }
  const inspect = async (name: string, workspace?: number) => {
    const [value] = JSON.parse(await docker(['inspect', name])) as ContainerInspection[]
    assertContainer(value, image, network, workspace)
  }
  try {
    await docker([
      'network',
      'create',
      '--internal',
      '--opt',
      'com.docker.network.bridge.gateway_mode_ipv4=isolated',
      network,
    ])
    networkCreated = true
    assert.equal(await docker(['network', 'inspect', '--format', '{{.Internal}}', network]), 'true')
    assert.equal(
      await docker([
        'network',
        'inspect',
        '--format',
        '{{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}',
        network,
      ]),
      'isolated'
    )
    const gateway = `${network}-model`
    await create(gateway, [
      'create',
      '--name',
      gateway,
      '--network',
      network,
      '--network-alias',
      'model-gateway',
      '--read-only',
      '--user',
      '10001:10001',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--init',
      '--pids-limit',
      '64',
      '--memory',
      String(512 * 1024 * 1024),
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=16777216,uid=10001,gid=10001,mode=0700',
      '--env',
      'SPECVOICE_ISOLATION_FIXTURE=true',
      image,
      'node',
      '--import',
      'tsx',
      'src/scripts/isolation-model-fixture.ts',
    ])
    await docker(['start', gateway])
    const status = async () =>
      JSON.parse(
        await docker([
          'exec',
          gateway,
          'node',
          '-e',
          `fetch('http://127.0.0.1:3201/attempt-status',{headers:{Authorization:'Bearer ${ISOLATION_FIXTURE_TOKEN}'},signal:AbortSignal.timeout(2000)}).then(async r=>{if(!r.ok)throw Error('Fixture status failed');console.log(await r.text())}).catch(()=>process.exit(1))`,
        ])
      ) as {
        requests: number
        completed: boolean
        policyFailures: unknown[]
        toolFailures: string[]
        unexpectedRequests: string[]
      }
    let ready = false
    for (let attempt = 0; attempt < 20 && !interrupted; attempt++) {
      try {
        await status()
        ready = true
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    assert.ok(ready, 'Synthetic model fixture did not become ready')

    const probe = `${network}-probe`
    await create(probe, [
      ...executionContainerArgs(probe, image, network, ISOLATION_FIXTURE_TOKEN, false),
      'node',
      '-e',
      isolationProbe,
    ])
    await inspect(probe)
    const probeResult = JSON.parse(await docker(['start', '-ai', probe], undefined, 60_000))
    assert.equal(probeResult.isolation, true)

    const quota = `${network}-quota`
    const quotaArgs = executionContainerArgs(quota, image, network, ISOLATION_FIXTURE_TOKEN, false)
    const tmpfs = quotaArgs.indexOf('--tmpfs') + 1
    quotaArgs[tmpfs] = quotaArgs[tmpfs].replace(/size=\d+/, `size=${8 * 1024 * 1024}`)
    await create(quota, [...quotaArgs, 'node', '-e', quotaProbe])
    await inspect(quota, 8 * 1024 * 1024)
    assert.equal(JSON.parse(await docker(['start', '-ai', quota])).workspaceLimit, true)

    const attempt = `${network}-attempt`
    await create(attempt, executionContainerArgs(attempt, image, network, ISOLATION_FIXTURE_TOKEN, false))
    await inspect(attempt)
    const file = (path: string, content: string) => ({
      path,
      content: Buffer.from(content).toString('base64'),
      mode: '100644',
    })
    const input = {
      branchName: 'spec-voice/isolation-test',
      spec: 'Change index.js to export the number 42, then commit.',
      context: 'Entirely synthetic isolation verification.',
      files: [
        file('index.js', 'module.exports = 0\n'),
        file(
          'package.json',
          JSON.stringify({
            name: 'isolation-fixture',
            version: '1.0.0',
            scripts: { test: "node -e \"require('node:assert/strict').equal(require('./index.js'),42)\"" },
          })
        ),
        file(
          'package-lock.json',
          JSON.stringify({
            name: 'isolation-fixture',
            version: '1.0.0',
            lockfileVersion: 3,
            packages: { '': { name: 'isolation-fixture', version: '1.0.0' } },
          })
        ),
      ],
    }
    let output: string
    try {
      output = await docker(['start', '-ai', attempt], JSON.stringify(input), 180_000)
    } catch (error) {
      const evidence = await status()
      throw new Error(
        `${error instanceof Error ? error.message : 'Execution failed'}\nFixture diagnostics: ${JSON.stringify(evidence).slice(0, 8000)}`
      )
    }
    const events = output
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
    const results = events.filter(event => event.type === 'result')
    assert.equal(results.length, 1, `Expected one result: ${output.slice(-4000)}`)
    assert.equal(
      events.some(event => event.type === 'error'),
      false
    )
    assert.match(results[0].patch, /\+module\.exports = 42/)
    assert.deepEqual(results[0].verification, { command: 'npm test --ignore-scripts', exitCode: 0 })
    const evidence = await status()
    assert.ok(evidence.requests > 0, 'Actual Claude CLI sent no model requests')
    assert.equal(evidence.completed, true)
    assert.deepEqual(evidence.policyFailures, [])
    assert.deepEqual(evidence.toolFailures, [])
    assert.deepEqual(evidence.unexpectedRequests, [])
    console.log(
      JSON.stringify({
        isolation: 'passed',
        image,
        cliVersion: probeResult.cliVersion,
        modelRequests: evidence.requests,
        patchVerified: true,
        workspaceLimit: true,
        paidProviderCalls: 0,
      })
    )
  } finally {
    await cleanup()
    process.removeListener('SIGTERM', interrupt)
    process.removeListener('SIGINT', interrupt)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Isolation verification failed')
    process.exitCode = 1
  })
