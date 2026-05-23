import { describe, it, expect } from 'vitest'
import {
  escapeCell,
  categorizeDecision,
  decisionsTable,
  classifiers,
} from '@/lib/session/spec-generator'
import { makeDecision } from '../../fixtures'

// ── escapeCell ────────────────────────────────────────────────────────────────

describe('escapeCell', () => {
  it('escapes pipe characters so they do not break Markdown tables', () => {
    expect(escapeCell('a | b')).toBe('a \\| b')
  })

  it('replaces newlines with spaces to keep rows single-line', () => {
    expect(escapeCell('line1\nline2')).toBe('line1 line2')
  })

  it('passes plain text through unchanged', () => {
    expect(escapeCell('simple text')).toBe('simple text')
  })

  it('handles multiple pipes and newlines', () => {
    expect(escapeCell('a|b\nc|d')).toBe('a\\|b c\\|d')
  })
})

// ── classifiers ───────────────────────────────────────────────────────────────

describe('classifiers', () => {
  it('exports an array with at least two classifiers (edge and scope)', () => {
    expect(Array.isArray(classifiers)).toBe(true)
    expect(classifiers.length).toBeGreaterThanOrEqual(2)
    expect(classifiers.map(c => c.category)).toContain('edge')
    expect(classifiers.map(c => c.category)).toContain('scope')
  })

  it('edge classifier matches error-related keywords', () => {
    const edgeClassifier = classifiers.find(c => c.category === 'edge')!
    expect(edgeClassifier.matches(makeDecision('Handle timeout errors'))).toBe(true)
    expect(edgeClassifier.matches(makeDecision('Add retry logic'))).toBe(true)
    expect(edgeClassifier.matches(makeDecision('Use Postgres'))).toBe(false)
  })

  it('scope classifier matches scope-limiting keywords', () => {
    const scopeClassifier = classifiers.find(c => c.category === 'scope')!
    expect(scopeClassifier.matches(makeDecision('Out of scope for v1'))).toBe(true)
    expect(scopeClassifier.matches(makeDecision('Separate PR for phase 2'))).toBe(true)
    expect(scopeClassifier.matches(makeDecision('Use Postgres'))).toBe(false)
  })

  it('classifiers are applied in order so edge takes priority over scope if both match', () => {
    // A decision whose summary could match both — edge first wins
    const edgeIdx = classifiers.findIndex(c => c.category === 'edge')
    const scopeIdx = classifiers.findIndex(c => c.category === 'scope')
    expect(edgeIdx).toBeLessThan(scopeIdx)
  })

  it('each classifier has a category string and a matches function', () => {
    for (const c of classifiers) {
      expect(typeof c.category).toBe('string')
      expect(typeof c.matches).toBe('function')
    }
  })
})

// ── categorizeDecision ────────────────────────────────────────────────────────

describe('categorizeDecision', () => {
  it('categorizes error-related summaries as edge', () => {
    expect(categorizeDecision(makeDecision('Handle timeout errors'))).toBe('edge')
  })

  it('categorizes scope-related summaries as scope', () => {
    expect(categorizeDecision(makeDecision('Out of scope for v1'))).toBe('scope')
  })

  it('categorizes unmatched summaries as core', () => {
    expect(categorizeDecision(makeDecision('Use Postgres for session storage'))).toBe('core')
  })

  it('is case-insensitive', () => {
    expect(categorizeDecision(makeDecision('HANDLE RETRY LOGIC'))).toBe('edge')
    expect(categorizeDecision(makeDecision('SEPARATE PR'))).toBe('scope')
  })
})

// ── decisionsTable ────────────────────────────────────────────────────────────

describe('decisionsTable', () => {
  it('returns placeholder text when no decisions', () => {
    expect(decisionsTable([])).toBe('_None recorded._\n')
  })

  it('returns a Markdown table with header and rows', () => {
    const d = makeDecision('Use Redis', {
      rationale: 'Low latency',
      alternativesConsidered: ['Memcached'],
    })
    const table = decisionsTable([d])
    expect(table).toContain('| Decision | Rationale | Alternatives Considered |')
    expect(table).toContain('| Use Redis | Low latency | Memcached |')
  })

  it('escapes pipe characters inside cell values', () => {
    const d = makeDecision('Option A | Option B')
    const table = decisionsTable([d])
    expect(table).toContain('Option A \\| Option B')
  })

  it('joins multiple alternatives with semicolons', () => {
    const d = makeDecision('Use X', { alternativesConsidered: ['A', 'B', 'C'] })
    const table = decisionsTable([d])
    expect(table).toContain('A; B; C')
  })

  it('shows None when alternativesConsidered is empty', () => {
    const d = makeDecision('Use X', { alternativesConsidered: [] })
    const table = decisionsTable([d])
    expect(table).toContain('| None |')
  })
})
