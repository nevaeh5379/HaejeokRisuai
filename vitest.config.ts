import { resolve } from 'node:path'
import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    svelte(),
  ],
  resolve: {
    alias: {
      src: '/src',
      '@risuai/chat-core': resolve(process.cwd(), 'packages/chat-core'),
      '@risuai/protocol': resolve(process.cwd(), 'packages/protocol'),
      '@risuai/backup-core': resolve(process.cwd(), 'packages/backup-core'),
      '@risuai/hypa-v3': resolve(process.cwd(), 'packages/hypa-v3/src'),
    },
    conditions: ['browser'],
  },
  test: {
    include: [
      'src/**/*.test.ts',
      'server/**/*.test.ts',
      'packages/hypa-v3/src/**/*.test.ts',
    ],
    environment: 'happy-dom',
    setupFiles: ['vitest.setup.ts'],
  },
})
