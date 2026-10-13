import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { runGit } from '@/lib/build/clone'
import { ClaudeProcessRunner, type RunOpts } from '@/lib/build/process-runner'
import { repositoryPath } from '@/lib/code/scope'
import { executionDeadlineMs } from './limits'

const MAX_FILES_BYTES = 64 * 1024 * 1024
const MAX_INPUT_BYTES = 100 * 1024 * 1024
const inputSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().max(4096),
            content: z.string(),
            mode: z.enum(['100644', '100755']),
          })
          .strict()
      )
      .max(100_000),
    spec: z.string(),
    context: z.string(),
    branchName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/),
  })
  .strict()

export type ContainerAttemptInput = z.infer<typeof inputSchema>

function validateInput(input: unknown) {
  const result = inputSchema.safeParse(input)
  if (!result.success) throw new Error('Invalid container execution input')
  const parsed = result.data
  if (Buffer.byteLength(parsed.spec) + Buffer.byteLength(parsed.context) > MAX_FILES_BYTES)
    throw new Error('Build instructions exceed 64 MiB')
  const paths = new Set<string>()
  let total = 0
  const files = parsed.files.map(file => {
    repositoryPath(file.path)
    const parts = file.path.split('/')
    if (parts.some(part => part.toLowerCase() === '.git') || /^(spec|context)\.md$/i.test(parts[0]))
      throw new Error('Repository input collides with protected execution files')
    if (paths.has(file.path)) throw new Error('Duplicate repository input path')
    paths.add(file.path)
    const bytes = Buffer.byteLength(file.content, 'base64')
    total += bytes
    if (total > MAX_FILES_BYTES) throw new Error('Repository input exceeds 64 MiB')
    const content = Buffer.from(file.content, 'base64')
    if (content.toString('base64') !== file.content) throw new Error('Repository content must be canonical base64')
    return { ...file, content }
  })
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++)
      if (paths.has(parts.slice(0, i).join('/'))) throw new Error('Repository input has a file/directory collision')
  }
  const packageFile = files.find(file => file.path === 'package.json')
  if (!packageFile || !paths.has('package-lock.json'))
    throw new Error('Unsupported repository: root package.json and package-lock.json are required')
  let packageJson: unknown
  try {
    packageJson = JSON.parse(packageFile.content.toString('utf8'))
  } catch {
    throw new Error('Unsupported repository: package.json is not valid JSON')
  }
  const nodePackage = z.object({ scripts: z.object({ test: z.string().trim().min(1) }) }).safeParse(packageJson)
  if (!nodePackage.success) throw new Error('Unsupported repository: package.json must define a nonempty scripts.test')
  return { ...parsed, files }
}

/** npm scripts are untrusted; this function must only run in the disposable execution container. */
async function runNpm(dir: string, args: string[], signal: AbortSignal, timeoutMs: number) {
  signal.throwIfAborted()
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL/i.test(key)) delete env[key]
  env.NPM_CONFIG_IGNORE_SCRIPTS = args.includes('--ignore-scripts=false') ? 'false' : 'true'
  env.npm_config_ignore_scripts = env.NPM_CONFIG_IGNORE_SCRIPTS
  return new Promise<void>((accept, reject) => {
    const child = spawn('npm', args, { cwd: dir, env, stdio: 'ignore', detached: process.platform !== 'win32' })
    let failure: Error | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        /* Process group already stopped. */
      }
    }
    const stop = (error: Error) => {
      if (failure) return
      failure = error
      kill('SIGTERM')
      escalation = setTimeout(() => kill('SIGKILL'), 5000)
    }
    const abort = () => stop(new Error('Package execution cancelled'))
    const timeout = setTimeout(() => stop(new Error(`npm ${args[0]} timed out`)), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.once('error', () => stop(new Error(`Could not start npm ${args[0]}`)))
    child.once('close', code => {
      kill('SIGKILL')
      clearTimeout(timeout)
      clearTimeout(escalation)
      signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`npm ${args[0]} failed with exit code ${code}`))
      else accept()
    })
  })
}

