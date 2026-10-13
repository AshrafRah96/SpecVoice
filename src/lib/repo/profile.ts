import { setImmediate } from 'node:timers/promises'
import type { CodeSource, CodeOptions } from '@/lib/code/types'
import { operationBudget } from '@/lib/code/budget'
import type { RepositoryProfile, RepositoryTier } from '@/lib/session/types'
import { repositoryPath } from '@/lib/code/scope'

export interface ProfileLimits {
  smallMaxFiles: number
  smallMaxBytes: number
  midMaxFiles: number
  midMaxBytes: number
  largeMaxFiles: number
  largeMaxBytes: number
  maxFiles: number
  maxBytes: number
  maxDurationMs: number
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function profileLimits(): ProfileLimits {
  return {
    smallMaxFiles: numberEnv('SPECVOICE_PROFILE_SMALL_MAX_FILES', 5000),
    smallMaxBytes: numberEnv('SPECVOICE_PROFILE_SMALL_MAX_BYTES', 50_000_000),
    midMaxFiles: numberEnv('SPECVOICE_PROFILE_MID_MAX_FILES', 25_000),
    midMaxBytes: numberEnv('SPECVOICE_PROFILE_MID_MAX_BYTES', 250_000_000),
    largeMaxFiles: numberEnv('SPECVOICE_PROFILE_LARGE_MAX_FILES', 100_000),
    largeMaxBytes: numberEnv('SPECVOICE_PROFILE_LARGE_MAX_BYTES', 1_000_000_000),
    maxFiles: numberEnv('SPECVOICE_PROFILE_MAX_FILES', 100_000),
    maxBytes: numberEnv('SPECVOICE_PROFILE_MAX_BYTES', 1_000_000_000),
    maxDurationMs: numberEnv('SPECVOICE_PROFILE_MAX_DURATION_MS', 30_000),
  }
}

function extension(path: string): string {
  const name = path.split('/').at(-1) ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '(none)'
}

function rootOf(path: string): string {
  return path.split('/')[0] ?? path
}

function classify(fileCount: number, byteCount: number, limits: ProfileLimits): RepositoryTier {
  if (fileCount <= limits.smallMaxFiles && byteCount <= limits.smallMaxBytes) return 'small'
  if (fileCount <= limits.midMaxFiles && byteCount <= limits.midMaxBytes) return 'mid'
  if (fileCount <= limits.largeMaxFiles && byteCount <= limits.largeMaxBytes) return 'large'
  return 'very-large'
}

export function repositoryTier(fileCount: number, byteCount: number, limits = profileLimits()): RepositoryTier {
  return classify(fileCount, byteCount, limits)
}

export async function repositoryCommitSha(source: CodeSource, signal?: AbortSignal): Promise<string> {
  const sha = await source.getCommitSha(signal)
  if (!sha) throw new Error('Repository has no immutable commit')
  return sha
}

export async function profileRepository(
  source: CodeSource,
  repositorySha: string,
  limits = profileLimits(),
  now = new Date(),
  options: CodeOptions = {}
): Promise<RepositoryProfile> {
  const started = performance.now()
  const budget = operationBudget({ ...options, limits })
  const listing = await source.listFiles(undefined, { ...options, limits })
  options.signal?.throwIfAborted()
  const files = listing.files
  const languages: Record<string, number> = {}
  const manifests = new Map<string, string>()
  const directoryCounts = new Map<string, number>()
  const generatedRoots = new Set<string>()
  const vendorRoots = new Set<string>()
  let fileCount = 0
  let byteCount = 0
  let processed = 0

  for (const file of files) {
    if (++processed % 256 === 0) await setImmediate()
    options.signal?.throwIfAborted()
    if (performance.now() - started >= limits.maxDurationMs) {
      budget.stop('time')
      break
    }
    if (file.type !== 'file') continue
    if (!budget.take(file.size ?? 0)) break
    const path = file.path
    fileCount += 1
    byteCount += file.size ?? 0
    const ext = extension(path)
    languages[ext] = (languages[ext] ?? 0) + 1
    const root = rootOf(path)
    for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
      const directory = path.slice(0, slash)
      directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1)
    }
    if (['dist', 'build', '.next', 'coverage', 'out'].includes(root)) generatedRoots.add(root)
    if (['vendor', 'node_modules', 'third_party'].includes(root)) vendorRoots.add(root)
    const manifestName = path.split('/').at(-1)
    if (
      manifestName &&
      ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'composer.json'].includes(manifestName)
    ) {
      const packageRoot = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'
      if (!manifests.has(packageRoot)) manifests.set(packageRoot, manifestName)
    }
  }

  const packages = [...manifests.entries()].map(([path, manifest]) => ({
    path: path === '.' ? '' : path,
    manifest: path === '.' ? manifest : `${path}/${manifest}`,
    fileCount: path === '.' ? fileCount : (directoryCounts.get(path) ?? 0),
  }))
  options.signal?.throwIfAborted()
  if (performance.now() - started >= limits.maxDurationMs) budget.stop('time')
  const treeComplete = listing.complete && budget.result().complete
  const indexStatus = treeComplete ? 'ready' : 'partial'
  return {
    repositorySha,
    fileCount,
    byteCount,
    languages,
    packages,
    generatedRoots: [...generatedRoots].sort(),
    vendorRoots: [...vendorRoots].sort(),
    treeComplete,
    indexStatus,
    tier: classify(fileCount, byteCount, limits),
    profiledAt: now.toISOString(),
  }
}

export function validateScopeRoots(roots: string[]): boolean {
  try {
    roots.forEach(repositoryPath)
    return true
  } catch {
    return false
  }
}
