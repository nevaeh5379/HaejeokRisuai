import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Exercise real module lookup, Lua execution, request routing and provider body
// construction. Only the external model HTTP response is replaced.
const OWNER_A = "e2e-rule-owner-a";
const OWNER_B = "e2e-rule-owner-b";
const BACKEND = "e2e-rule-backend";
const PHRASE_A = "Return the unique weather-report schema.";
const PHRASE_B = "Return the unique inventory-report schema.";

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator("#preloading")).toHaveCount(0, {
    timeout: 120_000,
  });
  const skip = page.getByRole("button", {
    name: /Skip & Explore|직접 설정할래요/i,
  });
  if (await skip.isVisible()) await skip.click();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

async function seed(page: Page, rules: boolean) {
  await page.evaluate(
    async ({ OWNER_A, OWNER_B, BACKEND, PHRASE_A, PHRASE_B, rules }) => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { settingsStore } = (await load(
        "/src/ts/stores/domain/settingsStore.svelte.ts",
      )) as typeof import("../src/ts/stores/domain/settingsStore.svelte");
      const { presetStore } = (await load(
        "/src/ts/stores/domain/presetStore.svelte.ts",
      )) as typeof import("../src/ts/stores/domain/presetStore.svelte");
      const { moduleStore } = await load(
        "/src/ts/stores/domain/moduleStore.svelte.ts",
      );
      const { characterStore } = await load(
        "/src/ts/stores/domain/characterStore.svelte.ts",
      );
      const { createBlankChar } = await load("/src/ts/characterDefaults.ts");
      const { changeLanguage } = await load("/src/lang/index.ts");
      await changeLanguage("en");
      settingsStore.state.enableModuleSubModel = true;
      settingsStore.state.usePlainFetch = true;
      settingsStore.state.requestRetrys = 0;
      settingsStore.state.openAIKey = "e2e-not-a-real-key";
      presetStore.state.subModel = "gpt4o";
      presetStore.state.fallbackModels = {
        model: [],
        otherAx: [],
        memory: [],
        emotion: [],
        translate: [],
      };
      const lore = (identifier: string, phrase: string) => ({
        key: "",
        secondkey: "",
        comment: `${identifier}.code`,
        insertorder: 0,
        mode: "normal",
        alwaysActive: false,
        selective: false,
        content: `return function() return {{role="user", content=${JSON.stringify(phrase)}}} end`,
      });
      for (const [id, name, model, identifier, phrase] of [
        [OWNER_A, "Rule Owner A", "gpt4om", "weather", PHRASE_A],
        [OWNER_B, "Rule Owner B", "gpt4o", "inventory", PHRASE_B],
      ]) {
        await moduleStore.installModule({
          id,
          name,
          description: "E2E caller-owned Lua lorebook",
          subModel: model,
          lorebook: [lore(identifier, phrase)],
          subModelRequestRules: rules
            ? [{ enabled: true, phrases: [phrase], sourceModuleId: BACKEND }]
            : [],
        });
      }
      await moduleStore.installModule({
        id: BACKEND,
        name: "Shared E2E Backend",
        description: "Loads another module's Lua and calls the model",
        subModel: "gpt4_turbo",
        lowLevelAccess: true,
        trigger: [
          {
            comment: "Shared backend",
            type: "manual",
            conditions: [],
            lowLevelAccess: true,
            effect: [
              {
                type: "triggerlua",
                code: `
        onButtonClick = async(function(id, action)
          local books = getLoreBooks(id, action .. ".code")
          if #books ~= 1 then error("Expected exactly one owner lorebook") end
          local makePrompt = assert(load(books[1].content))()
          local response = axLLM(id, makePrompt())
          if not response.success then error(response.result) end
        end)
      `,
              },
            ],
          },
        ],
      });
      moduleStore.enabledModules = [OWNER_A, OWNER_B, BACKEND];
      const char = createBlankChar();
      char.name = "Request Rule E2E";
      characterStore.select(characterStore.add(char));
    },
    { OWNER_A, OWNER_B, BACKEND, PHRASE_A, PHRASE_B, rules },
  );
}

async function invoke(page: Page, action: "weather" | "inventory") {
  await page.evaluate(async (action) => {
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { runLuaButtonTrigger } = await load("/src/ts/process/scriptings.ts");
    const { characterStore } = await load(
      "/src/ts/stores/domain/characterStore.svelte.ts",
    );
    await runLuaButtonTrigger(characterStore.currentCharacter, action);
  }, action);
}

async function editOwner(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/ts/stores.svelte.ts";
    const { settingsOpen, SettingsMenuIndex } = await import(
      /* @vite-ignore */ path
    );
    SettingsMenuIndex.set(14);
    settingsOpen.set(true);
  });
  const row = page
    .locator("div.pl-3.pt-3")
    .filter({ hasText: "Rule Owner A" })
    .first();
  await row.locator("button:has(svg.lucide-square-pen)").click();
  await expect(
    page.getByRole("heading", {
      name: "Auxiliary model request rules",
      exact: true,
    }),
  ).toBeVisible();
}

