import { describe, it, expect } from 'vitest'
import { ClaudeOutputParser } from '@/lib/build/claude-output-parser'

// Helpers to build raw NDJSON lines
function assistantLine(blocks: Array<{ type: string; name?: string; input?: Record<string, unknown> }>) {
  return JSON.stringify({ type: 'assistant', message: { content: blocks } })
}

function resultLine(subtype: string) {
  return JSON.stringify({ type: 'result', subtype })
}

function toolUse(name: string, input: Record<string, unknown> = {}) {
  return { type: 'tool_use', name, input }
}

// ── feed: non-event lines ────────────────────────────────────────────────────

describe('ClaudeOutputParser.feed — non-event lines', () => {
  it('returns null for an empty string', () => {
    const parser = new ClaudeOutputParser()
    expect(parser.feed('')).toBeNull()
  })

  it('returns null for a whitespace-only string', () => {
    const parser = new ClaudeOutputParser()
    expect(parser.feed('   \t  ')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    const parser = new ClaudeOutputParser()
    expect(parser.feed('{ not valid json')).toBeNull()
  })

  it('returns null for an unknown event type', () => {
    const parser = new ClaudeOutputParser()
    expect(parser.feed(JSON.stringify({ type: 'system', content: 'hello' }))).toBeNull()
  })

  it('returns null for an assistant event with no content array', () => {
    const parser = new ClaudeOutputParser()
    expect(parser.feed(JSON.stringify({ type: 'assistant', message: {} }))).toBeNull()
  })

  it('returns null for an assistant event with no tool_use blocks', () => {
    const parser = new ClaudeOutputParser()
    const line = assistantLine([{ type: 'text' }])
    expect(parser.feed(line)).toBeNull()
  })
})

// ── feed: progress events ────────────────────────────────────────────────────

describe('ClaudeOutputParser.feed — progress events', () => {
  it('emits a progress event for a Read tool_use', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(assistantLine([toolUse('Read', { file_path: 'src/lib/foo.ts' })]))
    expect(result).toEqual({ type: 'progress', phase: 'analyzing', detail: 'src/lib/foo.ts' })
  })

  it('emits a progress event for a Glob tool_use', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(assistantLine([toolUse('Glob', { pattern: '**/*.ts' })]))
    expect(result).toEqual({ type: 'progress', phase: 'analyzing', detail: '**/*.ts' })
  })

  it('emits a progress event for a Grep tool_use', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(assistantLine([toolUse('Grep', { pattern: 'useState' })]))
    expect(result).toEqual({ type: 'progress', phase: 'analyzing', detail: 'useState' })
  })

  it('emits a progress event for a Write tool_use', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(assistantLine([toolUse('Write', { file_path: 'src/lib/bar.ts' })]))
    expect(result).toEqual({ type: 'progress', phase: 'writing', detail: 'src/lib/bar.ts' })
  })

  it('emits a progress event for an Edit tool_use', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(assistantLine([toolUse('Edit', { file_path: 'src/app/page.tsx' })]))
    expect(result).toEqual({ type: 'progress', phase: 'writing', detail: 'src/app/page.tsx' })
  })

  it('emits a progress event for a MultiEdit tool_use', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(assistantLine([toolUse('MultiEdit', { file_path: 'src/app/layout.tsx' })]))
    expect(result).toEqual({ type: 'progress', phase: 'writing', detail: 'src/app/layout.tsx' })
  })

  it('emits a progress event for a NotebookEdit tool_use', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(assistantLine([toolUse('NotebookEdit', { file_path: 'notebook.ipynb' })]))
    expect(result).toEqual({ type: 'progress', phase: 'writing', detail: 'notebook.ipynb' })
  })

  it('maps Bash to reviewing phase with truncated command', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(assistantLine([toolUse('Bash', { command: 'npm test' })]))
    expect(result).toEqual({ type: 'progress', phase: 'reviewing', detail: 'npm test' })
  })

  it('truncates Bash command to 80 chars with ellipsis', () => {
    const parser = new ClaudeOutputParser()
    const longCmd = 'git commit -m "' + 'x'.repeat(80) + '"'
    const result = parser.feed(assistantLine([toolUse('Bash', { command: longCmd })]))
    expect(result?.type).toBe('progress')
    expect((result as { type: string; detail: string }).detail.length).toBeLessThanOrEqual(83)
    expect((result as { type: string; detail: string }).detail).toMatch(/\.\.\.$/)
  })

  it('maps an unknown tool to reviewing phase using tool name as detail', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(assistantLine([toolUse('TodoWrite', {})]))
    expect(result).toEqual({ type: 'progress', phase: 'reviewing', detail: 'TodoWrite' })
  })

  it('returns the first tool_use block when multiple blocks are present', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(assistantLine([
      { type: 'text' },
      toolUse('Read', { file_path: 'first.ts' }),
      toolUse('Write', { file_path: 'second.ts' }),
    ]))
    expect(result).toEqual({ type: 'progress', phase: 'analyzing', detail: 'first.ts' })
  })
})

// ── feed: terminal events ────────────────────────────────────────────────────

describe('ClaudeOutputParser.feed — terminal events', () => {
  it('returns terminal success for result event with subtype "success"', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(resultLine('success'))
    expect(result).toEqual({ type: 'terminal', success: true })
  })

  it('returns terminal failure for result event with subtype "max_turns"', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(resultLine('max_turns'))
    expect(result).toEqual({
      type: 'terminal',
      success: false,
      error: 'Claude Code ended with subtype "max_turns"',
    })
  })

  it('returns terminal failure for result event with subtype "error_max_tokens"', () => {
    const parser = new ClaudeOutputParser()
    const result = parser.feed(resultLine('error_max_tokens'))
    expect(result).toEqual({
      type: 'terminal',
      success: false,
      error: 'Claude Code ended with subtype "error_max_tokens"',
    })
  })
})
