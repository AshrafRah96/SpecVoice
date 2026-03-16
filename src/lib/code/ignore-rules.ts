import ignore from 'ignore'
import { readFileSync, existsSync } from 'fs'
import path from 'path'

export const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'dist',
  'build',
  '.next',
  'coverage',
  '*.pyc',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.DS_Store',
  '.env*',
  '*.min.js',
  '*.min.css',
]

export function createIgnoreFilter(additionalRules: string[] = []) {
  return ignore().add(DEFAULT_EXCLUDES).add(additionalRules)
}

export function loadGitignoreRules(rootPath: string): string[] {
  const gitignorePath = path.join(rootPath, '.gitignore')
  if (!existsSync(gitignorePath)) {
    return []
  }
  return readFileSync(gitignorePath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
}
