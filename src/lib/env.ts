import { z } from 'zod'

const envSchema = z.object({
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().default('http://localhost:3000'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ELEVENLABS_WEBHOOK_SECRET: z.string().optional(),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const missing = parsed.error.issues
    .map(i => `${i.path.join('.')}: ${i.message}`)
    .join('\n')
  throw new Error(`Missing or invalid environment variables:\n${missing}\nCheck .env.local`)
}

export const env = parsed.data
