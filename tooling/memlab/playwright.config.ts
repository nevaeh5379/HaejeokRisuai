import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.MEMLAB_PORT ?? 5186);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: resolve(root, "memlab-results/browser"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  use: {
    baseURL,
    // Playwright's tracing snapshot cache itself retains detached DOM nodes.
    trace: "off",
    screenshot: "only-on-failure",
    launchOptions: process.env.MEMLAB_CHROMIUM
      ? { executablePath: process.env.MEMLAB_CHROMIUM }
      : {},
  },
  webServer: {
    cwd: root,
    command: `"${process.execPath}" "${resolve(root, "node_modules/vite/bin/vite.js")}" --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    timeout: 300_000,
    // A dedicated server and fresh browser context isolate synthetic data.
    reuseExistingServer: false,
    env: {
      ...process.env,
      VITE_RISU_LEGAL_CONFIGURED: "TRUE",
      NODE_SERVER: "false",
      VITE_NODE_SERVER: "false",
    },
  },
});
