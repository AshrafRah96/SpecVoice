import { z } from 'zod'

const envSchema = z.object({
  ELEVENLABS_API_KEY: z.string().min(1, 'ELEVENLABS_API_KEY is required'),
  GITHUB_TOKEN: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().default('http://localhost:3000'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const missing = parsed.error.issues
    .map(i => `${i.path.join('.')}: ${i.message}`)
    .join('\n')
  throw new Error(`Missing or invalid environment variables:\n${missing}\nCheck .env.local`)
}

export const env = parsed.data
