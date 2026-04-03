import { spawn, spawnSync } from 'child_process'
import { createInterface } from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import { sessionStore } from '@/lib/session/store'
import { cloneRepo, cleanupTmpDir } from '@/lib/build/clone'
import { createDraftPR } from '@/lib/build/github-pr'
import type { Session, BuildPhase } from '@/lib/session/types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
}

export function buildBranchName(session: Session): string {
  const slug = session.decisions[0]?.summary
    ? slugify(session.decisions[0].summary)
    : session.id.slice(0, 8)
  return `spec-voice/${slug}`
}

export function writeBuildFiles(dir: string, session: Session): void {
  // Exclude build input files from the repo commit — append to .gitignore (or create it).
  const gitignorePath = path.join(dir, '.gitignore')
  const gitignoreEntry = '\n# SpecVoice build inputs\nSPEC.md\nCONTEXT.md\n'
  fs.appendFileSync(gitignorePath, gitignoreEntry)

  // SPEC.md — raw spec output
  fs.writeFileSync(path.join(dir, 'SPEC.md'), session.specOutput!)

  // CONTEXT.md — decisions + transcript
  const decisionSection =
    session.decisions.length > 0
      ? session.decisions
          .map((d) =>
            [
              `### ${d.summary}`,
              `**Rationale:** ${d.rationale}`,
              `**Alternatives considered:** ${d.alternativesConsidered.join(', ') || 'none'}`,
              `**Relevant files:** ${d.relevantFiles.join(', ') || 'none'}`,
            ].join('\n')
          )
          .join('\n\n')
      : '_No decisions recorded._'

  let transcriptSection = '_No transcript available._'
  if (session.transcript) {
    try {
      const turns = JSON.parse(session.transcript) as Array<{ role: string; message: string }>
      transcriptSection = turns.map((t) => `**${t.role}:** ${t.message}`).join('\n\n')
    } catch {
      transcriptSection = session.transcript
    }
  }

  const context = [
    `# SpecVoice Build Context`,
    ``,
    `**Session:** ${session.id}`,
    `**Repository:** ${session.repoUrl}`,
    ``,
    `## Key Decisions`,
    ``,
    decisionSection,
    ``,
    `## Conversation Transcript`,
    ``,
    transcriptSection,
  ].join('\n')

  fs.writeFileSync(path.join(dir, 'CONTEXT.md'), context)
}

export function phaseFromTool(name: string): BuildPhase {
  if (['Read', 'Glob', 'Grep'].includes(name)) return 'analyzing'
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'writing'
  return 'reviewing'
}

export function detailFromInput(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Write' || tool === 'Edit' || tool === 'Read') {
    return String(input.file_path ?? input.path ?? tool)
  }
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '')
    return cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd
  }
  if (tool === 'Grep' || tool === 'Glob') {
    return String(input.pattern ?? input.path ?? tool)
  }
  return tool
}

// ── Prerequisites ─────────────────────────────────────────────────────────────

export function checkPrerequisites(): { ok: boolean; error?: string } {
  const result = spawnSync('claude', ['--version'], { stdio: 'pipe', encoding: 'utf8' })
  if (result.status !== 0 || result.error) {
    return {
      ok: false,
      error:
        'claude CLI not found. Install it: npm install -g @anthropic-ai/claude-code and re-run.',
    }
  }
  // Access process.env directly — these are optional in the env schema so the
  // validated `env` object is not needed here. Importing `env` at module level
  // would throw in test environments missing ELEVENLABS_API_KEY.
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      error: 'ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the server.',
    }
  }
  if (!process.env.GITHUB_TOKEN) {
    return {
      ok: false,
      error: 'GITHUB_TOKEN is not set. Add it to .env.local — required to push the branch and create the PR.',
    }
  }
  return { ok: true }
}

// ── Claude Code runner ────────────────────────────────────────────────────────

interface ClaudeStreamEvent {
  type: string
  subtype?: string
  message?: {
    content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>
  }
}

