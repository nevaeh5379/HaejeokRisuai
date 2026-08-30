import { test as base, expect } from "@playwright/test";

/**
 * Shared Playwright fixture.
 *
 * This is a light customisation of the built-in Playwright `test` object.
 * It keeps a copy-paste snippet out of every test and shows the standard
 * pattern of extending fixtures via `base.extend()`.
 *
 * Why we touch `context`:
 *   On the very first boot the app opens a "Terms of Use" modal
 *   (`src/ts/alert.ts` -> `alertTOS`). Acceptance is stored in
 *   localStorage under the key below, and pre-filling it before any page
 *   script runs makes `alertTOS()` return immediately without rendering
 *   a modal that would block clicks on the app underneath.
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      localStorage.setItem("haejeok_tos_2026_08_23", "true");
    });
    await use(context);
  },
});

// Re-export so spec files can `import { test, expect } from "./fixtures"`
export { expect };