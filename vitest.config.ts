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
    },
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['vitest.setup.ts'],
  },
})
