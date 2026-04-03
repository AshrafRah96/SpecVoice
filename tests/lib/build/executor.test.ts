import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Session } from '@/lib/session/types'

// Import the functions under test — they don't exist yet, so this will fail to compile.
import {
  buildBranchName,
  writeBuildFiles,
  phaseFromTool,
  detailFromInput,
} from '@/lib/build/executor'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1234abcd',
    repoUrl: 'https://github.com/octocat/Hello-World',
    decisions: [],
    openQuestions: [],
    filesRead: [],
    specOutput: '# Spec\n\n- Implement foo\n- Implement bar',
    status: 'complete',
    callDurationSecs: 120,
    transcript: null,
    buildStatus: 'ready',
    prUrl: null,
    complexityAssessment: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeDecision(summary: string) {
  return {
    id: 'dec-1',
    summary,
    rationale: 'Good reason',
    alternativesConsidered: ['Option B'],
    relevantFiles: ['src/lib/foo.ts'],
    timestamp: new Date().toISOString(),
  }
}

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
    expect(buildBranchName(session)).toBe('spec-voice/sess-123')
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
    const session = makeSession()
    writeBuildFiles(tmpDir, session)
    const content = fs.readFileSync(path.join(tmpDir, 'CONTEXT.md'), 'utf8')
    expect(content).toContain('sess-1234abcd')
    expect(content).toContain('https://github.com/octocat/Hello-World')
  })

  it('writes decision summary, rationale, and relevant files into CONTEXT.md', () => {
    const session = makeSession({
      decisions: [makeDecision('Use Postgres for session storage')],
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
    const session = makeSession({ transcript })
    writeBuildFiles(tmpDir, session)
    const content = fs.readFileSync(path.join(tmpDir, 'CONTEXT.md'), 'utf8')
    expect(content).toContain('Hello, tell me about your repo.')
    expect(content).toContain('It is a todo app.')
  })

  it('falls back gracefully when transcript is not valid JSON', () => {
    const session = makeSession({ transcript: 'raw text transcript' })
    writeBuildFiles(tmpDir, session)
    const content = fs.readFileSync(path.join(tmpDir, 'CONTEXT.md'), 'utf8')
    expect(content).toContain('raw text transcript')
  })
})

// ── phaseFromTool ────────────────────────────────────────────────────────────

describe('phaseFromTool', () => {
  it('maps Read, Glob, Grep to analyzing', () => {
    expect(phaseFromTool('Read')).toBe('analyzing')
    expect(phaseFromTool('Glob')).toBe('analyzing')
    expect(phaseFromTool('Grep')).toBe('analyzing')
  })

  it('maps Write, Edit, MultiEdit to writing', () => {
    expect(phaseFromTool('Write')).toBe('writing')
    expect(phaseFromTool('Edit')).toBe('writing')
    expect(phaseFromTool('MultiEdit')).toBe('writing')
  })

  it('maps Bash to reviewing', () => {
    expect(phaseFromTool('Bash')).toBe('reviewing')
  })
})

// ── detailFromInput ──────────────────────────────────────────────────────────

describe('detailFromInput', () => {
  it('returns file_path for Write', () => {
    expect(detailFromInput('Write', { file_path: 'src/lib/foo.ts' })).toBe('src/lib/foo.ts')
  })

  it('returns file_path for Read', () => {
    expect(detailFromInput('Read', { file_path: 'README.md' })).toBe('README.md')
  })

  it('returns command truncated to 80 chars for Bash', () => {
    const long = 'git commit -m "' + 'x'.repeat(80) + '"'
    const result = detailFromInput('Bash', { command: long })
    expect(result.length).toBeLessThanOrEqual(83) // 80 + '...'
    expect(result).toMatch(/\.\.\.$/)
  })

  it('returns full short command for Bash without truncation', () => {
    expect(detailFromInput('Bash', { command: 'npm test' })).toBe('npm test')
  })

  it('returns pattern for Grep', () => {
    expect(detailFromInput('Grep', { pattern: 'useState' })).toBe('useState')
  })
})
