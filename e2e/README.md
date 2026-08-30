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
| `pnpm test:e2e:codegen` | Open the **recorder**: a real browser where your clicks/typing are transcribed into test code live (see below). |
| `pnpm test:e2e:report` | Open the HTML report of the last run (also contains traces for failing tests when `trace: "retain-on-failure"` is set). |

You do **not** need to run `pnpm dev` yourself: `webServer` in
`playwright.config.ts` starts it for you and reuses an already-running
instance (locally only; on CI it always starts a fresh one).

## Recording new tests (codegen)

Writing every step by hand is the hard way. Playwright ships a recorder
that watches you use the app and writes the test code for you:

```bash
pnpm test:e2e:codegen
```

What happens:

1. A Vite dev server is started on port 5174 if none is running (started
   with `VITE_RISU_LEGAL_CONFIGURED=TRUE`, same as the test runner).
2. A normal Chromium window plus a small **Playwright Inspector** panel
   opens.
3. Every click, typed character and navigation you perform in the browser
   appears in the Inspector as TypeScript test code, e.g.
   `await page.getByText("Quick AI Setup").click();`.

Workflow:

1. Record the user journey you want to test.
2. Copy the generated code from the Inspector into a new
   `e2e/<name>.spec.ts` file with a real test name.
3. Replace raw recorded clicks with **assertions**. The Inspector has an
   "Assert" dropdown (pick element, then choose `assert visible`,
   `assert text`, …) that generates lines such as

   ```ts
   await expect(page.getByText("Quick AI Setup")).toBeVisible();
   ```

4. Adjust imports to use the shared fixture and run it:

   ```ts
   import { expect, test } from "./fixtures";
   ```

Two app-specific notes while recording:

- The recorder browser has empty storage, so you will land on the
  first-run welcome screen with the Terms-of-Use modal. Simply click its
  **Accept** button as part of the recording (the legal gateway screen is
  bypassed automatically because the dev server is started with
  `VITE_RISU_LEGAL_CONFIGURED=TRUE`).
- Because each test gets a fresh context, the TOS acceptance seen while
  recording does not carry over to the tests — either click Accept inside
  the recorded flow, or silence it for a test by copying the
  `localStorage.setItem("haejeok_tos_2026_08_23", "true")` pattern from
  `e2e/fixtures.ts`.

Tip for VS Code users: installing the official *Playwright Test for
VS Code* extension adds **Record at cursor**, which does the same thing
directly inside the editor and writes code into the open spec file.

## Where things live

```
e2e/
├── fixtures.ts        shared `test` fixture (accepts the TOS modal up-front)
├── app.spec.ts        smoke tests — does the app boot at all?
└── welcome.spec.ts    interaction test — first-run welcome flow
playwright.config.ts   runner/browser/dev-server configuration
tooling/e2e-codegen.ts helper that opens the test recorder (codegen)
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