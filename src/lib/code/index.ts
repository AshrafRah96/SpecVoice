import type { Session } from '@/lib/session/types'
import type { CodeSource } from '@/lib/code/types'
import { GitHubCodeSource } from '@/lib/code/github-source'
import { LocalCodeSource } from '@/lib/code/local-source'
import { InMemoryCodeSource } from '@/lib/code/in-memory-source'
import { createHotReloadSafeSingleton } from '@/lib/singleton'

export { InMemoryCodeSource }

const codeSourceRegistry = createHotReloadSafeSingleton(
  '__codeSourceRegistry',
  () => new Map<string, CodeSource>()
)

export function registerCodeSource(sessionId: string, source: CodeSource): () => void {
  codeSourceRegistry.set(sessionId, source)
  return () => codeSourceRegistry.delete(sessionId)
}

export function resolveCodeSource(session: Session): CodeSource {
  const override = codeSourceRegistry.get(session.id)
  if (override) return override
  if (session.repoUrl) {
    return new GitHubCodeSource(session.repoUrl, process.env.GITHUB_TOKEN)
  }
  if (session.repoLocalPath) {
    return new LocalCodeSource(session.repoLocalPath)
  }
  throw new Error(
    `Session ${session.id} has no code source configured. ` +
      'Set repoUrl or repoLocalPath when creating the session via POST /api/sessions.'
  )
}
