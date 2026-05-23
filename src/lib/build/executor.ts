import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { Session } from '@/lib/session/types'

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
      error:
        'GITHUB_TOKEN is not set. Add it to .env.local — required to push the branch and create the PR.',
    }
  }
  return { ok: true }
}

