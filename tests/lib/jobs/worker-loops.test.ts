import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWorkerLoops, type WorkerLoopCallbacks } from '@/lib/jobs/worker-loops'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function callbacks() {
  return {
    build: vi.fn<WorkerLoopCallbacks['build']>().mockResolvedValue(false),
    profile: vi.fn<WorkerLoopCallbacks['profile']>().mockResolvedValue(false),
    postCall: vi.fn<WorkerLoopCallbacks['postCall']>().mockResolvedValue(false),
    heartbeat: vi.fn<WorkerLoopCallbacks['heartbeat']>().mockResolvedValue(undefined),
    onError: vi.fn<WorkerLoopCallbacks['onError']>(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('worker loops', () => {
  it('runs hourly retention without delaying heartbeat or overlapping cleanup', async () => {
    const shutdown = new AbortController()
    const maintenance = deferred<void>()
    const work = {
      ...callbacks(),
      maintenance: vi
        .fn()
        .mockImplementationOnce(() => maintenance.promise)
        .mockResolvedValue(undefined),
    }
    const done = runWorkerLoops(work, shutdown.signal)
    await vi.advanceTimersByTimeAsync(10000)
    expect(work.maintenance).toHaveBeenCalledTimes(1)
    expect(work.heartbeat).toHaveBeenCalledTimes(3)
    maintenance.resolve()
    await vi.advanceTimersByTimeAsync(3600000)
    expect(work.maintenance).toHaveBeenCalledTimes(2)
    shutdown.abort()
    await done
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps profiling, receipts and heartbeats moving while one build is running', async () => {
    const shutdown = new AbortController()
    const work = callbacks()
    const build = deferred<boolean>()
    work.build.mockImplementationOnce(() => build.promise)
    const done = runWorkerLoops(work, shutdown.signal)

    await vi.advanceTimersByTimeAsync(5000)
    expect(work.build).toHaveBeenCalledTimes(1)
    expect(work.profile).toHaveBeenCalledTimes(6)
    expect(work.postCall).toHaveBeenCalledTimes(6)
    expect(work.heartbeat).toHaveBeenCalledTimes(2)
    expect(work.build).toHaveBeenCalledWith(shutdown.signal)
    expect(work.profile).toHaveBeenCalledWith(shutdown.signal)
    expect(work.postCall).toHaveBeenCalledWith(shutdown.signal)

    let stopped = false
    void done.then(() => {
      stopped = true
    })
    shutdown.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)
    expect(shutdown.signal.aborted).toBe(true)
    build.resolve(false)
    await done
    expect(stopped).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never overlaps work within any lane, including heartbeat', async () => {
    const shutdown = new AbortController()
    const work = callbacks()
    const build = deferred<boolean>()
    const profile = deferred<boolean>()
    const postCall = deferred<boolean>()
    const heartbeat = deferred<void>()
    work.build.mockImplementationOnce(() => build.promise)
    work.profile.mockImplementationOnce(() => profile.promise)
    work.postCall.mockImplementationOnce(() => postCall.promise)
    work.heartbeat.mockImplementationOnce(() => heartbeat.promise)
    const done = runWorkerLoops(work, shutdown.signal)

    await vi.advanceTimersByTimeAsync(60_000)
    for (const fn of [work.build, work.profile, work.postCall, work.heartbeat]) expect(fn).toHaveBeenCalledTimes(1)
    build.resolve(false)
    profile.resolve(false)
    postCall.resolve(false)
    heartbeat.resolve()
    await vi.advanceTimersByTimeAsync(1000)
    for (const fn of [work.build, work.profile, work.postCall]) expect(fn).toHaveBeenCalledTimes(2)
    expect(work.heartbeat).toHaveBeenCalledTimes(1)
    shutdown.abort()
    await done
  })

  it('backs off failures up to thirty seconds and resets after success', async () => {
    const shutdown = new AbortController()
    const work = callbacks()
    const attempts: number[] = []
    const unavailable = new Error('Database unavailable')
    work.build.mockImplementation(async () => {
      attempts.push(Date.now())
      if (attempts.length <= 8 || attempts.length === 10) throw unavailable
      return false
    })
    const done = runWorkerLoops(work, shutdown.signal)
    await vi.advanceTimersByTimeAsync(123_000)
    expect(attempts).toEqual([0, 1000, 3000, 7000, 15_000, 31_000, 61_000, 91_000, 121_000, 122_000, 123_000])
    expect(work.onError).toHaveBeenCalledTimes(9)
    expect(work.onError).toHaveBeenLastCalledWith('build', unavailable)
    expect(work.postCall).toHaveBeenCalledTimes(124)
    shutdown.abort()
    await done
  })

  it('retries failed heartbeats independently and returns to the five-second interval', async () => {
    const shutdown = new AbortController()
    const work = callbacks()
    const unavailable = new Error('Heartbeat write failed')
    work.heartbeat.mockRejectedValueOnce(unavailable)
    const done = runWorkerLoops(work, shutdown.signal)
    await vi.advanceTimersByTimeAsync(999)
    expect(work.heartbeat).toHaveBeenCalledTimes(1)
    expect(work.onError).toHaveBeenCalledWith('heartbeat', unavailable)
    await vi.advanceTimersByTimeAsync(1)
    expect(work.heartbeat).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4999)
    expect(work.heartbeat).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(work.heartbeat).toHaveBeenCalledTimes(3)
    expect(work.profile).toHaveBeenCalledTimes(7)
    shutdown.abort()
    await done
  })

  it('interrupts idle waits immediately without advancing time or leaving timers', async () => {
    const shutdown = new AbortController()
    const work = callbacks()
    const done = runWorkerLoops(work, shutdown.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(4)
    shutdown.abort()
    await done
    expect(Date.now()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    for (const fn of [work.build, work.profile, work.postCall, work.heartbeat]) expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not start callbacks after shutdown or report expected cancellation as a failure', async () => {
    const shutdown = new AbortController()
    const work = callbacks()
    work.build.mockImplementation(
      signal =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const done = runWorkerLoops(work, shutdown.signal)
    shutdown.abort()
    await done
    expect(work.onError).not.toHaveBeenCalled()
    const alreadyStopped = callbacks()
    await runWorkerLoops(alreadyStopped, shutdown.signal)
    for (const fn of [alreadyStopped.build, alreadyStopped.profile, alreadyStopped.postCall, alreadyStopped.heartbeat])
      expect(fn).not.toHaveBeenCalled()
  })

  it('takes available work again without imposing the empty-queue poll delay', async () => {
    const shutdown = new AbortController()
    const work = callbacks()
    work.postCall.mockResolvedValueOnce(true)
    const done = runWorkerLoops(work, shutdown.signal)
    await vi.advanceTimersByTimeAsync(1)
    expect(work.postCall).toHaveBeenCalledTimes(2)
    expect(work.build).toHaveBeenCalledTimes(1)
    shutdown.abort()
    await done
  })
})
