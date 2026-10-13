import type { CodeOptions, Completeness, StopReason } from './types'

export const DISCOVERY_LIMITS = { maxFiles: 100, maxBytes: 5 * 1024 * 1024, maxDurationMs: 10_000 }
export function operationBudget(options: CodeOptions = {}) {
  options.signal?.throwIfAborted()
  const limits = options.limits ?? DISCOVERY_LIMITS
  if (Object.values(limits).some(value => !Number.isFinite(value) || value <= 0))
    throw new Error('Discovery limits must be positive')
  const deadline = AbortSignal.timeout(limits.maxDurationMs)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  let files = 0
  let bytes = 0
  let stopReason: StopReason | undefined
  const takeBytes = (size: number) => {
    options.signal?.throwIfAborted()
    if (deadline.aborted) stopReason = 'time'
    else if (bytes + size > limits.maxBytes) stopReason = 'bytes'
    if (stopReason) return false
    bytes += size
    return true
  }
  return {
    signal,
    limits,
    takeBytes,
    take(size = 0) {
      if (files >= limits.maxFiles) stopReason = 'files'
      if (!takeBytes(size)) return false
      files++
      return true
    },
    stop(reason: StopReason) {
      stopReason ??= reason
    },
    result(): Completeness {
      return { complete: !stopReason, ...(stopReason ? { stopReason } : {}) }
    },
  }
}