test.describe("shared backend auxiliary request rules", () => {
  test.setTimeout(180_000);
  let requests: { model: string; messages: { content: string }[] }[];
  test.beforeEach(async ({ page, context }) => {
    requests = [];
    await context.route("https://api.openai.com/**", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
          },
        });
        return;
      }
      if (route.request().method() !== "POST") {
        await route.fulfill({ json: { data: [] } });
        return;
      }
      expect(new URL(route.request().url()).pathname).toBe(
        "/v1/chat/completions",
      );
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          id: "e2e-completion",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "mock-result" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });
    });
    await boot(page);
  });

  test("routes each owner's Lua request and preserves the backend on conflict or disabled rules", async ({
    page,
  }) => {
    await seed(page, true);
    await invoke(page, "weather");
    await invoke(page, "inventory");
    expect(requests.map((request) => request.model)).toEqual([
      "gpt-4o-mini",
      "gpt-4o",
    ]);
    expect(
      requests[0].messages.some((message) => message.content === PHRASE_A),
    ).toBe(true);

    await page.evaluate(
      async ({ OWNER_B, PHRASE_A, BACKEND }) => {
        const path = "/src/ts/stores/domain/moduleStore.svelte.ts";
        const { moduleStore } = await import(/* @vite-ignore */ path);
        moduleStore.modules
          .find((module: any) => module.id === OWNER_B)
          .subModelRequestRules.push({
            enabled: true,
            phrases: [PHRASE_A],
            sourceModuleId: BACKEND,
          });
      },
      { OWNER_B, PHRASE_A, BACKEND },
    );
    await invoke(page, "weather");
    expect(requests.at(-1)?.model).toBe("gpt-4-turbo");
    await editOwner(page);
    await page.getByText("Recent request decisions", { exact: true }).click();
    await expect(
      page
        .getByText(
          /Multiple modules matched; existing model selection retained/,
        )
        .first(),
    ).toBeVisible();

    await page.evaluate(async () => {
      const path = "/src/ts/stores/domain/settingsStore.svelte.ts";
      const { settingsStore } = await import(/* @vite-ignore */ path);
      settingsStore.state.enableModuleSubModel = false;
    });
    await invoke(page, "weather");
    expect(requests.at(-1)?.model).toBe("gpt-4o");
    expect(requests).toHaveLength(4);
  });

  test("creates a rule from captured text through the editor and uses it on the next request", async ({
    page,
  }) => {
    await seed(page, false);
    await editOwner(page);
    await page
      .getByRole("button", {
        name: "Capture next 5 auxiliary attempts",
        exact: true,
      })
      .click();
    await invoke(page, "weather");
    expect(requests.at(-1)?.model).toBe("gpt-4-turbo");
    const captured = page
      .locator("details")
      .filter({
        has: page.locator("summary", { hasText: /^#1 · Shared E2E Backend/ }),
      })
      .last();
    await captured.locator("summary").first().click();
    const message = captured.locator("textarea[readonly]").first();
    await message.evaluate((element: HTMLTextAreaElement) => {
      element.focus();
      element.select();
      element.dispatchEvent(new Event("select", { bubbles: true }));
    });
    await captured
      .getByRole("button", {
        name: "Create rule from selected text",
        exact: true,
      })
      .click();
    await expect(
      page.getByLabel("Required phrases (one per line)"),
    ).toHaveValue(PHRASE_A);
    await expect(
      captured.getByText(
        /Preview with current rules: Matched module: Rule Owner A/,
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Edit Module", exact: true })
      .last()
      .click();
    await invoke(page, "weather");
    expect(requests.at(-1)?.model).toBe("gpt-4o-mini");
    await editOwner(page);
    await expect(
      page.getByLabel("Required phrases (one per line)"),
    ).toHaveValue(PHRASE_A);
    await page
      .getByRole("button", { name: "Clear recent requests", exact: true })
      .click();
    await expect(page.locator("textarea[readonly]")).toHaveCount(0);
    expect(requests).toHaveLength(2);
    // Persist through the real SQLite stores, then verify a fresh app instance.
    await page.evaluate(async () => {
      const load = (path: string) => import(/* @vite-ignore */ path);
      const { moduleStore } = await load(
        "/src/ts/stores/domain/moduleStore.svelte.ts",
      );
      const { settingsStore } = await load(
        "/src/ts/stores/domain/settingsStore.svelte.ts",
      );
      const { presetStore } = await load(
        "/src/ts/stores/domain/presetStore.svelte.ts",
      );
      const { characterStore } = await load(
        "/src/ts/stores/domain/characterStore.svelte.ts",
      );
      await moduleStore.flush();
      await settingsStore.flush();
      await presetStore.flush();
      await characterStore.flush();
    });
    await boot(page);
    await editOwner(page);
    await expect(
      page.getByLabel("Required phrases (one per line)"),
    ).toHaveValue(PHRASE_A);
    await expect(page.locator("textarea[readonly]")).toHaveCount(0);
    await page.evaluate(async () => {
      const path = "/src/ts/stores/domain/characterStore.svelte.ts";
      const { characterStore } = await import(/* @vite-ignore */ path);
      characterStore.select(
        characterStore.characters.findIndex(
          (char: any) => char.name === "Request Rule E2E",
        ),
      );
    });
    await invoke(page, "weather");
    expect(requests.at(-1)?.model).toBe("gpt-4o-mini");
    expect(requests).toHaveLength(3);
  });
});
