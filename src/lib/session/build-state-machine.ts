import type { BuildStatus } from '@/lib/session/types'

const VALID_TRANSITIONS: Record<BuildStatus, BuildStatus[]> = {
  idle: ['ready'],
  ready: ['building'],
  building: ['ready', 'complete', 'failed'],
  complete: ['ready'],
  failed: ['ready', 'building'],
}

export function guardBuildTransition(from: BuildStatus, to: BuildStatus, sessionId: string): void {
  if (from === to) return
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid BuildStatus transition: ${from} → ${to} (session ${sessionId})`)
  }
}
