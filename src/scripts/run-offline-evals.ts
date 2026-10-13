import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateOfflineCase, loadOfflineEvalCases } from '@/lib/evals/offline'

export interface OfflineEvalReport {
  schemaVersion: 1
  source: { commit: string | null; dirty: boolean | null }
  dataset: { sha256: string | null; fileCount: number }
  prompt: { sha256: string | null }
  startedAt: string
  completedAt: string
  cases: Array<{ id: string; status: 'passed' | 'failed'; assertionFailures: string[]; latencyMs: number }>
  totals: { cases: number; passed: number; failed: number; latencyMs: number }
  errors: string[]
}

export async function runOfflineEvalReport(root = process.cwd()): Promise<OfflineEvalReport> {
  const start = performance.now()
  const report: OfflineEvalReport = {
    schemaVersion: 1,
    source: { commit: null, dirty: null },
    dataset: { sha256: null, fileCount: 0 },
    prompt: { sha256: null },
    startedAt: new Date().toISOString(),
    completedAt: '',
    cases: [],
    totals: { cases: 0, passed: 0, failed: 0, latencyMs: 0 },
    errors: [],
  }
  try {
    const git = (args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    const commit = git(['rev-parse', '--verify', 'HEAD'])
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid source commit')
    report.source = { commit, dirty: git(['status', '--porcelain', '--untracked-files=normal']).length > 0 }
  } catch {
    report.errors.push('Source revision could not be determined')
  }
  const directory = join(root, 'evals', 'cases')
  try {
    const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort()
    const dataset = createHash('sha256')
    for (const name of names) {
      const content = await readFile(join(directory, name))
      dataset
        .update(`${Buffer.byteLength(name)}\0`)
        .update(name)
        .update(`${content.length}\0`)
        .update(content)
    }
    report.dataset = { sha256: dataset.digest('hex'), fileCount: names.length }
  } catch {
    report.errors.push('Dataset version could not be determined')
  }
  try {
    report.prompt.sha256 = createHash('sha256')
      .update(await readFile(join(root, 'docs', 'system-prompt.md')))
      .digest('hex')
  } catch {
    report.errors.push('Prompt version could not be determined')
  }
  if (process.env.DATABASE_URL || process.env.NODE_ENV === 'production') {
    report.errors.push('Offline evaluations require isolated memory storage')
  } else {
    try {
      const cases = await loadOfflineEvalCases(directory)
      for (const fixture of cases) {
        const caseStart = performance.now()
        let assertionFailures: string[]
        try {
          assertionFailures = (await evaluateOfflineCase(fixture)).map(failure => {
            // Expected/actual values may contain repository data; publish only the application's assertion label.
            const prefix = `${fixture.id}: `
            const assertion = failure.startsWith(prefix) ? failure.slice(prefix.length).split(': expected ')[0] : ''
            return /^[A-Za-z][A-Za-z -]{0,63}$/.test(assertion) ? assertion : 'Unclassified assertion failure'
          })
        } catch {
          assertionFailures = ['Evaluation execution failed']
        }
        report.cases.push({
          id: fixture.id,
          status: assertionFailures.length ? 'failed' : 'passed',
          assertionFailures,
          latencyMs: performance.now() - caseStart,
        })
      }
    } catch {
      report.errors.push('Dataset schema validation failed')
    }
  }
  report.completedAt = new Date().toISOString()
  report.totals = {
    cases: report.cases.length,
    passed: report.cases.filter(result => result.status === 'passed').length,
    failed: report.cases.filter(result => result.status === 'failed').length,
    latencyMs: performance.now() - start,
  }
  const output = join(root, 'artifacts', 'evals')
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'offline.json'), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

export async function main(): Promise<void> {
  const report = await runOfflineEvalReport()
  console.log(
    `Offline evaluations: ${report.totals.passed} passed, ${report.totals.failed} failed; ${report.errors.length} setup errors`
  )
  console.log('Report: artifacts/evals/offline.json')
  if (report.totals.failed || report.errors.length) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    console.error('Offline evaluation report could not be saved')
    process.exitCode = 1
  })
