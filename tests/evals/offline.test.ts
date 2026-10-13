import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { EvalCaseSchema, loadOfflineEvalCases, evaluateOfflineCase, runOfflineEvaluations } from '@/lib/evals/offline'
import { toolRegistry } from '@/lib/api/tool-registry'

afterEach(() => vi.restoreAllMocks())
describe('offline fixture schema', () => {
  it('loads unique, typed fixtures and rejects descriptive-only assertions', async () => {
    const cases = await loadOfflineEvalCases()
    expect(new Set(cases.map(item => item.id)).size).toBe(cases.length)
    expect(
      EvalCaseSchema.safeParse({
        id: 'words-only',
        prompt: 'reject injection',
        expected: { rejectsPromptInjection: true },
      }).success
    ).toBe(false)
  })
})
describe('offline application evaluations', () => {
  it('executes tool permissions, capabilities, scope and Build gates without providers', async () => {
    await expect(runOfflineEvaluations()).resolves.toEqual({ count: 5 })
  })
  it('fails when application transport returns success without honoring the contract', async () => {
    vi.spyOn(toolRegistry, 'dispatch').mockImplementation(async () => NextResponse.json({}))
    const [fixture] = await loadOfflineEvalCases()
    const failures = await evaluateOfflineCase(fixture)
    expect(failures.some(failure => failure.includes('capability denial'))).toBe(true)
    expect(failures.some(failure => failure.includes('permitted listing'))).toBe(true)
  })
  it('detects a contradictory Build assertion instead of trusting fixture prose', async () => {
    const fixture = (await loadOfflineEvalCases()).find(item => item.id === 'partial-profile')!
    const failures = await evaluateOfflineCase({ ...fixture, expected: { ...fixture.expected, buildAllowed: true } })
    expect(failures).toContain('partial-profile: Build gate: expected true, received false')
  })
})
