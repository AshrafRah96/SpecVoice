import { describe, it, expect } from 'vitest'
import { guardBuildTransition } from '@/lib/session/build-state-machine'
import type { BuildStatus } from '@/lib/session/types'

describe('guardBuildTransition', () => {
  it('allows idle → ready', () => {
    expect(() => guardBuildTransition('idle', 'ready', 'sess-1')).not.toThrow()
  })

  it('allows ready → building', () => {
    expect(() => guardBuildTransition('ready', 'building', 'sess-1')).not.toThrow()
  })

  it('allows building → complete', () => {
    expect(() => guardBuildTransition('building', 'complete', 'sess-1')).not.toThrow()
  })

  it('allows building → failed', () => {
    expect(() => guardBuildTransition('building', 'failed', 'sess-1')).not.toThrow()
  })

  it('allows building → ready (complexity blocked)', () => {
    expect(() => guardBuildTransition('building', 'ready', 'sess-1')).not.toThrow()
  })

  it('allows failed → ready (retry)', () => {
    expect(() => guardBuildTransition('failed', 'ready', 'sess-1')).not.toThrow()
  })

  it('is a no-op when transitioning to the same status', () => {
    expect(() => guardBuildTransition('ready', 'ready', 'sess-1')).not.toThrow()
  })

  it('throws on ready → complete (invalid skip)', () => {
    expect(() => guardBuildTransition('ready', 'complete', 'sess-1')).toThrow(
      /invalid buildstatus transition.*ready.*complete/i
    )
  })

  it('throws on idle → building (skips ready)', () => {
    expect(() => guardBuildTransition('idle', 'building', 'sess-1')).toThrow(
      /invalid buildstatus transition.*idle.*building/i
    )
  })

  it('throws on complete → building (terminal state)', () => {
    expect(() => guardBuildTransition('complete', 'building', 'sess-1')).toThrow(
      /invalid buildstatus transition.*complete.*building/i
    )
  })

  it('throws on complete → failed (terminal state)', () => {
    expect(() => guardBuildTransition('complete', 'failed', 'sess-1')).toThrow(
      /invalid buildstatus transition.*complete.*failed/i
    )
  })

  it('error message includes the session id', () => {
    expect(() => guardBuildTransition('idle', 'failed', 'my-session-id')).toThrow(
      /my-session-id/
    )
  })

  it('same-status is a no-op for all terminal states', () => {
    const terminals: BuildStatus[] = ['complete', 'failed']
    for (const s of terminals) {
      expect(() => guardBuildTransition(s, s, 'sess')).not.toThrow()
    }
  })
})
