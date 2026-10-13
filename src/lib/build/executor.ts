import { createHash } from 'node:crypto'
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
  const slug = session.decisions[0]?.summary ? slugify(session.decisions[0].summary) : session.id.slice(0, 8)
  const attempt = createHash('sha256')
    .update(session.buildAttemptKey ?? session.id)
    .digest('hex')
    .slice(0, 16)
  return `spec-voice/${slug || 'build'}-${session.id}-${attempt}`
}

export function writeBuildFiles(dir: string, session: Session): void {
  // Build inputs belong to this checkout, never to the proposed repository change.
  for (const name of ['SPEC.md', 'CONTEXT.md']) {
    const tracked = spawnSync('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', name], {
      stdio: 'pipe',
      timeout: 10_000,
    })
    if (tracked.error || (tracked.status !== 0 && tracked.status !== 1))
      throw new Error(`Cannot inspect build input collision: ${name}`, { cause: tracked.error })
    const existing = fs.lstatSync(path.join(/* turbopackIgnore: true */ dir, name), { throwIfNoEntry: false })
    if (tracked.status === 0 || existing) throw new Error(`Build input collides with repository file: ${name}`)
  }
  const info = path.join(dir, '.git', 'info')
  fs.mkdirSync(info, { recursive: true })
  fs.appendFileSync(path.join(info, 'exclude'), '\n/SPEC.md\n/CONTEXT.md\n')

  // SPEC.md — raw spec output
  fs.writeFileSync(path.join(dir, 'SPEC.md'), session.specOutput!)

  // CONTEXT.md — decisions + transcript
  const decisionSection =
    session.decisions.length > 0
      ? session.decisions
          .map(d =>
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
      transcriptSection = turns.map(t => `**${t.role}:** ${t.message}`).join('\n\n')
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
  if (
    !process.env.DATABASE_URL ||
    !process.env.SPECVOICE_SERVICE_SECRET ||
    process.env.SPECVOICE_SERVICE_SECRET.length < 32
  ) {
    return {
      ok: false,
      error:
        'Builds require PostgreSQL and isolated Docker execution. Configure SPECVOICE_SERVICE_SECRET and start the local Compose stack.',
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
