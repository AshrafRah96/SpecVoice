import type { CodeOptions } from './types'

/** Scope entries are literal Git paths, never globs or filesystem paths. */
export function repositoryPath(value: string): string {
  if (
    !value ||
    /[\\\0\r\n*?\[\]!:#]/.test(value) ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid repository path (escapes repository root or uses pattern syntax): ${value}`)
  }
  return value
}
export function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}
export function allowedPath(path: string, scope?: CodeOptions['scope']): boolean {
  repositoryPath(path)
  if (path.split('/').some(part => part === '.git' || part.startsWith('.env'))) return false
  return (
    !scope ||
    ((!scope.includedRoots.length || scope.includedRoots.some(root => under(path, repositoryPath(root)))) &&
      !scope.excludedRoots.some(root => under(path, repositoryPath(root))))
  )
}
export function canTraverse(path: string, scope?: CodeOptions['scope']): boolean {
  repositoryPath(path)
  if (!allowedPath(path)) return false
  if (!scope) return allowedPath(path)
  if (scope.excludedRoots.some(root => under(path, repositoryPath(root)))) return false
  return allowedPath(path, scope) || scope.includedRoots.some(root => under(repositoryPath(root), path))
}
export function assertReadable(path: string, scope?: CodeOptions['scope']) {
  if (!allowedPath(path, scope)) throw new Error(`Path is outside the confirmed Scope Plan: ${path}`)
}
