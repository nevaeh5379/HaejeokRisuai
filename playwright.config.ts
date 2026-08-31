import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E test configuration.
 *
 * How it works:
 *  - Tests live in the `./e2e` directory and are named `*.spec.ts`.
 *  - `webServer` automatically starts the Vite dev server (`pnpm run dev`)
 *    before tests run and reuses it if it is already running, so you never
 *    have to start the server manually.
 *  - The dev server listens on port 5174 (see vite.config.ts `server.port`)
 *    and sets the COOP/COEP headers required by the OPFS-backed SQLite
 *    storage, so the app boots exactly like it does for real users.
 *
 * Useful commands:
 *  - pnpm test:e2e             run all tests headlessly
 *  - pnpm test:e2e:headed      run tests with a visible browser window
 *  - pnpm test:e2e:ui          interactive UI mode (recommended for debugging)
 *  - pnpm test:e2e:report      open the HTML report of the last run
 */
export default defineConfig({
  // Folder containing the test files
  testDir: "./e2e",

  // Run test files in parallel for speed. Each test gets its own browser
  // context (fresh storage), so parallelism is safe here.
  fullyParallel: true,

  // Fail if `test.only` is committed to CI by accident
  forbidOnly: !!process.env.CI,

  // Retry flaky tests on CI only
  retries: process.env.CI ? 2 : 0,

  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["html", { open: "never" }]],

  use: {
    // All pages default to the Vite dev server used for local development
    baseURL: "http://127.0.0.1:5174",

    // Collect a trace (screenshot + DOM snapshots + network + console)
    // for failing tests — open it with `pnpm test:e2e:report`.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  // Browser matrix. Firefox / WebKit are commented out to keep the first
  // run fast; uncomment to run the same tests on more browsers.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // {
    //   name: "firefox",
    //   use: { ...devices["Desktop Firefox"] },
    // },
    // {
    //   name: "webkit",
    //   use: { ...devices["Desktop Safari"] },
    // },
  ],

  webServer: {
    command: "./node_modules/.bin/vite",
    url: "http://127.0.0.1:5174",
    // Vite cold-start of this app can take a while
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
    env: {
      // Vite exposes process env vars with the VITE_ prefix to the client via
      // `import.meta.env`. Without this the app renders the "Legal documents
      // not configured" screen (src/lib/Others/Legal.svelte, used by
      // src/App.svelte) instead of the real UI and every test would fail.
      // Setting it here only affects the dev server that Playwright starts
      // for testing — production builds are not affected. The Legal notice
      // explicitly allows enabling this flag for private-use forks and for
      // forks used for testing and development.
      ...process.env,
      VITE_RISU_LEGAL_CONFIGURED: "TRUE",
    },
  },
});