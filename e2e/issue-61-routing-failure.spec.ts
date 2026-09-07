import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Reproduction E2E tests for GitHub Issue #61:
 * "최근 업데이트된 버전으로 확인해본 결과 규칙을 추가했음에도 라우팅이 되지 않습니다. #76"
 *
 * Demonstrates why users following the UI rule editor in PR #76 fail to route
 * auxiliary requests made by shared backend modules like Lightboard (라이트보드).
 */
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

async function seed(page: Page) {
  await page.evaluate(
    async ({ OWNER_A, OWNER_B, BACKEND, PHRASE_A, PHRASE_B }) => {
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
      const charMap: Record<string, string> = {
        "<": "\\u003C",
        ">": "\\u003E",
        "/": "\\u002F",
        "\\": "\\\\",
        "\b": "\\b",
        "\f": "\\f",
        "\n": "\\n",
        "\r": "\\r",
        "\t": "\\t",
        "\0": "\\0",
        "\u2028": "\\u2028",
        "\u2029": "\\u2029",
      };
      const escapeUnsafeChars = (str: string) =>
        str.replace(/[<>\/\\\b\f\n\r\t\0\u2028\u2029]/g, (x) => charMap[x]);
      const lore = (identifier: string, phrase: string) => ({
        key: "",
        secondkey: "",
        comment: `${identifier}.code`,
        insertorder: 0,
        mode: "normal",
        alwaysActive: false,
        selective: false,
        content: `return function() return {{role="user", content=${escapeUnsafeChars(JSON.stringify(phrase))}}} end`,
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
          subModelRequestRules: [],
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
      char.name = "Issue 61 Reproduction";
      characterStore.select(characterStore.add(char));
    },
    { OWNER_A, OWNER_B, BACKEND, PHRASE_A, PHRASE_B },
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

test.describe("Issue #61 routing failure reproductions", () => {
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
    await seed(page);
  });

  test("verifies fix for #61 case 1: multi-line alternative keywords in UI textarea route successfully with default 'any' matching", async ({
    page,
  }) => {
    await editOwner(page);

    // User clicks "Add rule"
    await page.getByRole("button", { name: "Add rule", exact: true }).click();

    // User specifies multiple candidate trigger phrases/identifiers (one per line)
    // as was common practice in Yumi provider for Lightboard modules:
    const candidatePhrases = [
      PHRASE_A,
      "<lb-weather>",
      "[날씨 예보]",
    ].join("\n");

    const phrasesTextarea = page.getByLabel("Required phrases (one per line)");
    await phrasesTextarea.fill(candidatePhrases);

    // Save module
    await page
      .getByRole("button", { name: "Edit Module", exact: true })
      .last()
      .click();

    // Trigger the backend Lua trigger which invokes axLLM with PHRASE_A
    await invoke(page, "weather");

    // With fix: routing SUCCEEDS to Rule Owner A's subModel (gpt-4o-mini)
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe("gpt-4o-mini");

    // Verify in UI that the decision was 'matched'
    await editOwner(page);
    await page.getByText("Recent request decisions", { exact: true }).click();
    await expect(
      page
        .getByText(/Matched module: Rule Owner A|일치한 모듈: Rule Owner A/)
        .first(),
    ).toBeVisible();
  });

  test("verifies fix for #61 case 2: dropdown prevents self-selection, and legacy self-sourceModuleId is forgiven", async ({
    page,
  }) => {
    await editOwner(page);
    await page.getByRole("button", { name: "Add rule", exact: true }).click();

    // Verify dropdown does not contain current module (preventing user confusion)
    const sourceSelect = page.getByLabel("Calling module");
    const options = await sourceSelect.locator("option").allTextContents();
    expect(options).not.toContain("Rule Owner A");
    expect(options).toContain("Rule Owner B");
    expect(options).toContain("Shared E2E Backend");

    // Simulate a legacy rule where user had set sourceModuleId to the module's own ID
    await page.evaluate(
      async ({ OWNER_A, PHRASE_A }) => {
        const path = "/src/ts/stores/domain/moduleStore.svelte.ts";
        const { moduleStore } = await import(/* @vite-ignore */ path);
        const owner = moduleStore.modules.find((m: any) => m.id === OWNER_A);
        owner.subModelRequestRules = [
          {
            enabled: true,
            phrases: [PHRASE_A],
            sourceModuleId: OWNER_A, // mistakenly set to self
          },
        ];
      },
      { OWNER_A, PHRASE_A },
    );

    // Trigger backend Lua trigger
    await invoke(page, "weather");

    // With fix: the self-source is forgiven and routed to gpt-4o-mini
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe("gpt-4o-mini");
  });

  test("verifies fix for #61 case 3: phrases across multiple messages or in either message route successfully", async ({
    page,
  }) => {
    // Reconfigure backend lorebook to generate Lightboard multi-message prompt
    await page.evaluate(
      async ({ OWNER_A, PHRASE_A }) => {
        const path = "/src/ts/stores/domain/moduleStore.svelte.ts";
        const { moduleStore } = await import(/* @vite-ignore */ path);
        const owner = moduleStore.modules.find((m: any) => m.id === OWNER_A);
        owner.lorebook = [
          {
            key: "",
            secondkey: "",
            comment: "weather.code",
            insertorder: 0,
            mode: "normal",
            alwaysActive: false,
            selective: false,
            content: `return function() return {
              { role = "system", content = "Lightboard subsystem header: <lb-weather>" },
              { role = "user", content = "${PHRASE_A}" }
            } end`,
          },
        ];
        owner.subModelRequestRules = [
          {
            enabled: true,
            phrases: ["<lb-weather>", PHRASE_A],
          },
        ];
      },
      { OWNER_A, PHRASE_A },
    );

    // Backend invokes request containing both messages
    await invoke(page, "weather");

    // With fix: default "any" mode matches either phrase and routes successfully
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe("gpt-4o-mini");
  });

  test("verifies fix for #61 case 4: more specific matched phrase wins over generic prefix match instead of dropping to backend", async ({
    page,
  }) => {
    await page.evaluate(
      async ({ OWNER_A, PHRASE_A, OWNER_B }) => {
        const path = "/src/ts/stores/domain/moduleStore.svelte.ts";
        const { moduleStore } = await import(/* @vite-ignore */ path);
        // Owner A matches full specific phrase
        moduleStore.modules
          .find((m: any) => m.id === OWNER_A)
          .subModelRequestRules.push({
            enabled: true,
            phrases: [PHRASE_A],
          });
        // Owner B has a broader prefix rule
        moduleStore.modules
          .find((m: any) => m.id === OWNER_B)
          .subModelRequestRules.push({
            enabled: true,
            phrases: ["Return the unique"],
          });
      },
      { OWNER_A, PHRASE_A, OWNER_B },
    );

    await invoke(page, "weather");

    // With fix: Owner A's longer match score wins over Owner B's generic prefix
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe("gpt-4o-mini");

    await editOwner(page);
    await page.getByText("Recent request decisions", { exact: true }).click();
    await expect(
      page
        .getByText(/Matched module: Rule Owner A|일치한 모듈: Rule Owner A/)
        .first(),
    ).toBeVisible();
  });
});

