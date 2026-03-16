import type { Session } from '@/lib/session/types'
import type { CodeSource } from '@/lib/code/types'
import { GitHubCodeSource } from '@/lib/code/github-source'
import { LocalCodeSource } from '@/lib/code/local-source'
// Cache per session.id — attached to globalThis so it survives Next.js hot reloads
// and is shared across route module contexts (same fix as sessionStore).
const g = globalThis as unknown as { __sourceCache?: Map<string, CodeSource> }
if (!g.__sourceCache) g.__sourceCache = new Map()
const sourceCache = g.__sourceCache

export function resolveCodeSource(session: Session): CodeSource {
  const cached = sourceCache.get(session.id)
  if (cached) return cached

  let source: CodeSource

  if (session.repoUrl) {
    source = new GitHubCodeSource(session.repoUrl, process.env.GITHUB_TOKEN)
  } else if (session.repoLocalPath) {
    source = new LocalCodeSource(session.repoLocalPath)
  } else {
    throw new Error(
      `Session ${session.id} has no code source configured. ` +
        'Set repoUrl or repoLocalPath when creating the session via POST /api/sessions.'
    )
  }

  sourceCache.set(session.id, source)
  return source
}
