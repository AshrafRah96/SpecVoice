import { defineConfig } from 'vitest/config'
import path from 'node:path'
export default defineConfig({
  test: { include: ['tests/integration/**/*.test.ts'], fileParallelism: false, testTimeout: 15000, hookTimeout: 30000 },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
})
