/**
 * Returns a process-level singleton that survives Next.js hot reloads.
 * On each module reload the factory is skipped if the key is already set on globalThis.
 */
export function createHotReloadSafeSingleton<T>(key: string, factory: () => T): T {
  const g = globalThis as unknown as Record<string, T | undefined>
  if (g[key] === undefined) g[key] = factory()
  return g[key] as T
}
