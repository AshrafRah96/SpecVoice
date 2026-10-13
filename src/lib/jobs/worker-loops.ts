export type WorkerLane = 'build' | 'profile' | 'postCall' | 'heartbeat' | 'maintenance'

export interface WorkerLoopCallbacks {
  build(signal: AbortSignal): Promise<boolean>
  profile(signal: AbortSignal): Promise<boolean>
  postCall(signal: AbortSignal): Promise<boolean>
  heartbeat(): Promise<void>
  maintenance?(): Promise<void>
  onError(lane: WorkerLane, error: unknown): void
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

export async function runWorkerLoops(callbacks: WorkerLoopCallbacks, signal: AbortSignal): Promise<void> {
  const lanes: WorkerLane[] = ['build', 'profile', 'postCall', 'heartbeat']
  if (callbacks.maintenance) lanes.push('maintenance')
  await Promise.all(
    lanes.map(async lane => {
      let backoff = 1000
      while (!signal.aborted) {
        let delay: number
        try {
          if (lane === 'maintenance') {
            await callbacks.maintenance!()
            delay = 60 * 60 * 1000
          } else if (lane === 'heartbeat') {
            await callbacks.heartbeat()
            delay = 5000
          } else {
            const worked = await callbacks[lane](signal)
            // Yield even when work remains, so immediate completions cannot starve shutdown or heartbeats.
            delay = worked ? 0 : 1000
          }
          backoff = 1000
        } catch (error) {
          if (signal.aborted) break
          callbacks.onError(lane, error)
          delay = backoff
          backoff = Math.min(backoff * 2, 30_000)
        }
        await wait(delay, signal)
      }
    })
  )
}
