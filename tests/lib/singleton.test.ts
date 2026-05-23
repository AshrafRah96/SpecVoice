import { describe, it, expect, afterEach } from 'vitest'
import { createHotReloadSafeSingleton } from '@/lib/singleton'

const TEST_KEY = '__test_singleton_vitest__'
const TEST_KEY_2 = '__test_singleton_vitest_2__'

afterEach(() => {
  // Clean up so tests don't leak into each other.
  delete (globalThis as Record<string, unknown>)[TEST_KEY]
  delete (globalThis as Record<string, unknown>)[TEST_KEY_2]
})

describe('createHotReloadSafeSingleton', () => {
  it('returns the value produced by the factory', () => {
    const result = createHotReloadSafeSingleton(TEST_KEY, () => ({ x: 42 }))
    expect(result).toEqual({ x: 42 })
  })

  it('returns the same instance on repeated calls (factory called once)', () => {
    let calls = 0
    const first = createHotReloadSafeSingleton(TEST_KEY, () => { calls++; return {} })
    const second = createHotReloadSafeSingleton(TEST_KEY, () => { calls++; return {} })
    expect(first).toBe(second)
    expect(calls).toBe(1)
  })

  it('returns a fresh instance after the key is deleted (simulates hot reload)', () => {
    const first = createHotReloadSafeSingleton(TEST_KEY, () => ({}))
    delete (globalThis as Record<string, unknown>)[TEST_KEY]
    const second = createHotReloadSafeSingleton(TEST_KEY, () => ({}))
    expect(first).not.toBe(second)
  })

  it('two different keys are independent', () => {
    const a = createHotReloadSafeSingleton(TEST_KEY, () => ({ label: 'a' }))
    const b = createHotReloadSafeSingleton(TEST_KEY_2, () => ({ label: 'b' }))
    expect(a).not.toBe(b)
    expect(a.label).toBe('a')
    expect(b.label).toBe('b')
  })

  it('works with Map (the sourceCache pattern)', () => {
    const map = createHotReloadSafeSingleton(TEST_KEY, () => new Map<string, number>())
    map.set('foo', 1)
    const same = createHotReloadSafeSingleton(TEST_KEY, () => new Map<string, number>())
    expect(same.get('foo')).toBe(1)
  })
})
