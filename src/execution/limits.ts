/** One total deadline across the worker, model credential and disposable container. */
export function executionDeadlineMs(): number {
  const value = Number(process.env.SPECVOICE_EXECUTION_DEADLINE_MS ?? 30 * 60 * 1000)
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw new Error('Invalid SPECVOICE_EXECUTION_DEADLINE_MS')
  return value
}
