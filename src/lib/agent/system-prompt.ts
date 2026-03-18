import { readFileSync } from 'fs'
import { join } from 'path'

export const systemPrompt = readFileSync(join(process.cwd(), 'docs/system-prompt.md'), 'utf-8')
