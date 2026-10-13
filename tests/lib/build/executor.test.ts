import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'node:child_process'

import { buildBranchName, writeBuildFiles } from '@/lib/build/executor'
import { makeSession, makeDecision } from '../../fixtures'

// ── buildBranchName ──────────────────────────────────────────────────────────

describe('buildBranchName', () => {
  it('slugifies the first decision summary', () => {
    const session = makeSession({
      decisions: [makeDecision('Use Postgres for session storage')],
    })
    expect(buildBranchName(session)).toContain(`spec-voice/use-postgres-for-session-storage-${session.id}-`)
  })

  it('falls back to first 8 chars of session id when no decisions', () => {
    const session = makeSession({ decisions: [] })
    expect(buildBranchName(session)).toContain(`spec-voice/${session.id.slice(0, 8)}-${session.id}-`)
  })

  it('trims slugified summary to 50 chars', () => {
    const longSummary = 'A'.repeat(60) + ' b c d'
    const session = makeSession({ decisions: [makeDecision(longSummary)] })
    const branch = buildBranchName(session)
    // slug is max 50 chars after 'spec-voice/'
    expect(branch).toContain(`spec-voice/${'a'.repeat(50)}-${session.id}-`)
    expect(buildBranchName({ ...session, buildAttemptKey: 'another' })).not.toBe(branch)
  })
})

// ── writeBuildFiles ──────────────────────────────────────────────────────────

describe('writeBuildFiles', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-build-'))
    execFileSync('git', ['-C', tmpDir, 'init', '--quiet'])
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('fails closed when Git cannot inspect the checkout', () => {
    fs.rmSync(path.join(tmpDir, '.git'), { recursive: true, force: true })
    expect(() => writeBuildFiles(tmpDir, makeSession({ specOutput: '# Spec' }))).toThrow(
      'Cannot inspect build input collision'
    )
    expect(fs.existsSync(path.join(tmpDir, 'SPEC.md'))).toBe(false)
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
      decisions: [
        makeDecision('Use Postgres for session storage', {
          alternativesConsidered: ['Option B'],
          relevantFiles: ['src/lib/foo.ts'],
        }),
      ],
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

  it('excludes generated inputs locally while preserving the tracked ignore file and existing exclusions', () => {
    const ignore = '# Project ignores\ncoverage/\n'
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), ignore)
    execFileSync('git', ['-C', tmpDir, 'add', '.gitignore'])
    const exclude = path.join(tmpDir, '.git', 'info', 'exclude')
    fs.appendFileSync(exclude, '\nexisting-local-only.txt\n')
    writeBuildFiles(tmpDir, makeSession({ specOutput: '# Spec\n\nImplement this change.' }))

    expect(fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8')).toBe(ignore)
    expect(execFileSync('git', ['-C', tmpDir, 'diff', '--', '.gitignore'], { encoding: 'utf8' })).toBe('')
    expect(fs.readFileSync(exclude, 'utf8')).toContain('existing-local-only.txt')
    expect(
      execFileSync('git', ['-C', tmpDir, 'check-ignore', 'SPEC.md', 'CONTEXT.md'], { encoding: 'utf8' })
        .trim()
        .split('\n')
    ).toEqual(['SPEC.md', 'CONTEXT.md'])
    execFileSync('git', ['-C', tmpDir, 'add', '--all'])
    expect(execFileSync('git', ['-C', tmpDir, 'ls-files'], { encoding: 'utf8' }).trim().split('\n')).toEqual([
      '.gitignore',
    ])
  })

  it.each([
    ['SPEC.md', false],
    ['CONTEXT.md', false],
    ['SPEC.md', true],
    ['CONTEXT.md', true],
  ] as const)('rejects collision with %s (tracked=%s) before changing either build input', (name, tracked) => {
    fs.writeFileSync(path.join(tmpDir, name), 'existing repository content')
    if (tracked) execFileSync('git', ['-C', tmpDir, 'add', name])
    const exclude = path.join(tmpDir, '.git', 'info', 'exclude')
    const previousExclude = fs.readFileSync(exclude, 'utf8')
    expect(() => writeBuildFiles(tmpDir, makeSession({ specOutput: '# New spec' }))).toThrow(
      `Build input collides with repository file: ${name}`
    )
    expect(fs.readFileSync(path.join(tmpDir, name), 'utf8')).toBe('existing repository content')
    expect(fs.existsSync(path.join(tmpDir, name === 'SPEC.md' ? 'CONTEXT.md' : 'SPEC.md'))).toBe(false)
    expect(fs.readFileSync(exclude, 'utf8')).toBe(previousExclude)
  })

  it.each(['SPEC.md', 'CONTEXT.md'])('rejects a tracked %s missing from the working tree', name => {
    fs.writeFileSync(path.join(tmpDir, name), 'tracked content')
    execFileSync('git', ['-C', tmpDir, 'add', name])
    fs.rmSync(path.join(tmpDir, name))
    expect(() => writeBuildFiles(tmpDir, makeSession({ specOutput: '# New spec' }))).toThrow(
      `Build input collides with repository file: ${name}`
    )
    expect(fs.existsSync(path.join(tmpDir, name))).toBe(false)
  })

  it.each(['SPEC.md', 'CONTEXT.md'])('rejects an untracked dangling %s symlink without writing its target', name => {
    const target = path.join(tmpDir, 'unexpected-target.md')
    fs.symlinkSync(target, path.join(tmpDir, name))
    expect(() => writeBuildFiles(tmpDir, makeSession({ specOutput: '# New spec' }))).toThrow(
      `Build input collides with repository file: ${name}`
    )
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.lstatSync(path.join(tmpDir, name)).isSymbolicLink()).toBe(true)
  })
})
