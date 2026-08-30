# E2E Tests (Playwright)

End-to-end tests drive a real browser against the app served by the Vite
dev server. This is a short guide for developers new to Playwright.

## First-time setup

```bash
pnpm install                   # installs @playwright/test
pnpm exec playwright install chromium   # downloads the browser binary
```

If Chromium fails to launch on Linux with "missing libraries" errors, run
`pnpm exec playwright install-deps chromium` (requires sudo) to install the
system packages Playwright needs.

## Running tests

| Command | What it does |
|---------|--------------|
| `pnpm test:e2e` | Run all tests headlessly: starts/upgrades the Vite dev server on port 5174 automatically, then opens Chromium. |
| `pnpm test:e2e:headed` | Same, but with a visible browser window — great while writing a test. |
| `pnpm test:e2e:ui` | Interactive UI mode: pick tests, watch them step-by-step, inspect DOM snapshots. Recommended for debugging. |
| `pnpm test:e2e:report` | Open the HTML report of the last run (also contains traces for failing tests when `trace: "retain-on-failure"` is set). |

You do **not** need to run `pnpm dev` yourself: `webServer` in
`playwright.config.ts` starts it for you and reuses an already-running
instance (locally only; on CI it always starts a fresh one).

## Where things live

```
e2e/
├── fixtures.ts        shared `test` fixture (accepts the TOS modal up-front)
├── app.spec.ts        smoke tests — does the app boot at all?
└── welcome.spec.ts    interaction test — first-run welcome flow
playwright.config.ts   runner/browser/dev-server configuration
```

## Writing tests — crash course

A test is a function that receives fixtures. The two you will use first:

```ts
import { expect, test } from "./fixtures";

test("my first e2e test", async ({ page }) => {
  await page.goto("/");               // opens http://127.0.0.1:5174
  await page.getByText("Quick AI Setup").click();  // auto-waits until clickable
  await expect(page.getByPlaceholder(/Enter your nickname/i)).toBeVisible();
});
```

Key ideas that prevent most beginner pain:

1. **Never wait manually.** `expect(locator).toBeVisible()` and every
   `locator` action retry until an inner timeout (30s by default). Avoid
   `sleep()`/`waitForTimeout()` — they are flaky and slow.
2. **Prefer user-facing locators** (`getByRole`, `getByText`,
   `getByPlaceholder`, `getByLabel`) over CSS selectors; they survive class
   name refactors and behave closer to how users find things.
3. **Strictness**: a locator must match exactly one element for actions.
   Narrow it down (e.g. `page.getByRole("button", { name: "Back" })`) or
   use `.first()` when several siblings legitimately match the same text.
4. **Tests are isolated.** Each test gets a new browser context — empty
   localStorage/IndexedDB/cookies. That is why the app shows the first-run
   welcome screen in every test. Set storage with
   `context.addInitScript(...)` in `e2e/fixtures.ts` when a test needs it.
5. **Debug failing runs** with `pnpm test:e2e:report`, which replays a
   trace: DOM snapshots, console output and network per step.

Good first targets for new tests in this app: creating a character, opening
the settings screen, switching themes, and saving/loading backups.