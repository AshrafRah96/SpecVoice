import { spawn } from 'child_process'
import { createInterface } from 'readline'
import type { BuildPhase } from '@/lib/session/types'
import { ClaudeOutputParser } from '@/lib/build/claude-output-parser'

export interface RunOpts {
  dir: string
  branchName: string
  commitMessage: string
  onProgress: (phase: BuildPhase, detail: string) => void
}

export interface ProcessRunner {
  run(opts: RunOpts): Promise<void>
}

// ── ClaudeProcessRunner ───────────────────────────────────────────────────────

export class ClaudeProcessRunner implements ProcessRunner {
  async run(opts: RunOpts): Promise<void> {
    const prompt = [
      'Read SPEC.md in the repository root for what to implement.',
      'Read CONTEXT.md in the repository root for the rationale behind each decision.',
      'Follow these steps in order:',
      `1. Run: git checkout -b ${opts.branchName}`,
      '2. Implement every change described in SPEC.md. Follow existing patterns in the codebase exactly — read relevant existing files before writing anything new.',
      '3. Check package.json for the test command and run the tests.',
      '4. Fix any failures. Repeat until tests pass.',
      `5. Run: git add -A && git commit -m "feat: ${opts.commitMessage}"`,
      `6. Run: git push -u origin ${opts.branchName}`,
      'Do not create a pull request. Stop after pushing the branch.',
      'Do not ask questions. SPEC.md and CONTEXT.md contain everything you need.',
    ].join('\n')

    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn() }
      }

      const proc = spawn(
        'claude',
        [
          '-p', prompt,
          '--output-format', 'stream-json',
          '--verbose',
          '--allowedTools', 'Read,Write,Edit,Bash(git *),Bash(npm test *),Bash(npx *)',
          '--max-turns', '300',
        ],
        {
          cwd: opts.dir,
          // Git identity env vars: required for git commit in environments where
          // user.name / user.email are not globally configured (CI, containers, etc.)
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'SpecVoice',
            GIT_AUTHOR_EMAIL: 'specvoice@noreply.github.com',
            GIT_COMMITTER_NAME: 'SpecVoice',
            GIT_COMMITTER_EMAIL: 'specvoice@noreply.github.com',
          },
          // Pipe stderr so we can capture and surface it in build_failed errors.
          // stderr buffer is drained line-by-line to avoid 64KB deadlock.
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )

      let stderrOutput = ''
      proc.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        process.stderr.write(text)
        stderrOutput += text
      })

      const rl = createInterface({ input: proc.stdout! })
      const parser = new ClaudeOutputParser()

      rl.on('line', (line) => {
        const result = parser.feed(line)
        if (!result) return
        if (result.type === 'progress') {
          opts.onProgress(result.phase, result.detail)
        } else if (result.type === 'terminal' && !result.success) {
          settle(() => reject(new Error(result.error)))
          proc.kill()
        }
      })

      proc.on('close', (code) => {
        rl.close()
        if (code === 0) {
          settle(resolve)
        } else {
          const detail = stderrOutput.trim()
          settle(() =>
            reject(
              new Error(
                detail
                  ? `Claude Code exited with code ${code}: ${detail}`
                  : `Claude Code exited with code ${code}`
              )
            )
          )
        }
      })

      proc.on('error', (err) => {
        rl.close()
        settle(() => reject(err))
      })
    })
  }
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
    if (this.shouldThrow) throw this.shouldThrow
    const phases: FakeProgress[] = [
      { phase: 'analyzing', detail: 'src/lib/foo.ts' },
      { phase: 'writing', detail: 'src/lib/bar.ts' },
      { phase: 'reviewing', detail: 'npm test' },
    ]
    for (const p of phases) {
      opts.onProgress(p.phase, p.detail)
      this.progressEmitted.push(p)
    }
  }
}
