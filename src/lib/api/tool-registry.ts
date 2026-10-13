import { z } from 'zod'
import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getSessionRepository } from '@/lib/session/runtime'
import { generateSpec } from '@/lib/session/spec-generator'
import { createToolHandler, createCodeToolHandler } from '@/lib/api/tool-handler'

type ToolHandler = (req: NextRequest) => Promise<NextResponse>

class ToolRegistry {
  private handlers = new Map<string, ToolHandler>()

  register(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler)
  }

  async dispatch(name: string, req: NextRequest): Promise<NextResponse> {
    const handler = this.handlers.get(name)
    if (!handler) {
      return NextResponse.json({ error: `Unknown tool: ${name}` }, { status: 404 })
    }
    return handler(req)
  }
}

export const toolRegistry = new ToolRegistry()

// ── list-files ────────────────────────────────────────────────────────────────
toolRegistry.register(
  'list-files',
  createCodeToolHandler(z.object({ path: z.string().optional() }), async (_session, source, input, request) => {
    const files = await source.listFiles(input.path, { signal: request.signal })
    return NextResponse.json(files)
  })
)

// ── read-file ─────────────────────────────────────────────────────────────────
toolRegistry.register(
  'read-file',
  createCodeToolHandler(
    z.object({
      path: z.string(),
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional(),
    }),
    async (session, source, input, request) => {
      const content = await source.readFile(input.path, input.start_line, input.end_line, { signal: request.signal })
      await getSessionRepository().recordFileRead(
        session.id,
        {
          path: input.path,
          timestamp: new Date().toISOString(),
          characterCount: content.content.length,
        },
        session.currentCallId ?? undefined
      )
      return NextResponse.json({ content })
    }
  )
)

// ── search-code ───────────────────────────────────────────────────────────────
toolRegistry.register(
  'search-code',
  createCodeToolHandler(
    z.object({
      query: z.string(),
      max_results: z.number().int().positive().default(20).optional(),
    }),
    async (_session, source, input, request) => {
      const results = await source.searchCode(input.query, input.max_results, { signal: request.signal })
      return NextResponse.json(results)
    }
  )
)

// ── save-decision ─────────────────────────────────────────────────────────────
toolRegistry.register(
  'save-decision',
  createToolHandler(
    z.object({
      summary: z.string().min(1),
      rationale: z.string().min(1),
      alternatives_considered: z.array(z.string()).default([]),
      relevant_files: z.array(z.string()).default([]),
    }),
    async (session, input) => {
      const decision = {
        id: randomUUID(),
        summary: input.summary,
        rationale: input.rationale,
        alternativesConsidered: input.alternatives_considered,
        relevantFiles: input.relevant_files,
        timestamp: new Date().toISOString(),
      }
      await getSessionRepository().addDecision(session.id, decision, session.currentCallId ?? undefined)
      return NextResponse.json({ decision })
    }
  )
)

// ── flag-question ─────────────────────────────────────────────────────────────
toolRegistry.register(
  'flag-question',
  createToolHandler(
    z.object({
      question: z.string().min(1),
      context: z.string().default(''),
    }),
    async (session, input) => {
      const openQuestion = {
        id: randomUUID(),
        question: input.question,
        context: input.context,
        timestamp: new Date().toISOString(),
      }
      await getSessionRepository().flagQuestion(session.id, openQuestion, session.currentCallId ?? undefined)
      return NextResponse.json({ question: openQuestion })
    }
  )
)

// ── generate-spec ─────────────────────────────────────────────────────────────
toolRegistry.register(
  'generate-spec',
  createToolHandler(z.object({}), async session => {
    const spec = generateSpec(session)
    await getSessionRepository().setSpec(session.id, spec, session.currentCallId ?? undefined)
    return NextResponse.json({ spec })
  })
)
