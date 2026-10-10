import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
import { buildProtocol } from "./tooling/build-protocol.ts";

buildProtocol();

export default defineConfig({
  plugins: [svelte()],
  oxc: {
    include: [/\.(?:[jt]sx?|cts)(?:$|\?)/],
  },
  resolve: {
    alias: {
      src: "/src",
      "@risuai/chat-core": resolve(process.cwd(), "packages/chat-core"),
      "@risuai/protocol": resolve(process.cwd(), "packages/protocol"),
      "@risuai/storage-core": resolve(
        process.cwd(),
        "packages/storage-core/src",
      ),
      "@risuai/storage-remote": resolve(
        process.cwd(),
        "packages/storage-remote/src",
      ),
      "@risuai/storage-sqlite": resolve(
        process.cwd(),
        "packages/storage-sqlite/src",
      ),
      "@risuai/backup-core": resolve(process.cwd(), "packages/backup-core/src"),
    },
    conditions: ["browser"],
  },
  test: {
    include: [
      "src/**/*.test.ts",
      "server/**/*.test.ts",
      "packages/**/*.test.ts",
    ],
    environment: "happy-dom",
    setupFiles: ["vitest.setup.ts"],
  },
});