async function runClaudeCode(opts: {
  dir: string
  branchName: string
  commitMessage: string
  onProgress: (phase: BuildPhase, detail: string) => void
}): Promise<void> {
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
      if (!settled) {
        settled = true
        fn()
      }
    }

    const proc = spawn(
      'claude',
      [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--allowedTools',
        'Read,Write,Edit,Bash(git *),Bash(npm test *),Bash(npx *)',
        '--max-turns',
        '300',
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
      process.stderr.write(text) // mirror to server logs
      stderrOutput += text
    })

    const rl = createInterface({ input: proc.stdout! })

    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line) as ClaudeStreamEvent
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'tool_use' && block.name) {
              opts.onProgress(
                phaseFromTool(block.name),
                detailFromInput(block.name, block.input ?? {})
              )
            }
          }
        }
        if (event.type === 'result' && event.subtype !== 'success') {
          settle(() => reject(new Error(`Claude Code ended with subtype "${event.subtype}"`)))
          proc.kill()
        }
      } catch {
        // malformed NDJSON line — skip
      }
    })

    proc.on('close', (code) => {
      rl.close()
      if (code === 0) {
        settle(resolve)
      } else {
        const detail = stderrOutput.trim()
        const msg = detail
          ? `Claude Code exited with code ${code}: ${detail}`
          : `Claude Code exited with code ${code}`
        settle(() => reject(new Error(msg)))
      }
    })

    proc.on('error', (err) => {
      rl.close()
      settle(() => reject(err))
    })
  })
}

// ── Main orchestration ────────────────────────────────────────────────────────

export async function executeBuild(sessionId: string): Promise<void> {
  const session = sessionStore.getSession(sessionId)
  if (!session) {
    console.warn(`[executeBuild] session ${sessionId} not found — skipping`)
    return
  }

  // Prerequisites
  const prereq = checkPrerequisites()
  if (!prereq.ok) {
    sessionStore.setBuildStatus(sessionId, 'failed')
    sessionStore.broadcastEvent(sessionId, {
      type: 'build_failed',
      sessionId,
      error: prereq.error!,
    })
    return
  }

  // repoUrl is optional on Session (sessions backed by a local path have none).
  // The build pipeline requires a GitHub URL to clone and push. Fail fast with an
  // actionable message rather than passing undefined to git clone.
  if (!session.repoUrl) {
    sessionStore.setBuildStatus(sessionId, 'failed')
    sessionStore.broadcastEvent(sessionId, {
      type: 'build_failed',
      sessionId,
      error: 'Session has no repository URL. Cannot clone and build.',
    })
    return
  }

  let tmpDir: string | undefined

  try {
    // Clone
    sessionStore.broadcastEvent(sessionId, {
      type: 'build_progress',
      phase: 'cloning',
      detail: `Cloning ${session.repoUrl}`,
    })
    tmpDir = await cloneRepo(session.repoUrl)

    const branchName = buildBranchName(session)

    // Write build input files
    writeBuildFiles(tmpDir, session)

    // Run Claude Code
    const commitMessage = session.decisions[0]?.summary ?? `SpecVoice implementation (${sessionId.slice(0, 8)})`
    await runClaudeCode({
      dir: tmpDir,
      branchName,
      commitMessage,
      onProgress: (phase, detail) => {
        sessionStore.broadcastEvent(sessionId, { type: 'build_progress', phase, detail })
      },
    })

    // Create draft PR
    sessionStore.broadcastEvent(sessionId, {
      type: 'build_progress',
      phase: 'pr',
      detail: 'Opening draft PR',
    })
    const prUrl = await createDraftPR({
      repoUrl: session.repoUrl,
      branchName,
      sessionId,
      specOutput: session.specOutput!,
      firstDecisionSummary: session.decisions[0]?.summary,
    })

    sessionStore.updateSession(sessionId, { prUrl, buildStatus: 'complete' })
    sessionStore.broadcastEvent(sessionId, { type: 'build_complete', sessionId, prUrl })
  } catch (err) {
    console.error('[executeBuild] build failed for session', sessionId, err)
    // Session may have been deleted mid-build — guard before updating state
    if (sessionStore.getSession(sessionId)) {
      const error = err instanceof Error ? err.message : String(err)
      sessionStore.setBuildStatus(sessionId, 'failed')
      sessionStore.broadcastEvent(sessionId, { type: 'build_failed', sessionId, error })
    }
  } finally {
    if (tmpDir) cleanupTmpDir(tmpDir)
  }
}
