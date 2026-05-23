import type { BuildPhase } from '@/lib/session/types'

export type ParseResult =
  | { type: 'progress'; phase: BuildPhase; detail: string }
  | { type: 'terminal'; success: boolean; error?: string }
  | null

interface ClaudeStreamEvent {
  type: string
  subtype?: string
  message?: {
    content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>
  }
}

function phaseFromTool(name: string): BuildPhase {
  if (['Read', 'Glob', 'Grep'].includes(name)) return 'analyzing'
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'writing'
  return 'reviewing'
}

function detailFromInput(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit' || tool === 'Read') {
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

export class ClaudeOutputParser {
  feed(line: string): ParseResult {
    if (!line.trim()) return null

    let event: ClaudeStreamEvent
    try {
      event = JSON.parse(line) as ClaudeStreamEvent
    } catch {
      return null
    }

    if (event.type === 'result') {
      if (event.subtype === 'success') return { type: 'terminal', success: true }
      return {
        type: 'terminal',
        success: false,
        error: `Claude Code ended with subtype "${event.subtype}"`,
      }
    }

    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name) {
          return {
            type: 'progress',
            phase: phaseFromTool(block.name),
            detail: detailFromInput(block.name, block.input ?? {}),
          }
        }
      }
    }

    return null
  }
}
