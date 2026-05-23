import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { buildBranchName, writeBuildFiles } from '@/lib/build/executor'
import { makeSession, makeDecision } from '../../fixtures'

// ── buildBranchName ──────────────────────────────────────────────────────────

describe('buildBranchName', () => {
  it('slugifies the first decision summary', () => {
    const session = makeSession({
      decisions: [makeDecision('Use Postgres for session storage')],
    })
    expect(buildBranchName(session)).toBe('spec-voice/use-postgres-for-session-storage')
  })

  it('falls back to first 8 chars of session id when no decisions', () => {
    const session = makeSession({ decisions: [] })
    expect(buildBranchName(session)).toBe(`spec-voice/${session.id.slice(0, 8)}`)
  })

  it('trims slugified summary to 50 chars', () => {
    const longSummary = 'A'.repeat(60) + ' b c d'
    const session = makeSession({ decisions: [makeDecision(longSummary)] })
    const branch = buildBranchName(session)
    // slug is max 50 chars after 'spec-voice/'
    expect(branch.replace('spec-voice/', '').length).toBeLessThanOrEqual(50)
  })
})

// ── writeBuildFiles ──────────────────────────────────────────────────────────

describe('writeBuildFiles', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-build-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes SPEC.md with session specOutput', () => {
    const session = makeSession({ specOutput: '# My Spec\n\n- step 1' })
    writeBuildFiles(tmpDir, session)
    const content = fs.readFileSync(path.join(tmpDir, 'SPEC.md'), 'utf8')
    expect(content).toBe('# My Spec\n\n- step 1')
  })

  it('writes CONTEXT.md with session id and repo URL', () => {
    const session = makeSession({ specOutput: '# Spec\n\n- stub' })
    writeBuildFiles(tmpDir, session)
    const content = fs.readFileSync(path.join(tmpDir, 'CONTEXT.md'), 'utf8')
    expect(content).toContain(session.id)
    expect(content).toContain(session.repoUrl!)
  })

  it('writes decision summary, rationale, and relevant files into CONTEXT.md', () => {
    const session = makeSession({
      specOutput: '# Spec\n\n- stub',
      decisions: [makeDecision('Use Postgres for session storage', {
        alternativesConsidered: ['Option B'],
        relevantFiles: ['src/lib/foo.ts'],
      })],
    })
    writeBuildFiles(tmpDir, session)
    const content = fs.readFileSync(path.join(tmpDir, 'CONTEXT.md'), 'utf8')
    expect(content).toContain('Use Postgres for session storage')
    expect(content).toContain('Good reason')
    expect(content).toContain('src/lib/foo.ts')
    expect(content).toContain('Option B')
  })

  it('includes parsed transcript turns when transcript is set', () => {
    const transcript = JSON.stringify([
      { role: 'agent', message: 'Hello, tell me about your repo.' },
      { role: 'user', message: 'It is a todo app.' },
    ])
    const session = makeSession({ specOutput: '# Spec\n\n- stub', transcript })
    writeBuildFiles(tmpDir, session)
    const content = fs.readFileSync(path.join(tmpDir, 'CONTEXT.md'), 'utf8')
    expect(content).toContain('Hello, tell me about your repo.')
    expect(content).toContain('It is a todo app.')
  })

  it('falls back gracefully when transcript is not valid JSON', () => {
    const session = makeSession({ specOutput: '# Spec\n\n- stub', transcript: 'raw text transcript' })
    writeBuildFiles(tmpDir, session)
    const content = fs.readFileSync(path.join(tmpDir, 'CONTEXT.md'), 'utf8')
    expect(content).toContain('raw text transcript')
  })
})