export async function executeContainerAttempt(
  input: unknown,
  options: { signal?: AbortSignal; onProgress?: RunOpts['onProgress'] } = {}
): Promise<{ patch: string; verification: { command: 'npm test --ignore-scripts'; exitCode: 0 } }> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(executionDeadlineMs()),
    ...(options.signal ? [options.signal] : []),
  ])
  signal.throwIfAborted()
  const parsed = validateInput(input)
  const root = resolve(process.env.SPECVOICE_EXECUTION_ROOT ?? '/work')
  const dir = join(root, 'repo')
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'SpecVoice',
    GIT_AUTHOR_EMAIL: 'specvoice@noreply.github.com',
    GIT_COMMITTER_NAME: 'SpecVoice',
    GIT_COMMITTER_EMAIL: 'specvoice@noreply.github.com',
  }
  await runGit(['check-ref-format', '--branch', parsed.branchName], gitEnv, signal)
  await mkdir(root, { recursive: true })
  // An existing checkout (including a symlink) is never reused across attempts.
  await mkdir(dir)
  const git = (...args: string[]) =>
    runGit(['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], gitEnv, signal)
  await git('init', '--initial-branch=main')
  await git('config', 'user.name', 'SpecVoice')
  await git('config', 'user.email', 'specvoice@noreply.github.com')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.autocrlf', 'false')
  await writeFile(join(dir, '.git', 'info', 'exclude'), 'node_modules/\n/SPEC.md\n/CONTEXT.md\n')
  for (const file of parsed.files) {
    signal.throwIfAborted()
    const destination = join(dir, file.path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, file.content, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 })
  }
  await git('add', '--force', '--all', '--', '.')
  await git('commit', '-m', 'Repository snapshot')
  const baseline = (await git('rev-parse', 'HEAD')).trim()
  await writeFile(join(dir, 'SPEC.md'), parsed.spec, { flag: 'wx', mode: 0o600 })
  await writeFile(join(dir, 'CONTEXT.md'), parsed.context, { flag: 'wx', mode: 0o600 })
  await runNpm(
    dir,
    [
      'ci',
      process.env.SPECVOICE_ALLOW_INSTALL_SCRIPTS === 'true' ? '--ignore-scripts=false' : '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    signal,
    10 * 60 * 1000
  )
  await new ClaudeProcessRunner().run({
    dir,
    branchName: parsed.branchName,
    commitMessage: 'implement approved Spec',
    onProgress: options.onProgress ?? (() => {}),
    signal,
  })
  await runNpm(dir, ['test', '--ignore-scripts'], signal, 5 * 60 * 1000)
  if ((await git('status', '--porcelain', '--untracked-files=all')).trim())
    throw new Error('Generated repository has uncommitted changes after verification')
  const head = (await git('rev-parse', 'HEAD')).trim()
  if (head === baseline) throw new Error('Claude did not create a generated commit')
  const patch = await git('diff', '--binary', '--no-ext-diff', '--no-textconv', baseline, head, '--')
  if (!patch) throw new Error('Generated commit contains no changes')
  return { patch, verification: { command: 'npm test --ignore-scripts', exitCode: 0 } }
}

async function main() {
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Container execution cancelled'))
  const timeout = setTimeout(cancel, executionDeadlineMs())
  process.once('SIGTERM', cancel)
  const destroyInput = () => process.stdin.destroy(new Error('Container input cancelled'))
  controller.signal.addEventListener('abort', destroyInput, { once: true })
  const emit = async (value: unknown) => {
    await new Promise<void>((accept, reject) =>
      process.stdout.write(`${JSON.stringify(value)}\n`, error => (error ? reject(error) : accept()))
    )
  }
  try {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > MAX_INPUT_BYTES) throw new Error('Container input exceeds 100 MiB')
      chunks.push(chunk)
    }
    controller.signal.removeEventListener('abort', destroyInput)
    const result = await executeContainerAttempt(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
      signal: controller.signal,
      onProgress: (phase, detail) => emit({ type: 'progress', phase, detail }),
    })
    await emit({ type: 'result', ...result })
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Container execution failed'
    for (const [key, value] of Object.entries(process.env))
      if (value && /TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL/i.test(key))
        message = message.split(value).join('[REDACTED]')
    await emit({ type: 'error', error: message.slice(0, 1024) })
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    process.removeListener('SIGTERM', cancel)
    controller.signal.removeEventListener('abort', destroyInput)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main()
