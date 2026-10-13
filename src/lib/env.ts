import { z } from 'zod'

const envSchema = z.object({
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.preprocess(value => (value === '' ? undefined : value), z.string().url().optional()),
  ANTHROPIC_API_KEY: z.string().optional(),
  ELEVENLABS_WEBHOOK_SECRET: z.string().optional(),
  SESSION_CAPABILITY_SECRET: z.preprocess(value => (value === '' ? undefined : value), z.string().min(32).optional()),
  SPECVOICE_LOCAL_REPO_ROOT: z.string().optional(),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const missing = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n')
  throw new Error(`Missing or invalid environment variables:\n${missing}\nCheck .env.local`)
}

export const env = parsed.data
