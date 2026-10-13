import { spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BuildPhase } from '@/lib/session/types'
import { ClaudeOutputParser } from '@/lib/build/claude-output-parser'

export interface RunOpts {
  dir: string
  branchName: string
  commitMessage: string
  onProgress: (phase: BuildPhase, detail: string) => void | Promise<void>
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ProcessRunner {
  run(opts: RunOpts): Promise<void>
}

// ── ClaudeProcessRunner ───────────────────────────────────────────────────────

export class ClaudeProcessRunner implements ProcessRunner {
  async run(opts: RunOpts): Promise<void> {
    if (opts.signal?.aborted) throw new Error('Claude Code run cancelled')
    const prompt = [
      'Read SPEC.md in the repository root for what to implement.',
      'Read CONTEXT.md in the repository root for the rationale behind each decision.',
      'Follow these steps in order:',
      `1. Run: git checkout -b ${opts.branchName}`,
      '2. Implement every change described in SPEC.md. Follow existing patterns in the codebase exactly — read relevant existing files before writing anything new.',
      '3. Check package.json for the test command and run the tests.',
      '4. Fix any failures. Repeat until tests pass.',
      `5. Run: git add -A && git commit -m "feat: ${opts.commitMessage}"`,
      '6. Stop after committing. Do not push branches or create pull requests; the worker owns those side effects.',
      'Do not ask questions. SPEC.md and CONTEXT.md contain everything you need.',
    ].join('\n')

    const safeNpmDir = mkdtempSync(join(tmpdir(), 'specvoice-safe-npm-'))
    try {
      const {
        GITHUB_TOKEN: _ignoredToken,
        DATABASE_URL: _ignoredDatabaseUrl,
        SESSION_CAPABILITY_SECRET: _ignoredCapabilitySecret,
        ELEVENLABS_API_KEY: _ignoredElevenLabsKey,
        ELEVENLABS_WEBHOOK_SECRET: _ignoredWebhookSecret,
        ...safeEnv
      } = process.env
      const originalPath = safeEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin'
      writeFileSync(
        join(safeNpmDir, 'npm'),
        `#!/bin/sh\nunset ANTHROPIC_API_KEY DATABASE_URL SESSION_CAPABILITY_SECRET ELEVENLABS_API_KEY ELEVENLABS_WEBHOOK_SECRET GITHUB_TOKEN\nPATH=${shellQuote(originalPath)} exec npm "$@"\n`,
        { mode: 0o700 }
      )
      const proc = spawn(
        'claude',
        [
          '-p',
          prompt,
          '--bare',
          '--permission-mode',
          'default',
          '--permission-prompts',
          'none',
          '--setting-sources',
          '',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--tools',
          'Read,Write,Edit,Bash',
          '--model',
          'claude-sonnet-4-6',
          '--max-budget-usd',
          process.env.SPECVOICE_BUILD_BUDGET_USD ?? '5',
          '--output-format',
          'stream-json',
          '--verbose',
          '--allowedTools',
          'Read,Write,Edit,Bash(git status *),Bash(git diff *),Bash(git checkout *),Bash(git add *),Bash(git commit *),Bash(npm test *)',
          '--max-turns',
          '80',
        ],
        {
          cwd: opts.dir,
          detached: process.platform !== 'win32',
          // Git identity env vars: required for git commit in environments where
          // user.name / user.email are not globally configured (CI, containers, etc.)
          env: {
            // The worker owns GitHub side effects; never expose its token to the model process.
            ...safeEnv,
            GIT_AUTHOR_NAME: 'SpecVoice',
            GIT_AUTHOR_EMAIL: 'specvoice@noreply.github.com',
            GIT_COMMITTER_NAME: 'SpecVoice',
            GIT_COMMITTER_EMAIL: 'specvoice@noreply.github.com',
            PATH: `${safeNpmDir}:${originalPath}`,
            NPM_CONFIG_IGNORE_SCRIPTS: '1',
            npm_config_ignore_scripts: 'true',
          },
          // Pipe stderr so we can capture and surface it in build_failed errors.
          // stderr is drained continuously to avoid 64KB deadlock.
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )

      let failure: Error | undefined
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, signal)
          else proc.kill(signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      const stop = (error: Error) => {
        if (failure) return
        failure = error
        kill('SIGTERM')
        killTimer = setTimeout(() => kill('SIGKILL'), 5000)
      }
      const closed = new Promise<number | null>(resolve => {
        proc.once('error', stop)
        proc.once('close', resolve)
      })
      const abort = () => stop(new Error('Claude Code run cancelled'))
      const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000
      const timeout = setTimeout(() => stop(new Error(`Claude Code timed out after ${timeoutMs}ms`)), timeoutMs)
      opts.signal?.addEventListener('abort', abort, { once: true })
      if (opts.signal?.aborted) abort()

      let stderrOutput = ''
      const captureStderr = (chunk: Buffer) => {
        stderrOutput = (stderrOutput + chunk.toString()).slice(-64 * 1024)
      }
      proc.stderr!.on('data', captureStderr)
      const parser = new ClaudeOutputParser()
      const processLine = async (line: string) => {
        if (failure) return
        if (line.length > 1024 * 1024) throw new Error('Claude Code output line exceeds 1MiB')
        const result = parser.feed(line)
        if (result?.type === 'progress') await opts.onProgress(result.phase, result.detail)
        else if (result?.type === 'terminal' && !result.success) stop(new Error(result.error))
      }
      try {
        let pending = ''
        proc.stdout!.setEncoding('utf8')
        try {
          // Await persistence before consuming more stdout so progress cannot outrun storage.
          for await (const chunk of proc.stdout!) {
            pending += chunk
            let newline: number
            while ((newline = pending.indexOf('\n')) !== -1) {
              const line = pending.slice(0, newline)
              pending = pending.slice(newline + 1)
              await processLine(line)
            }
            if (pending.length > 1024 * 1024) throw new Error('Claude Code output line exceeds 1MiB')
          }
          if (pending) await processLine(pending)
        } catch (error) {
          stop(error instanceof Error ? error : new Error(String(error)))
        }
        const code = await closed
        if (failure) throw failure
        if (code !== 0) {
          const secrets = [
            process.env.ANTHROPIC_API_KEY,
            _ignoredToken,
            _ignoredDatabaseUrl,
            _ignoredCapabilitySecret,
            _ignoredElevenLabsKey,
            _ignoredWebhookSecret,
          ]
          const detail = secrets
            .reduce<string>((text, secret) => (secret ? text.split(secret).join('[REDACTED]') : text), stderrOutput)
            .trim()
          throw new Error(`Claude Code exited with code ${code}${detail ? `: ${detail}` : ''}`)
        }
      } finally {
        clearTimeout(timeout)
        clearTimeout(killTimer)
        opts.signal?.removeEventListener('abort', abort)
        proc.removeListener('error', stop)
        proc.stderr!.removeListener('data', captureStderr)
        // The direct child may exit before a descendant that ignored SIGTERM.
        kill('SIGKILL')
      }
    } finally {
      rmSync(safeNpmDir, { recursive: true, force: true })
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

// ── FakeProcessRunner — for use in tests only ─────────────────────────────────

export interface FakeProgress {
  phase: BuildPhase
  detail: string
}

export class FakeProcessRunner implements ProcessRunner {
  readonly progressEmitted: FakeProgress[] = []
  private readonly shouldThrow: Error | null

  constructor(opts: { error?: Error } = {}) {
    this.shouldThrow = opts.error ?? null
  }

  async run(opts: RunOpts): Promise<void> {
    if (opts.signal?.aborted) throw new Error('Claude Code run cancelled')
    if (this.shouldThrow) throw this.shouldThrow
    const phases: FakeProgress[] = [
      { phase: 'analyzing', detail: 'src/lib/foo.ts' },
      { phase: 'writing', detail: 'src/lib/bar.ts' },
      { phase: 'reviewing', detail: 'npm test' },
    ]
    for (const p of phases) {
      if (opts.signal?.aborted) throw new Error('Claude Code run cancelled')
      await opts.onProgress(p.phase, p.detail)
      this.progressEmitted.push(p)
    }
  }
}
