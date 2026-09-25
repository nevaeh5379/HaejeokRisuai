import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

async function waitForAppReady(page: Page) {
  await page.goto("/");
  await page.waitForFunction(
    () =>
      !!document.body &&
      !document.body.innerText.includes("Initialising Database") &&
      !!navigator.serviceWorker.controller,
    undefined,
    { timeout: 120_000 },
  );

  const skipButton = page.getByRole("button", {
    name: /Skip & Explore|직접 설정할래요/i,
  });
  await skipButton.waitFor({ state: "visible", timeout: 30_000 });
  await skipButton.click();

  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("Initialising Database") &&
      !document.body.innerText.includes("Welcome to Haejeok RisuAI"),
    undefined,
    { timeout: 30_000 },
  );

  await expect(page.getByText("Loading...")).toHaveCount(0, { timeout: 30_000 });
}

test.describe("branch foreign key constraint violation reproduction", () => {
  test("reproduce SQLite foreign key constraint failure in WebSqliteStorage", async ({
    page,
  }) => {
    await waitForAppReady(page);

    await page.route("https://api.anthropic.com/**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: {
          id: "msg_123",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello! I am a bot." }],
          model: "claude-3-haiku-20240307",
          stop_reason: "end_turn",
        },
      });
    });
    await page.route("https://api.openai.com/**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: {
          id: "chatcmpl-123",
          object: "chat.completion",
          choices: [
            {
              message: { role: "assistant", content: "Hello! I am a bot." },
              finish_reason: "stop",
            },
          ],
        },
      });
    });

    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => {
      console.log("PAGEERROR:", err);
      pageErrors.push(err);
    });
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // 1. Directly create a character via the user interface (UI-driven E2E)
    const addCharacterButton = page
      .locator("button:has(svg path[d*='M12 6v6m0 0v6m0-6h6m-6 0H6'])")
      .first();
    await addCharacterButton.waitFor({ state: "visible", timeout: 30_000 });
    await addCharacterButton.click();

    const createFromScratchButton = page.getByRole("button", {
      name: /Create from Scratch|새 캐릭터 생성/i,
    });
    await createFromScratchButton.waitFor({ state: "visible", timeout: 10_000 });
    await createFromScratchButton.click();

    const characterOptionButton = page.getByRole("button", {
      name: /Character|캐릭터/i,
      exact: true,
    });
    await characterOptionButton.waitFor({ state: "visible", timeout: 10_000 });
    await characterOptionButton.click();

    // 2. Wait for character to be created and active
    await page.waitForFunction(async () => {
      const domainUrl = "/src/ts/stores/domain/index.ts";
      const { characterStore } = (await import(domainUrl)) as {
        characterStore: { characters: Array<{ chaId: string; chats: Array<{ id?: string }> }> };
      };
      return characterStore.characters.length > 0;
    });

    // Wait for chat input area to be visible
    const chatInput = page.locator("textarea.text-input-area");
    await chatInput.waitFor({ state: "visible", timeout: 15_000 });

    // Send a message via UI
    await chatInput.fill("Hello from user");
    const sendButton = page.locator(".button-icon-send");
    await sendButton.waitFor({ state: "visible", timeout: 10_000 });
    await sendButton.click();

    // Wait for the first generation attempt to finish (e.g. mock response)
    await expect(page.locator(".loadmove")).toHaveCount(0, { timeout: 15_000 });

    // Wait for the reroll arrow button to appear on the message
    const rerollButton = page.locator(".button-icon-reroll").first();
    await rerollButton.waitFor({ state: "visible", timeout: 15_000 });

    // Click the reroll button directly in the UI (this triggers createRerollBranch via UI)
    await rerollButton.click();

    // Verify that SQLite foreign key constraint violation was triggered via UI interaction
    await expect.poll(() => {
      return (
        pageErrors.some(
          (err) =>
            err.message.includes("SQLITE_CONSTRAINT_FOREIGNKEY") ||
            err.message.includes("FOREIGN KEY constraint failed"),
        ) ||
        consoleErrors.some(
          (text) =>
            text.includes("SQLITE_CONSTRAINT_FOREIGNKEY") ||
            text.includes("FOREIGN KEY constraint failed"),
        )
      );
    }, { timeout: 10_000 }).toBe(true);
  });

  // TODO: Add an end-to-end / UI-driven reproduction for PostgreSQL storage
  // once the Node.js backend server environment is connected with the Playwright test runner.
  // The current web E2E environment runs against the browser-local WebSqliteStorage (WASM/OPFS).
});
