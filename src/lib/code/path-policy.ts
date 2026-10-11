import fs from 'fs'
import path from 'path'

export function isWithinDirectory(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function resolveWithExistingParent(candidatePath: string): string {
  let current = path.resolve(candidatePath)
  const suffix: string[] = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(candidatePath)
    suffix.unshift(path.basename(current))
    current = parent
  }
  return path.join(fs.realpathSync(current), ...suffix)
}

export function validateLocalRepoPath(
  repoLocalPath: string
): { ok: true; path: string } | { ok: false; error: string } {
  if (!path.isAbsolute(repoLocalPath)) {
    return { ok: false, error: 'repoLocalPath must be an absolute path.' }
  }

  const allowedRoot =
    process.env.SPECVOICE_LOCAL_REPO_ROOT || (process.env.NODE_ENV === 'production' ? undefined : process.cwd())
  if (!allowedRoot) {
    return { ok: false, error: 'Local repositories are disabled until SPECVOICE_LOCAL_REPO_ROOT is configured.' }
  }

  const resolvedRoot = resolveWithExistingParent(allowedRoot)
  const resolvedPath = path.resolve(repoLocalPath)
  const pathForCheck = resolveWithExistingParent(resolvedPath)
  if (!isWithinDirectory(resolvedRoot, pathForCheck)) {
    return { ok: false, error: 'repoLocalPath must be inside SPECVOICE_LOCAL_REPO_ROOT.' }
  }

  return { ok: true, path: resolvedPath }
}

export function assertLocalRepoPathAllowed(repoLocalPath: string): string {
  const result = validateLocalRepoPath(repoLocalPath)
  if (result.ok) return result.path
  if (process.env.NODE_ENV !== 'production' && !process.env.SPECVOICE_LOCAL_REPO_ROOT)
    return path.resolve(repoLocalPath)
  throw new Error(result.error)
}
